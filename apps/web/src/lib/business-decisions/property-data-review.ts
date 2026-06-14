import {
  getInternalUserNotification,
  getOperationalCase,
  insertOperationalCaseEvent,
  resolveInternalNotificationWithReminders,
  updateOperationalCase,
  type DbClient,
} from "@agents/db";
import { classifyOperationalConversationMessage } from "@/lib/operational-cases/operational-conversation-classifier";

function parsePropertyDataReviewCorrection(text: string) {
  const normalized = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
  const patch: Record<string, unknown> = {};
  if (/\boperacion\b/.test(normalized) && /\bventa\b/.test(normalized)) {
    patch.operation_type = "Venta";
  } else if (/\boperacion\b/.test(normalized) && /\brenta\b/.test(normalized)) {
    patch.operation_type = "Renta";
  }
  if (/\btipo\b/.test(normalized) && /\bterreno\b/.test(normalized)) {
    patch.property_type = "Terreno";
  }
  const zoneMatch = text.match(/zona\s*(?:es|:)\s*([^\n.]+)/i);
  if (zoneMatch?.[1]?.trim()) {
    patch.property_zone = zoneMatch[1].trim();
  }
  return patch;
}

function mergeReviewCorrectionPatch(
  deterministicPatch: Record<string, unknown>,
  llmPatch: Record<string, unknown> | undefined
) {
  return {
    ...(llmPatch ?? {}),
    ...deterministicPatch,
  };
}

function isPropertyDataReviewCase(opCase: {
  status: string;
  current_step: string | null;
}) {
  return (
    opCase.status === "waiting_internal" &&
    (opCase.current_step === "documents_received" ||
      opCase.current_step === "property_data_review")
  );
}

function isSettingsTestCase(context: Record<string, unknown>) {
  return (
    context.created_from === "case_type_settings_test" ||
    context.test_mode === true
  );
}

function hasCorrectionSignals(text: string) {
  const normalized = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  return (
    /\bcorrig|correccion|ajust|cambia|modifica|actualiza|faltan|falta\b/.test(
      normalized
    ) ||
    /\bzona\s*(?:es|:)\b/i.test(text) ||
    /\boperacion\b/i.test(text) ||
    /\btipo\b/i.test(text)
  );
}

export async function handlePropertyDataReviewDecision(
  db: DbClient,
  params: {
    userId: string;
    notificationId: string;
    text: string;
  }
) {
  const notification = await getInternalUserNotification(db, params.notificationId);
  if (!notification || notification.user_id !== params.userId) {
    return { ok: false, status: "not_found", message: "No encontré el pendiente." };
  }
  if (notification.kind !== "property_data_review") {
    return {
      ok: false,
      status: "wrong_kind",
      message: "Este pendiente no es de revisión de datos de propiedad.",
    };
  }
  if (!notification.case_id) {
    return {
      ok: false,
      status: "missing_case",
      message: "El pendiente no está asociado a un caso.",
    };
  }

  const opCase = await getOperationalCase(db, notification.case_id);
  if (!opCase || opCase.user_id !== params.userId) {
    return { ok: false, status: "case_not_found", message: "No encontré el caso." };
  }
  if (!isPropertyDataReviewCase(opCase)) {
    return {
      ok: false,
      status: "wrong_stage",
      message: "El caso ya no está esperando revisión de datos.",
    };
  }

  const text = params.text.trim();
  if (!text) {
    return { ok: false, status: "missing_text", message: "Escribe una respuesta." };
  }

  const llmReview = await classifyOperationalConversationMessage({
    message: text,
    stage: "property_data_review",
    caseSummary: [
      opCase.context_jsonb?.property_title,
      opCase.context_jsonb?.property_zone,
      opCase.context_jsonb?.operation_type,
      opCase.context_jsonb?.property_type,
    ]
      .filter((value) => typeof value === "string" && value.trim())
      .join(" · "),
  });

  const correctionPatch = mergeReviewCorrectionPatch(
    parsePropertyDataReviewCorrection(text),
    llmReview?.intent === "review_correction" ? llmReview.patch : undefined
  );
  const hasPatch = Object.keys(correctionPatch).length > 0;
  const context = (opCase.context_jsonb ?? {}) as Record<string, unknown>;
  const settingsTestCase = isSettingsTestCase(context);

  if (!hasPatch && llmReview?.intent !== "confirm_review" && hasCorrectionSignals(text)) {
    return {
      ok: false,
      status: "unclear_correction",
      message:
        "Detecté intención de corrección, pero no pude extraer campos claros. Especifica, por ejemplo: «Tipo: Terreno» o «Operación: Venta».",
    };
  }

  const caseWithPatch = hasPatch
    ? await updateOperationalCase(db, opCase.id, opCase.version, {
        context: {
          ...context,
          ...correctionPatch,
          property_data_review_corrections: [
            ...(((context.property_data_review_corrections as unknown[]) ?? []) as unknown[]),
            {
              text,
              source: "web_pending_inbox",
              received_at: new Date().toISOString(),
              patch: correctionPatch,
            },
          ],
        },
      })
    : opCase;
  if (!caseWithPatch) {
    return { ok: false, status: "version_conflict", message: "El caso cambió; intenta de nuevo." };
  }

  await insertOperationalCaseEvent(db, {
    caseId: caseWithPatch.id,
    eventType: "human_decision",
    actor: "user",
    payload: {
      kind: "property_data_review_response",
      source: "web_pending_inbox",
      notification_id: notification.id,
      text,
      correction_patch: correctionPatch,
    },
  });

  await resolveInternalNotificationWithReminders(db, {
    id: notification.id,
    userId: params.userId,
    status: "actioned",
  });

  const reviewAdvanceNextActionAt = settingsTestCase ? null : new Date().toISOString();
  const advancedCase = await updateOperationalCase(
    db,
    caseWithPatch.id,
    caseWithPatch.version,
    {
      status: settingsTestCase ? "paused" : "active",
      currentStep: "comparables_in_progress",
      nextActionAt: reviewAdvanceNextActionAt,
      context: {
        ...(caseWithPatch.context_jsonb as Record<string, unknown>),
        property_data_review_confirmed_at: new Date().toISOString(),
        property_data_review_notification_id: notification.id,
      },
    }
  );
  if (!advancedCase) {
    return { ok: false, status: "version_conflict", message: "El caso cambió; intenta de nuevo." };
  }

  await insertOperationalCaseEvent(db, {
    caseId: advancedCase.id,
    eventType: "state_changed",
    actor: "system",
    payload: {
      kind: "property_data_review_confirmed",
      source: "web_pending_inbox",
      notification_id: notification.id,
      from: {
        current_step: caseWithPatch.current_step,
        status: caseWithPatch.status,
      },
      to: {
        current_step: advancedCase.current_step,
        status: advancedCase.status,
      },
    },
  });

  return {
    ok: true,
    status: hasPatch ? "corrected_and_confirmed" : "confirmed",
    message: hasPatch
      ? "Correcciones guardadas. El caso avanzó a comparables."
      : "Datos confirmados. El caso avanzó a comparables.",
    correctionPatch,
  };
}
