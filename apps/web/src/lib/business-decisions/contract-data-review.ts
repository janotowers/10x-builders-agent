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

export type ParsedContractDataReviewReply = {
  intent: "provide_data" | "unclear";
  owner_email?: string;
  reason?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export function extractOwnerEmailFromContractDataReply(text: string): string | null {
  const match = text.match(/[^\s@]+@[^\s@]+\.[^\s@]+/);
  if (!match) return null;
  const email = match[0].trim();
  return looksLikeEmail(email) ? email : null;
}

export function parseContractDataReviewReply(text: string): ParsedContractDataReviewReply {
  const trimmed = text.trim();
  if (!trimmed) {
    return { intent: "unclear", reason: "Escribe el correo del comitente para continuar." };
  }
  const ownerEmail = extractOwnerEmailFromContractDataReply(trimmed);
  if (!ownerEmail) {
    return {
      intent: "unclear",
      reason:
        "No encontré un correo válido. Ejemplo: maria.castaneda@example.com",
    };
  }
  return { intent: "provide_data", owner_email: ownerEmail };
}

function missingRequiredFieldsFromNotification(
  metadata: Record<string, unknown> | null | undefined
): string[] {
  const raw = metadata?.missing_required_fields;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (field): field is string => typeof field === "string" && field.trim().length > 0
  );
}

export async function handleContractDataReviewDecision(
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
  if (notification.kind !== "contract_data_review") {
    return {
      ok: false,
      status: "wrong_kind",
      message: "Este pendiente no es de datos contractuales faltantes.",
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

  const parsed = parseContractDataReviewReply(params.text);
  if (parsed.intent === "unclear") {
    return { ok: false, status: "unclear", message: parsed.reason };
  }

  const metadata = isRecord(notification.metadata_jsonb)
    ? notification.metadata_jsonb
    : {};
  const missingRequiredFields = missingRequiredFieldsFromNotification(metadata);
  const ownerEmail = parsed.owner_email!;
  if (missingRequiredFields.includes("owner_email") || missingRequiredFields.length === 0) {
    // owner_email is the primary HITL field today; allow capture even if metadata is empty.
  }

  const context = (opCase.context_jsonb ?? {}) as Record<string, unknown>;
  const propertyData = isRecord(context.property_data)
    ? { ...context.property_data }
    : {};

  const updatedCase = await updateOperationalCase(db, opCase.id, opCase.version, {
    nextActionAt: new Date().toISOString(),
    context: {
      ...context,
      owner_email: ownerEmail,
      property_data: {
        ...propertyData,
        owner_email: ownerEmail,
      },
      contract_data_review: {
        status: "captured",
        captured_at: new Date().toISOString(),
        captured_fields: { owner_email: ownerEmail },
        missing_required_fields: missingRequiredFields,
      },
    },
  });
  if (!updatedCase) {
    return { ok: false, status: "version_conflict", message: "El caso cambió; intenta de nuevo." };
  }

  await insertOperationalCaseEvent(db, {
    caseId: updatedCase.id,
    eventType: "human_decision",
    actor: "user",
    stepKey: "contract_pending",
    payload: {
      kind: "contract_data_review_response",
      source: "contract_data_review",
      notification_id: notification.id,
      owner_email: ownerEmail,
      missing_required_fields: missingRequiredFields,
    },
  });
  await insertOperationalCaseEvent(db, {
    caseId: updatedCase.id,
    eventType: "state_changed",
    actor: "system",
    stepKey: "contract_pending",
    payload: {
      kind: "contract_data_captured",
      source: "contract_data_review",
      owner_email: ownerEmail,
    },
  });

  await resolveInternalNotificationWithReminders(db, {
    id: notification.id,
    userId: params.userId,
    status: "actioned",
  });

  if (isControlledE2EOperationalCase(updatedCase)) {
    void runSettingsTestCaseAgentTick(db, updatedCase, updatedCase.user_id, {
      source: "contract_data_review_captured",
    }).catch((tickError) => {
      console.error("[contract-data-review] e2e tick failed:", tickError);
    });
  }

  return {
    ok: true,
    status: "captured",
    message:
      "Correo del comitente registrado. Reintentaré generar el borrador del contrato.",
    owner_email: ownerEmail,
  };
}
