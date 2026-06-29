import {
  getInternalUserNotification,
  getOperationalCase,
  insertOperationalCaseEvent,
  resolveInternalNotificationWithReminders,
  updateOperationalCase,
  type DbClient,
} from "@agents/db";
import { isControlledE2EOperationalCase } from "@agents/types";
import { runSettingsTestCaseAgentTick } from "@/lib/operational-cases/run-settings-test-case-tick";
import { classifyOperationalConversationMessage } from "@/lib/operational-cases/operational-conversation-classifier";
import { parseOwnerCharacteristics } from "@/lib/operational-cases/parse-owner-characteristics";

const PROPERTY_DATA_KEYS = new Set([
  "operation",
  "property_type",
  "area_total_m2",
  "area_construida_m2",
  "floors",
  "bedrooms",
  "bathrooms",
  "half_bathrooms",
  "parking_spots",
  "integral_kitchen",
  "floor_number",
  "has_elevator",
  "amenities",
  "land_context",
  "warehouse_area_m2",
  "warehouse_height_m",
  "office_area_m2",
  "kva",
  "has_transformer",
  "notes",
]);

function parsePropertyDataReviewCorrection(text: string) {
  const normalized = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
  const patch: Record<string, unknown> = {};
  const propertyDataPatch = parseOwnerCharacteristics(text);
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
  return {
    contextPatch: patch,
    propertyDataPatch:
      propertyDataPatch && typeof propertyDataPatch === "object"
        ? (propertyDataPatch as Record<string, unknown>)
        : {},
  };
}

function firstPositiveNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value.replace(/,/g, "."));
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

export function extractManualBuiltAreaM2FromTextForTest(text: string): number | null {
  const withUnits = Array.from(
    text.matchAll(/(\d{1,4}(?:[.,]\d{1,2})?)\s*(?:m2|m²|metros?\s*cuadrados?)/gi)
  );
  const candidates = withUnits.length > 0 ? withUnits : Array.from(text.matchAll(/\d{1,4}(?:[.,]\d{1,2})?/g));
  for (const match of candidates) {
    const value = firstPositiveNumber(match[1] ?? match[0]);
    if (value != null) return value;
  }
  return null;
}

function mergeReviewCorrectionPatch(
  deterministicPatch: {
    contextPatch: Record<string, unknown>;
    propertyDataPatch: Record<string, unknown>;
  },
  llmPatch: Record<string, unknown> | undefined
) {
  const mergedContextPatch = {
    ...(llmPatch ?? {}),
    ...deterministicPatch.contextPatch,
  };
  const mergedPropertyDataPatch: Record<string, unknown> = {
    ...deterministicPatch.propertyDataPatch,
  };
  for (const [key, value] of Object.entries(llmPatch ?? {})) {
    if (PROPERTY_DATA_KEYS.has(key)) mergedPropertyDataPatch[key] = value;
  }
  return {
    contextPatch: mergedContextPatch,
    propertyDataPatch: mergedPropertyDataPatch,
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
  if (
    notification.kind !== "property_data_review" &&
    notification.kind !== "property_data_quality_review"
  ) {
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
    const advancedBeyondReview =
      opCase.current_step === "comparables_in_progress" ||
      opCase.current_step === "price_proposal_pending" ||
      opCase.current_step === "contract_pending" ||
      opCase.current_step === "photos_scheduled" ||
      opCase.current_step === "package_ready" ||
      opCase.current_step === "completed";
    if (advancedBeyondReview) {
      return {
        ok: true,
        status: "already_processed",
        message: "Ya registré la confirmación; estoy avanzando con comparables.",
      };
    }
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
  const isQualityReview = notification.kind === "property_data_quality_review";

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
  if (isQualityReview) {
    const parsedManualArea =
      firstPositiveNumber(correctionPatch.propertyDataPatch.area_construida_m2) ??
      extractManualBuiltAreaM2FromTextForTest(text);
    if (parsedManualArea == null) {
      return {
        ok: false,
        status: "missing_area_value",
        message:
          "Para continuar necesito el dato de superficie construida en m². Ejemplo: «146 m2».",
      };
    }
    correctionPatch.propertyDataPatch.area_construida_m2 = parsedManualArea;
    correctionPatch.propertyDataPatch.area_construida_m2_source =
      "human_confirmed_predial_decimal_review";
    correctionPatch.propertyDataPatch.surface_quality = {
      area_construida_m2: {
        status: "human_confirmed",
        confirmed_at: new Date().toISOString(),
        confirmed_via: "property_data_quality_review",
      },
    };
    correctionPatch.contextPatch.area_construida_m2 = parsedManualArea;
  }
  const hasPatch =
    Object.keys(correctionPatch.contextPatch).length > 0 ||
    Object.keys(correctionPatch.propertyDataPatch).length > 0;
  const context = (opCase.context_jsonb ?? {}) as Record<string, unknown>;
  const settingsTestCase = isSettingsTestCase(context);

  if (!hasPatch && llmReview?.intent !== "confirm_review" && hasCorrectionSignals(text)) {
    return {
      ok: false,
      status: "unclear_correction",
      message:
        "Detecté intención de corrección, pero no pude extraer campos claros. Especifica, por ejemplo: «Tipo: Terreno», «Operación: Venta» o «Recámaras: 3».",
    };
  }

  const currentPropertyData =
    context.property_data &&
    typeof context.property_data === "object" &&
    !Array.isArray(context.property_data)
      ? (context.property_data as Record<string, unknown>)
      : {};
  if (isQualityReview) {
    const existingSurfaceQuality =
      currentPropertyData.surface_quality &&
      typeof currentPropertyData.surface_quality === "object" &&
      !Array.isArray(currentPropertyData.surface_quality)
        ? (currentPropertyData.surface_quality as Record<string, unknown>)
        : {};
    correctionPatch.propertyDataPatch.surface_quality = {
      ...existingSurfaceQuality,
      area_construida_m2: {
        status: "human_confirmed",
        confirmed_at: new Date().toISOString(),
        confirmed_via: "property_data_quality_review",
      },
    };
  }
  const caseWithPatch = hasPatch
    ? await updateOperationalCase(db, opCase.id, opCase.version, {
        context: {
          ...context,
          ...correctionPatch.contextPatch,
          property_data: {
            ...currentPropertyData,
            ...correctionPatch.propertyDataPatch,
          },
          property_data_review_corrections: [
            ...(((context.property_data_review_corrections as unknown[]) ?? []) as unknown[]),
            {
              text,
              source: "web_pending_inbox",
              received_at: new Date().toISOString(),
              patch: {
                context: correctionPatch.contextPatch,
                property_data: correctionPatch.propertyDataPatch,
              },
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
    stepKey: caseWithPatch.current_step ?? undefined,
    payload: {
      kind: "property_data_review_response",
      source: "web_pending_inbox",
      notification_id: notification.id,
      text,
      correction_patch: {
        context: correctionPatch.contextPatch,
        property_data: correctionPatch.propertyDataPatch,
      },
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
      status:
        settingsTestCase && !isControlledE2EOperationalCase(caseWithPatch)
          ? "paused"
          : "active",
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
    stepKey: caseWithPatch.current_step ?? "property_data_review",
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

  if (isControlledE2EOperationalCase(advancedCase)) {
    void runSettingsTestCaseAgentTick(db, advancedCase, advancedCase.user_id, {
      source: "property_data_review_confirmed",
    }).catch((tickError) => {
      console.error("[property-data-review] e2e tick failed:", tickError);
    });
  }

  return {
    ok: true,
    status: hasPatch ? "corrected_and_confirmed" : "confirmed",
    message: hasPatch
      ? "Correcciones guardadas. El caso avanzó a comparables."
      : "Datos confirmados. El caso avanzó a comparables.",
    correctionPatch: {
      context: correctionPatch.contextPatch,
      property_data: correctionPatch.propertyDataPatch,
    },
  };
}
