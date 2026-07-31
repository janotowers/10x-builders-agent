/**
 * Solicita al asesor interno que suba/corrija documentos (lote HITL).
 * Paridad con ensurePhotosUploadRequestForCase; reutilizable desde
 * titularidad_review y otros remediadores.
 */
import {
  getOperationalCase,
  insertOperationalCaseEvent,
  type DbClient,
} from "@agents/db";
import type { OperationalCase } from "@agents/types";
import { createAdvisedCaseUpdate } from "./advised-case-update";
import {
  buildDocumentChecklistLines,
  DOCUMENT_PRIVACY_LINE,
} from "./case-document-collection";
import { deliverInternalCaseFollowUp } from "./deliver-internal-case-follow-up";
import { DOCUMENTS_UPLOAD_REQUESTED_NOTIFICATION_KIND } from "./document-batch-completion";
import { setCaseDocumentRequestTarget } from "./document-request-target";

const advisedUpdate = createAdvisedCaseUpdate(
  "ensure_documents_upload_request",
  "runtime"
);

function contextRecord(opCase: OperationalCase): Record<string, unknown> {
  return opCase.context_jsonb &&
    typeof opCase.context_jsonb === "object" &&
    !Array.isArray(opCase.context_jsonb)
    ? (opCase.context_jsonb as Record<string, unknown>)
    : {};
}

function propertyLabel(context: Record<string, unknown>): string {
  for (const key of [
    "legal_address",
    "property_address",
    "property_title",
    "title",
  ]) {
    const value = context[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const data =
    context.property_data &&
    typeof context.property_data === "object" &&
    !Array.isArray(context.property_data)
      ? (context.property_data as Record<string, unknown>)
      : {};
  return typeof data.property_title === "string" && data.property_title.trim()
    ? data.property_title.trim()
    : "la propiedad";
}

export function formatDocumentsUploadRequestNotifyText(params: {
  propertyLabel: string;
  reason?: string | null;
  channel: "web" | "telegram";
}): string {
  const reasonLine =
    typeof params.reason === "string" && params.reason.trim()
      ? `\n\nMotivo: ${params.reason.trim()}`
      : "";
  const uploadHint =
    params.channel === "web"
      ? "Súbelos aquí en el chat (clip) y confirma con **«listo»** o **Terminé de subir**."
      : "Envíalos aquí como archivos/fotos y confirma con **«listo»** o el botón **Terminé de subir**.";
  return [
    `Necesito documentos adicionales o corregidos para **${params.propertyLabel}**.${reasonLine}`,
    "",
    "Checklist:",
    "",
    ...buildDocumentChecklistLines(),
    "",
    DOCUMENT_PRIVACY_LINE,
    "",
    uploadHint,
  ].join("\n");
}

export async function ensureDocumentsUploadRequestForCase(params: {
  db: DbClient;
  opCase: OperationalCase;
  source: string;
  channel: "web" | "telegram";
  reason?: string | null;
  /** Si true, fuerza document_request_target=internal_user. */
  forceInternalTarget?: boolean;
}): Promise<{
  requested: boolean;
  case: OperationalCase;
  message: string;
}> {
  const { db, source, channel } = params;
  let opCase = params.opCase;

  if (params.forceInternalTarget !== false) {
    opCase = await setCaseDocumentRequestTarget({
      db,
      opCase,
      target: "internal_user",
      decidedBy: "agent",
      source,
      reason: params.reason ?? "titularidad_internal_docs_remediation",
    });
  }

  const { data: unread } = await db
    .from("internal_user_notifications")
    .select("id")
    .eq("user_id", opCase.user_id)
    .eq("case_id", opCase.id)
    .eq("kind", DOCUMENTS_UPLOAD_REQUESTED_NOTIFICATION_KIND)
    .eq("status", "unread")
    .limit(1);
  const context = contextRecord(opCase);
  const text = formatDocumentsUploadRequestNotifyText({
    propertyLabel: propertyLabel(context),
    reason: params.reason,
    channel,
  });

  if (Array.isArray(unread) && unread.length > 0) {
    const waiting =
      (await advisedUpdate(db, opCase, opCase.version, {
        status: "waiting_internal",
        nextActionAt: null,
      })) ?? opCase;
    return {
      requested: false,
      case: waiting,
      message:
        "Ya hay una solicitud de documentos pendiente. Súbelos y confirma con «listo».",
    };
  }

  const delivery = await deliverInternalCaseFollowUp({
    db,
    userId: opCase.user_id,
    caseId: opCase.id,
    text,
    kind: DOCUMENTS_UPLOAD_REQUESTED_NOTIFICATION_KIND,
    data: { source, purpose: "titularidad_internal_docs" },
  });

  await insertOperationalCaseEvent(db, {
    caseId: opCase.id,
    eventType: "reminder_sent",
    actor: "system",
    stepKey: opCase.current_step ?? undefined,
    payload: {
      purpose: "documents_upload_requested",
      source,
      active_internal_channel: delivery.activeChannel,
      notify_delivered: delivery.notifyDelivered,
      web_chat_mirrored: delivery.webChatMirrored,
    },
  });

  const fresh = (await getOperationalCase(db, opCase.id)) ?? opCase;
  const waiting =
    (await advisedUpdate(db, fresh, fresh.version, {
      status: "waiting_internal",
      nextActionAt: null,
    })) ?? fresh;

  return {
    requested: true,
    case: waiting,
    message: text,
  };
}
