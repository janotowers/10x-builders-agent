/**
 * Decisión humana sobre una aprobación suspendida (Slice 3.3-2).
 *
 * El motor de impacto SUSPENDE mecánicamente cuando la base de evidencia
 * cambia; retirar o confirmar la aprobación es un acto de negocio humano y
 * pasa por aquí:
 *   - RE-APROBAR ⇒ fila nueva `approved` anclada a la evidencia VIGENTE,
 *     que reemplaza (superseded_by) la suspendida. Nunca se reactiva la fila
 *     vieja: la historia es por inserción.
 *   - REVOCAR ⇒ fila nueva `revoked` que reemplaza la suspendida.
 *
 * El parser exige verbos explícitos (re-aprobar / revocar): un "aprobar" a
 * secas pertenece al gate de price_approval y no debe colisionar.
 */
import {
  getCaseApprovalById,
  getInternalUserNotification,
  getOperationalCase,
  insertOperationalCaseEvent,
  resolveInternalNotificationWithReminders,
  type DbClient,
} from "@agents/db";
import { grantCaseApprovalWithEvidence } from "@agents/agent";
import type { BusinessDecisionHandlerInput, BusinessDecisionResult } from "./registry";

export type ApprovalSuspendedIntent = "reapprove" | "revoke" | "unclear";

export function parseApprovalSuspendedDecision(text: string): {
  intent: ApprovalSuspendedIntent;
  reason?: string;
} {
  const normalized = text
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  if (!normalized) return { intent: "unclear", reason: "Respuesta vacía." };
  if (
    /^(re-?aprobar|re-?apruebo|confirmar (la )?aprobacion|aprobar de nuevo|reconfirmar)(?=\s|$|[^a-z0-9])/.test(
      normalized
    )
  ) {
    return { intent: "reapprove" };
  }
  if (
    /^(revocar|revoco|retirar (la )?aprobacion)(?=\s|$|[^a-z0-9])/.test(
      normalized
    )
  ) {
    return { intent: "revoke" };
  }
  return {
    intent: "unclear",
    reason:
      "No entendí la decisión. Responde RE-APROBAR para confirmar la aprobación con la base nueva, o REVOCAR para retirarla.",
  };
}

export async function handleApprovalSuspendedDecision(
  db: DbClient,
  params: BusinessDecisionHandlerInput
): Promise<BusinessDecisionResult> {
  const notification = await getInternalUserNotification(db, params.notificationId);
  if (!notification || notification.user_id !== params.userId) {
    return { ok: false, status: "not_found", message: "No encontré el pendiente." };
  }
  if (notification.kind !== "approval_suspended") {
    return {
      ok: false,
      status: "wrong_kind",
      message: "Este pendiente no es una aprobación suspendida.",
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
  const parsed = parseApprovalSuspendedDecision(params.text);
  if (parsed.intent === "unclear") {
    return { ok: false, status: "unclear", message: parsed.reason };
  }

  const metadata =
    notification.metadata_jsonb && typeof notification.metadata_jsonb === "object"
      ? (notification.metadata_jsonb as Record<string, unknown>)
      : {};
  const approvalId =
    typeof metadata.approval_id === "string" ? metadata.approval_id : null;
  const approval = approvalId
    ? await getCaseApprovalById(db, params.userId, approvalId)
    : null;
  if (!approval) {
    return {
      ok: false,
      status: "approval_not_found",
      message: "No encontré la aprobación suspendida.",
    };
  }
  if (approval.superseded_by) {
    await resolveInternalNotificationWithReminders(db, {
      id: notification.id,
      userId: params.userId,
      status: "dismissed",
    });
    return {
      ok: false,
      status: "already_superseded",
      message: "Esa aprobación ya fue reemplazada por una decisión más reciente.",
    };
  }
  if (approval.decision !== "suspended") {
    return {
      ok: false,
      status: "not_suspended",
      message: `La aprobación ya no está en pausa (estado actual: ${approval.decision}).`,
    };
  }

  const decision = parsed.intent === "reapprove" ? "approved" : "revoked";
  // Fila nueva anclada a la evidencia VIGENTE, reemplazando la suspendida.
  // grantCaseApprovalWithEvidence reemplaza la última fila no-reemplazada de
  // la clase — que es exactamente la suspendida.
  const granted = await grantCaseApprovalWithEvidence(db, {
    userId: params.userId,
    opCase,
    approvalKind: approval.approval_kind,
    decision,
    decidedBy: params.userId,
    rationale: params.text,
  });
  if (!granted) {
    return {
      ok: false,
      status: "not_v2_case",
      message:
        "Este caso no está en el plano de impacto v2; no hay aprobación con evidencia que actualizar.",
    };
  }

  await insertOperationalCaseEvent(db, {
    caseId: opCase.id,
    eventType: "human_decision",
    actor: "user",
    stepKey: opCase.current_step ?? undefined,
    payload: {
      kind: decision === "approved" ? "approval_regranted" : "approval_revoked",
      approval_kind: approval.approval_kind,
      suspended_approval_id: approval.id,
      new_approval_id: granted.approval.id,
      evidence_hash: granted.approval.evidence_hash,
      rationale: params.text,
    },
  });
  await resolveInternalNotificationWithReminders(db, {
    id: notification.id,
    userId: params.userId,
    status: "actioned",
  });

  return {
    ok: true,
    status: decision === "approved" ? "reapproved" : "revoked",
    message:
      decision === "approved"
        ? `Aprobación de ${approval.approval_kind === "price" ? "precio" : approval.approval_kind} confirmada con la información actualizada.`
        : `Aprobación de ${approval.approval_kind === "price" ? "precio" : approval.approval_kind} revocada. El caso requerirá una nueva aprobación.`,
    case_id: opCase.id,
    approval_id: granted.approval.id,
  };
}
