import {
  getInternalUserNotification,
  getOperationalCase,
  getRecentOperationalCaseEvents,
  insertOperationalCaseEvent,
  resolveInternalNotificationWithReminders,
  updateOperationalCase,
  type DbClient,
} from "@agents/db";
import { sendTelegramMessage } from "@/lib/telegram/send-message";
import { buildExternalCaseDocumentDownloadUrl } from "@/lib/operational-cases/case-document-download-token";
import { resolveContractDraftDeliveryUrl } from "@/lib/operational-cases/contract-draft-document";
import {
  CONTRACT_DRAFT_DOCUMENT_BINDING,
  dedupeConcatenatedSiteOriginInUrl,
  resolveGeneratedDocumentOutputPathFromCase,
} from "@/lib/operational-cases/generated-case-document";

export type ContractReviewIntent =
  | "approve_send"
  | "request_changes"
  | "approve_send_after_revision"
  | "unclear";

export type ParsedContractReviewDecision = {
  intent: ContractReviewIntent;
  change_notes?: string;
  reason?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSettingsTestCase(context: Record<string, unknown>) {
  return (
    context.created_from === "case_type_settings_test" ||
    context.test_mode === true
  );
}

export function parseContractReviewDecision(text: string): ParsedContractReviewDecision {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return { intent: "unclear", reason: "Respuesta vacía." };
  }

  const approveSendPatterns = [
    /^(s[ií]|ok|va|dale|perfecto)\s*[,.]?\s*(m[aá]ndalo|env[ií]alo|enviar|mandar)/i,
    /^(m[aá]ndalo|env[ií]alo|enviar al due[nñ]o|mandar al due[nñ]o)/i,
    /^(aprobar|aprobado|apruebo)\s*(y\s*)?(m[aá]ndar|enviar)/i,
    /no\s+necesita\s+cambios.*(m[aá]ndar|enviar)/i,
    /sin\s+cambios.*(m[aá]ndar|enviar)/i,
    /listo.*(m[aá]ndar|enviar)/i,
  ];
  if (approveSendPatterns.some((pattern) => pattern.test(normalized))) {
    return { intent: "approve_send" };
  }

  const revisionApprovePatterns = [
    /(ya\s+lo\s+ajust|ya\s+lo\s+corr|adjunto|anexo|te\s+adjunto|versi[oó]n\s+corregida)/i,
    /(contrato\s+modificado|contrato\s+corregido|borrador\s+actualizado)/i,
  ];
  const wantsSend =
    /(m[aá]ndalo|env[ií]alo|enviar|mandar|al\s+due[nñ]o)/i.test(normalized);
  if (revisionApprovePatterns.some((pattern) => pattern.test(normalized)) && wantsSend) {
    return {
      intent: "approve_send_after_revision",
      change_notes: text.trim(),
    };
  }

  const changePatterns = [
    /(necesita\s+cambios|haz\s+cambios|hay\s+que\s+cambiar|ajusta|corrige|modifica)/i,
    /(no\s+lo\s+mandes|no\s+env[ií]es|espera|detente)/i,
    /(revisar\s+de\s+nuevo|vuelve\s+a\s+generar)/i,
  ];
  if (changePatterns.some((pattern) => pattern.test(normalized))) {
    return {
      intent: "request_changes",
      change_notes: text.trim(),
    };
  }

  if (/^(aprobar|aprobado|apruebo)(\s+contrato)?\b/i.test(normalized)) {
    return { intent: "approve_send" };
  }

  return {
    intent: "unclear",
    reason:
      "No entendí si quieres enviar el contrato al dueño o pedir cambios. Ejemplos: «mándalo al dueño» o «necesita cambios en la cláusula de comisión».",
  };
}

async function resolveContractDocUrl(
  db: DbClient,
  caseId: string,
  context: Record<string, unknown>
): Promise<string | null> {
  const fromContext = await resolveContractDraftDeliveryUrl(db, {
    caseId,
    context,
    forExternalAudience: true,
  });
  if (fromContext) {
    if (fromContext.includes("/api/public/operational-cases/documents/download")) {
      return fromContext;
    }
    if (
      fromContext.includes("/api/operational-cases/") &&
      fromContext.includes("/download")
    ) {
      const opCase = await getOperationalCase(db, caseId);
      if (opCase?.user_id) {
        const ref = await resolveGeneratedDocumentOutputPathFromCase(db, {
          caseId,
          context,
          binding: CONTRACT_DRAFT_DOCUMENT_BINDING,
        });
        if (ref?.output_path) {
          const external = buildExternalCaseDocumentDownloadUrl({
            caseId,
            userId: opCase.user_id,
            documentKey: CONTRACT_DRAFT_DOCUMENT_BINDING.documentKey,
            outputPath: ref.output_path,
          });
          if (external) return external;
        }
      }
    }
    return fromContext;
  }

  const events = await getRecentOperationalCaseEvents(db, caseId, 30);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.event_type !== "human_decision") continue;
    const payload = event.payload_jsonb;
    if (!isRecord(payload)) continue;
    if (payload.kind !== "contract_drafted") continue;
    const outputPath =
      typeof payload.output_path === "string" ? payload.output_path.trim() : "";
    if (outputPath) {
      const merged = {
        ...context,
        contract_draft: {
          ...(isRecord(context.contract_draft) ? context.contract_draft : {}),
          output_path: outputPath,
          output_bucket:
            typeof payload.output_bucket === "string"
              ? payload.output_bucket
              : undefined,
        },
      };
      const fromEvent = await resolveContractDraftDeliveryUrl(db, {
        caseId,
        context: merged,
        forExternalAudience: true,
      });
      if (fromEvent) return fromEvent;
    }
    const docUrl = payload.doc_url;
    if (typeof docUrl === "string" && docUrl.trim() && !docUrl.includes("example.test")) {
      return dedupeConcatenatedSiteOriginInUrl(docUrl.trim());
    }
  }
  return null;
}

function externalContactChatId(
  externalContact: Record<string, unknown> | null | undefined
): number | null {
  if (!externalContact) return null;
  const raw = externalContact.chat_id;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim()) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

async function sendContractToOwner(params: {
  chatId: number;
  ownerName: string;
  docUrl: string;
}) {
  const greeting = params.ownerName.trim() ? `${params.ownerName.trim()}, ` : "";
  const text = `${greeting}te paso el contrato de comisión para que lo revises. Cuando estés conforme, fírmalo y mándame el PDF firmado por aquí.\n\n${params.docUrl}`;
  await sendTelegramMessage(params.chatId, text, undefined, { throwOnError: true });
}

export async function handleContractReviewDecision(
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
    notification.kind !== "contract_review" &&
    notification.kind !== "contract_pending"
  ) {
    return {
      ok: false,
      status: "wrong_kind",
      message: "Este pendiente no es una revisión de contrato.",
    };
  }
  const metadata = isRecord(notification.metadata_jsonb)
    ? notification.metadata_jsonb
    : {};
  if (
    notification.kind === "contract_pending" &&
    Array.isArray(metadata.missing_required_fields) &&
    metadata.missing_required_fields.length > 0
  ) {
    return {
      ok: false,
      status: "wrong_kind",
      message:
        "Este pendiente pide datos contractuales faltantes, no revisión del borrador.",
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

  const parsed = parseContractReviewDecision(params.text);
  if (parsed.intent === "unclear") {
    return { ok: false, status: "unclear", message: parsed.reason };
  }

  const context = (opCase.context_jsonb ?? {}) as Record<string, unknown>;
  const settingsTestCase = isSettingsTestCase(context);

  if (parsed.intent === "request_changes") {
    const updated = await updateOperationalCase(db, opCase.id, opCase.version, {
      status: "waiting_internal",
      currentStep: "contract_pending",
      nextActionAt: new Date().toISOString(),
      context: {
        ...context,
        contract_review: {
          status: "changes_requested",
          notes: parsed.change_notes ?? params.text.trim(),
          requested_at: new Date().toISOString(),
        },
      },
    });
    if (!updated) {
      return { ok: false, status: "version_conflict", message: "El caso cambió; intenta de nuevo." };
    }
    await insertOperationalCaseEvent(db, {
      caseId: opCase.id,
      eventType: "human_decision",
      actor: "user",
      payload: {
        kind: "contract_changes_requested",
        notes: parsed.change_notes ?? params.text.trim(),
      },
    });
    await resolveInternalNotificationWithReminders(db, {
      id: notification.id,
      userId: params.userId,
      status: "actioned",
    });
    return {
      ok: true,
      status: "changes_requested",
      message:
        "Quedó registrado: el borrador necesita cambios. El caso sigue en contract_pending esperando tu nueva instrucción.",
    };
  }

  const docUrl = await resolveContractDocUrl(db, opCase.id, context);
  if (!docUrl) {
    return {
      ok: false,
      status: "missing_doc_url",
      message:
        "No encontré el enlace del borrador (contract_drafted). Vuelve a generar el contrato antes de enviarlo al dueño.",
    };
  }

  const external = isRecord(opCase.external_contact_jsonb)
    ? (opCase.external_contact_jsonb as Record<string, unknown>)
    : null;
  const chatId = externalContactChatId(external);
  const ownerName =
    typeof external?.display_name === "string" ? external.display_name : "estimado/a";

  if (!settingsTestCase && chatId == null) {
    return {
      ok: false,
      status: "missing_owner_chat",
      message:
        "El caso no tiene chat_id del dueño en external_contact_jsonb; no puedo enviar el contrato por Telegram.",
    };
  }

  if (!settingsTestCase && chatId != null) {
    try {
      await sendContractToOwner({ chatId, ownerName, docUrl });
    } catch (error) {
      return {
        ok: false,
        status: "telegram_failed",
        message:
          error instanceof Error
            ? error.message
            : "No pude enviar el contrato al dueño por Telegram.",
      };
    }
  }

  const revisionNote =
    parsed.intent === "approve_send_after_revision"
      ? parsed.change_notes ?? params.text.trim()
      : undefined;

  const updated = await updateOperationalCase(db, opCase.id, opCase.version, {
    status: settingsTestCase ? "paused" : "waiting_external",
    currentStep: "contract_pending",
    nextActionAt: settingsTestCase ? null : new Date().toISOString(),
    context: {
      ...context,
      contract_draft: {
        ...(isRecord(context.contract_draft) ? context.contract_draft : {}),
        doc_url: docUrl,
      },
      contract_review: {
        status: "approved_for_owner",
        approved_at: new Date().toISOString(),
        ...(revisionNote ? { revision_notes: revisionNote } : {}),
      },
      ...(settingsTestCase
        ? {
            controlled_test_status: "contract_sent_to_owner_stopped_before_external_wait",
            controlled_test_note:
              "Contrato aprobado para envío al dueño en caso de prueba; detenido en paused para no mezclar settings con operación real.",
          }
        : {}),
    },
  });
  if (!updated) {
    return { ok: false, status: "version_conflict", message: "El caso cambió; intenta de nuevo." };
  }

  await insertOperationalCaseEvent(db, {
    caseId: opCase.id,
    eventType: "human_decision",
    actor: "user",
    payload: {
      kind:
        parsed.intent === "approve_send_after_revision"
          ? "contract_revised_and_approved"
          : "contract_approved_for_owner",
      doc_url: docUrl,
      ...(revisionNote ? { revision_notes: revisionNote } : {}),
    },
  });
  await insertOperationalCaseEvent(db, {
    caseId: opCase.id,
    eventType: "reminder_sent",
    actor: "system",
    payload: {
      purpose: "contract_sent_to_owner",
      channel: settingsTestCase ? "simulated" : "telegram",
      doc_url: docUrl,
    },
  });
  await resolveInternalNotificationWithReminders(db, {
    id: notification.id,
    userId: params.userId,
    status: "actioned",
  });

  return {
    ok: true,
    status: settingsTestCase ? "approved_send_simulated" : "approved_send",
    message: settingsTestCase
      ? "Contrato aprobado para envío al dueño (simulado en caso de prueba). El caso quedó en paused."
      : parsed.intent === "approve_send_after_revision"
        ? "Listo: registré tu versión revisada y envié el contrato al dueño por Telegram."
        : "Listo: envié el contrato al dueño por Telegram. El caso queda esperando su respuesta.",
  };
}
