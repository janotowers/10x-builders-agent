import {
  getInternalUserNotification,
  getOperationalCase,
  insertOperationalCaseEvent,
  resolveInternalNotificationWithReminders,
  resolveUnreadInternalNotificationsByKindForCaseWithReminders,
  type DbClient,
} from "@agents/db";
import { advisedUpdateCase } from "../operational-cases/advised-case-update";
import {
  beginExternalContactLink,
  buildExternalContactDeepLink,
  buildExternalContactSetupMessage,
} from "../operational-cases/external-contact-link";
import { ensureDocumentsUploadRequestForCase } from "../operational-cases/ensure-documents-upload-request";
import { setCaseDocumentRequestTarget } from "../operational-cases/document-request-target";
import {
  hasOperationalCaseVerifiedExternalContact,
  isControlledE2EOperationalCase,
} from "@agents/types";
import { runSettingsTestCaseAgentTick } from "@/lib/operational-cases/run-settings-test-case-tick";
import { notifyUserRespectingActiveInternalChannel } from "@/lib/operational-cases/deliver-internal-case-follow-up";

type ParsedTitularidadReviewReply = {
  intent:
    | "continue_override"
    | "request_external_evidence"
    | "request_internal_docs"
    | "unclear";
  reason?: string;
  residual?: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeDecisionText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

export function parseTitularidadReviewDecision(
  text: string
): ParsedTitularidadReviewReply {
  const trimmed = text.trim();
  const normalized = normalizeDecisionText(trimmed);
  if (!normalized) {
    return {
      intent: "unclear",
      reason:
        "Elige: solicitar evidencia al propietario, subir/corregir documentos tú, o continuar bajo excepción (con motivo).",
    };
  }
  const residualAfterMatch = (match: RegExpMatchArray): string | null => {
    if (match.index == null) return null;
    const remainder =
      `${trimmed.slice(0, match.index)} ${trimmed.slice(match.index + match[0].length)}`;
    return remainder.trim() ? remainder : null;
  };

  const externalMatch = normalized.match(
    /\b(solicitar evidencia( al propietario)?|pedir evidencia( al propietario)?|evidencia al propietario|request_external_evidence|externo)\b/
  );
  if (externalMatch) {
    return {
      intent: "request_external_evidence",
      residual: residualAfterMatch(externalMatch),
    };
  }

  const internalMatch = normalized.match(
    /\b(yo subire(\/corrigire)? documentos|subir\/corregir documentos|request_internal_docs|pedir documentos|solicitar documentos|subir documento|subir evidencia|revisar titularidad|interno)\b/
  );
  if (internalMatch) {
    return {
      intent: "request_internal_docs",
      residual: residualAfterMatch(internalMatch),
    };
  }

  const overrideMatch = normalized.match(
    /\b(continuar bajo excepcion|continuar por excepcion|excepcion de titularidad|aprobar titularidad|aprobada titularidad|apruebo titularidad|ok titularidad|continuar contrato|procede contrato|adelante contrato|continue_override)\b/
  );
  if (overrideMatch) {
    return {
      intent: "continue_override",
      residual: residualAfterMatch(overrideMatch),
    };
  }

  return {
    intent: "unclear",
    reason:
      "No entendí la decisión. Elige solicitar evidencia al propietario, subir/corregir documentos tú, o continuar bajo excepción con un motivo claro.",
  };
}

function extractOverrideReason(params: {
  text: string;
  residual?: string | null;
}): string | null {
  // Preferir motivo tras ":" / "—" (robusto ante acentos/NFD en el residual).
  const afterSep = params.text.split(/[:—]\s*/).slice(1).join(" ").trim();
  if (afterSep.length >= 8) {
    const afterNorm = normalizeDecisionText(afterSep);
    if (
      !/^(continuar bajo excepcion|aprobar titularidad|continue_override)\b/.test(
        afterNorm
      )
    ) {
      return afterSep;
    }
  }
  const residual =
    typeof params.residual === "string" ? params.residual.trim() : "";
  if (residual.length >= 8) {
    return residual.replace(/^[:—\-]+\s*/, "").trim() || null;
  }
  return null;
}

function ownershipSignal(opCaseContext: Record<string, unknown>): {
  status: string | null;
  note: string | null;
  warning: string | null;
} {
  const titularidad = isRecord(opCaseContext.titularidad)
    ? opCaseContext.titularidad
    : {};
  const docs = isRecord(opCaseContext.document_fields)
    ? opCaseContext.document_fields
    : {};
  const status =
    (typeof titularidad.status === "string" && titularidad.status.trim()) ||
    (typeof docs.owner_consistency_status === "string" &&
      docs.owner_consistency_status.trim()) ||
    null;
  const note =
    (typeof titularidad.note === "string" && titularidad.note.trim()) ||
    (typeof docs.owner_consistency_note === "string" &&
      docs.owner_consistency_note.trim()) ||
    null;
  const warning =
    (typeof titularidad.warning === "string" && titularidad.warning.trim()) ||
    (typeof docs.owner_consistency_warning === "string" &&
      docs.owner_consistency_warning.trim()) ||
    null;
  return { status, note, warning };
}

export async function handleTitularidadReviewDecision(
  db: DbClient,
  params: {
    userId: string;
    notificationId: string;
    text: string;
    source?: "web" | "telegram";
    action?: string;
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

  const channel = params.source === "telegram" ? "telegram" : "web";
  const actionText =
    typeof params.action === "string" && params.action.trim()
      ? params.action.trim()
      : "";
  // Mapear action ids canónicos del contrato HITL a frases parseables.
  const textFromAction =
    actionText === "continue_override" || actionText === "approve"
      ? "continuar bajo excepcion"
      : actionText === "request_external_evidence"
        ? "solicitar evidencia al propietario"
        : actionText === "request_internal_docs" ||
            actionText === "request_documents"
          ? "yo subire documentos"
          : "";
  const decisionText =
    (typeof params.text === "string" && params.text.trim()) ||
    textFromAction ||
    "";

  const parsed = parseTitularidadReviewDecision(decisionText);
  if (parsed.intent === "unclear") {
    return { ok: false, status: "unclear", message: parsed.reason };
  }

  const context = isRecord(opCase.context_jsonb)
    ? (opCase.context_jsonb as Record<string, unknown>)
    : {};
  const signal = ownershipSignal(context);
  const nowIso = new Date().toISOString();

  if (parsed.intent === "request_internal_docs") {
    const docs = await ensureDocumentsUploadRequestForCase({
      db,
      opCase,
      source: `titularidad_review_${channel}`,
      channel,
      reason:
        signal.note ||
        signal.warning ||
        "Discrepancia de titularidad: se requieren documentos adicionales o corregidos.",
      forceInternalTarget: true,
    });
    await insertOperationalCaseEvent(db, {
      caseId: opCase.id,
      eventType: "human_decision",
      actor: "user",
      stepKey: "contract_pending",
      payload: {
        kind: "titularidad_request_internal_docs",
        source: "titularidad_review",
        channel,
        notification_id: notification.id,
        detected_status: signal.status,
        action_id: "request_internal_docs",
      },
    });
    // Mantener el HITL de titularidad abierto hasta resolver evidencia o excepción.
    return {
      ok: true,
      status: "needs_more_docs",
      case_id: docs.case.id,
      message: docs.message,
    };
  }

  if (parsed.intent === "request_external_evidence") {
    const hasExternal = hasOperationalCaseVerifiedExternalContact({
      externalContact: opCase.external_contact_jsonb,
      context,
    });

    if (!hasExternal) {
      const { updatedCase, token } = await beginExternalContactLink(db, opCase);
      const deepLink = await buildExternalContactDeepLink(token);
      const setupMessage = buildExternalContactSetupMessage({ deepLink });
      await notifyUserRespectingActiveInternalChannel(
        db,
        params.userId,
        {
          text: setupMessage,
          kind: "external_contact_link_setup",
          data: {
            case_id: updatedCase.id,
            source: `titularidad_review_${channel}`,
            skip_web_mirror: channel === "web",
          },
        },
        "high"
      );
      await insertOperationalCaseEvent(db, {
        caseId: updatedCase.id,
        eventType: "human_decision",
        actor: "user",
        stepKey: "contract_pending",
        payload: {
          kind: "titularidad_request_external_setup",
          source: "titularidad_review",
          channel,
          notification_id: notification.id,
          detected_status: signal.status,
          action_id: "request_external_evidence",
        },
      });
      return {
        ok: true,
        status: "external_contact_setup",
        case_id: updatedCase.id,
        message: setupMessage,
        external_contact_setup_token: token,
      };
    }

    let updatedCase = await setCaseDocumentRequestTarget({
      db,
      opCase,
      target: "external_contact",
      decidedBy: "user",
      source: `titularidad_review_${channel}`,
      reason: "titularidad_external_evidence",
    });
    updatedCase =
      (await advisedUpdateCase(db, updatedCase, updatedCase.version, {
        status: "waiting_external",
        nextActionAt: nowIso,
        context: {
          ...context,
          titularidad: {
            ...(isRecord(context.titularidad) ? context.titularidad : {}),
            remediation: {
              kind: "request_external_evidence",
              requested_at: nowIso,
              requested_by: params.userId,
              channel,
              notification_id: notification.id,
              detected_status: signal.status,
            },
          },
        },
      })) ?? updatedCase;

    await insertOperationalCaseEvent(db, {
      caseId: updatedCase.id,
      eventType: "human_decision",
      actor: "user",
      stepKey: "contract_pending",
      payload: {
        kind: "titularidad_request_external_evidence",
        source: "titularidad_review",
        channel,
        notification_id: notification.id,
        detected_status: signal.status,
        action_id: "request_external_evidence",
      },
    });

    if (isControlledE2EOperationalCase(updatedCase)) {
      void runSettingsTestCaseAgentTick(db, updatedCase, updatedCase.user_id, {
        source: "titularidad_request_external_evidence",
      }).catch((tickError) => {
        console.error("[titularidad-review] e2e external tick failed:", tickError);
      });
    } else {
      // Despertar cron/agente para que solicite evidencia al contacto.
      void advisedUpdateCase(db, updatedCase, updatedCase.version, {
        status: "active",
        nextActionAt: new Date().toISOString(),
      }).catch(() => undefined);
    }

    return {
      ok: true,
      status: "external_evidence_requested",
      case_id: updatedCase.id,
      message:
        "Listo. Pediré evidencia adicional al propietario/contacto vinculado y te aviso cuando responda.",
    };
  }

  // continue_override — siempre disponible; motivo obligatorio.
  const overrideReason =
    extractOverrideReason({ text: decisionText, residual: parsed.residual }) ||
    (typeof params.text === "string" &&
    params.text.trim().length >= 8 &&
    normalizeDecisionText(params.text) !== "continuar bajo excepcion" &&
    normalizeDecisionText(params.text) !== "aprobar titularidad"
      ? params.text.trim()
      : null);

  if (!overrideReason) {
    return {
      ok: false,
      status: "reason_required",
      message:
        "Para continuar bajo excepción indica un motivo concreto (qué revisaste y por qué autoras la excepción).",
    };
  }

  const titularidad = isRecord(context.titularidad)
    ? { ...context.titularidad }
    : {};
  const override = isRecord(titularidad.override)
    ? { ...titularidad.override }
    : {};

  const updated = await advisedUpdateCase(db, opCase, opCase.version, {
    status: "active",
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
          note: overrideReason,
          channel,
          notification_id: notification.id,
          detected_status: signal.status,
          detected_note: signal.note,
          detected_warning: signal.warning,
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
      note: overrideReason,
      channel,
      action_id: "continue_override",
      detected_status: signal.status,
    },
  });

  await resolveInternalNotificationWithReminders(db, {
    id: notification.id,
    userId: params.userId,
    status: "actioned",
  });
  // Paridad con comparables/price: cierra TODOS los unread del kind, no solo
  // el id reclamado. Un tick concurrente puede haber creado otro
  // titularidad_review tras el override y dejarlo zombie en el inbox.
  await resolveUnreadInternalNotificationsByKindForCaseWithReminders(db, {
    userId: params.userId,
    caseId: updated.id,
    kind: "titularidad_review",
    status: "actioned",
  }).catch(() => null);

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
    case_id: updated.id,
    message:
      "Excepción registrada. Generaré el contrato con esta autorización auditada.",
  };
}
