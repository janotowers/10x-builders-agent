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

type ParsedTitularidadReviewReply = {
  intent: "approve_override" | "request_more_docs" | "unclear";
  reason?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseTitularidadReviewDecision(
  text: string
): ParsedTitularidadReviewReply {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return {
      intent: "unclear",
      reason:
        "Responde «aprobar titularidad» para continuar o «pedir documentos» para solicitar evidencia adicional.",
    };
  }
  if (
    /\b(aprobar titularidad|aprobada titularidad|apruebo titularidad|ok titularidad|continuar contrato|procede contrato|adelante contrato)\b/.test(
      normalized
    )
  ) {
    return { intent: "approve_override" };
  }
  if (
    /\b(pedir documentos|solicitar documentos|subir documento|subir evidencia|revisar titularidad)\b/.test(
      normalized
    )
  ) {
    return { intent: "request_more_docs" };
  }
  return {
    intent: "unclear",
    reason:
      "No entendí la decisión. Responde «aprobar titularidad» para continuar o «pedir documentos» para mantener el bloqueo.",
  };
}

export async function handleTitularidadReviewDecision(
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
  if (notification.kind !== "titularidad_review") {
    return {
      ok: false,
      status: "wrong_kind",
      message: "Este pendiente no corresponde a revisión de titularidad.",
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
  if (opCase.current_step !== "contract_pending") {
    return {
      ok: false,
      status: "wrong_stage",
      message: "El caso ya no está en preparación de contrato.",
    };
  }

  const parsed = parseTitularidadReviewDecision(params.text);
  if (parsed.intent === "unclear") {
    return { ok: false, status: "unclear", message: parsed.reason };
  }

  if (parsed.intent === "request_more_docs") {
    return {
      ok: false,
      status: "needs_more_docs",
      message:
        "Entendido. Mantengo el bloqueo de titularidad. Sube evidencia adicional o corrige los datos antes de continuar.",
    };
  }

  const context = isRecord(opCase.context_jsonb)
    ? (opCase.context_jsonb as Record<string, unknown>)
    : {};
  const titularidad = isRecord(context.titularidad)
    ? { ...context.titularidad }
    : {};
  const override = isRecord(titularidad.override)
    ? { ...titularidad.override }
    : {};
  const nowIso = new Date().toISOString();

  const updated = await updateOperationalCase(db, opCase.id, opCase.version, {
    nextActionAt: nowIso,
    context: {
      ...context,
      titularidad: {
        ...titularidad,
        override: {
          ...override,
          approved: true,
          approved_at: nowIso,
          approved_by: params.userId,
          source: "titularidad_review",
          note: params.text.trim(),
        },
      },
    },
  });
  if (!updated) {
    return {
      ok: false,
      status: "version_conflict",
      message: "El caso cambió; intenta de nuevo.",
    };
  }

  await insertOperationalCaseEvent(db, {
    caseId: updated.id,
    eventType: "human_decision",
    actor: "user",
    stepKey: "contract_pending",
    payload: {
      kind: "titularidad_override_approved",
      source: "titularidad_review",
      notification_id: notification.id,
      note: params.text.trim() || "Override de titularidad aprobado por asesor.",
    },
  });

  await resolveInternalNotificationWithReminders(db, {
    id: notification.id,
    userId: params.userId,
    status: "actioned",
  });

  if (isControlledE2EOperationalCase(updated)) {
    void runSettingsTestCaseAgentTick(db, updated, updated.user_id, {
      source: "titularidad_override_approved",
    }).catch((tickError) => {
      console.error("[titularidad-review] e2e tick failed:", tickError);
    });
  }

  return {
    ok: true,
    status: "approved",
    message:
      "Titularidad aprobada por override. Generaré el contrato con esta autorización.",
  };
}
