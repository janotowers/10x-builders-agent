import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import {
  createServerClient,
  decryptToken,
  findLatestConversationalOperationalCase,
  findPendingConversationBindings,
  setConversationBindingStatus,
  getConversationBindingById,
  getPendingToolCall,
  getGoogleCalendarAccessToken,
  associateExternalResponseWithCase,
  findOperationalCaseByExternalChatId,
  getInternalUserNotification,
  getOperationalCase,
  getActiveE2ELabSession,
  getSessionMessages,
  getTelegramChatId,
  insertOperationalCaseEvent,
  listInternalUserNotifications,
  linkE2ELabSessionToCase,
  updateInternalUserNotificationMetadata,
  updateToolCallStatus,
  upsertConversationBinding,
} from "@agents/db";
import {
  bindAiUsageContext,
  isPropertyOptioningIntent,
  runAgent,
} from "@agents/agent";
import {
  answerTelegramCallbackQuery,
  downloadTelegramFile,
  getTelegramFile,
  sendTelegramDocument,
  sendTelegramMarkdownMessage,
  sendTelegramMessage,
  sendTelegramProductMessage,
  truncateTelegramText,
  withTypingHeartbeat,
} from "@/lib/telegram/send-message";
import { resolveSingleRequiredBooleanField } from "@/lib/notify/contract-data-review-telegram-markup";
import { maybeCatchUpFlush, fireAndForgetFlush } from "@/lib/memory/trigger";
import { ensureAgentToolDepsWired } from "@/lib/agent/wire-tool-deps";
import { runDeferredControlledE2ETick } from "@/lib/business-decisions/price-approval";
import {
  handleContractRevisionUploadAndSend,
  runDeferredContractControlledE2ETick,
} from "@/lib/business-decisions/contract-review";
import { runDeferredListingDescriptionControlledE2ETick } from "@/lib/business-decisions/listing-description-review";
import { runDeferredPublishDestinationControlledE2ETick } from "@/lib/business-decisions/publish-destination-approval";
import { finalizeCaseAfterToolDecision } from "@/lib/operational-cases/finalize-case-after-tool-decision";
import {
  isAgentE2EToolCall,
} from "@/lib/operational-cases/settings-test-tool-policy";
import { buildPublicationAwareE2EToolApprovalPolicy } from "@/lib/operational-cases/publication-tool-policy";
import { businessDecisionHandler } from "@/lib/business-decisions/registry";
import { resolveDecomposedPendingDecisionTurn } from "@/lib/business-decisions/decomposed-turn";
import {
  appendResidualAcknowledgment,
  deferredAgentContinuationText,
} from "@/lib/business-decisions/residual-intent";
import { handlePropertyDataReviewDecision } from "@/lib/business-decisions/property-data-review";
import {
  looksLikeNewCaseIntent,
  shouldBindTelegramMessageToConversationalCase,
  shouldForceNewConversationalCaseOnExplicitStartIntent,
} from "@/lib/operational-cases/conversational-case-routing";
import {
  resolveConversationalClarificationReply,
  resolveRoutableConversationBindings,
  routeConversationalMessageAgainstBindings,
} from "@/lib/operational-cases/conversational-routing-orchestrator";
import {
  buildClarificationContinueResponse,
  freeTextForClarificationCallback,
} from "@/lib/operational-cases/conversation-clarification-actions";
import {
  documentExtensionFromPath,
  ingestCaseDocument,
  type CaseDocumentPayload,
} from "@/lib/operational-cases/case-document-ingestion";
import { ensureConversationalCase } from "@/lib/operational-cases/ensure-conversational-case";
import { buildTelegramOperationalCaseToolApprovalPolicy } from "@/lib/operational-cases/telegram-operational-case-tool-policy";
import type {
  AgentRuntimeInput,
  InternalUserNotification,
  OperationalCase,
} from "@agents/types";
import {
  operationalCaseDocumentRequestTargetFromContext,
} from "@agents/types";
import {
  isSettingsTestCase,
  runSettingsTestCaseAgentTick,
} from "@/lib/operational-cases/run-settings-test-case-tick";
import { findPendingConfirmationCheckpoint } from "@/lib/agent/pending-confirmation-checkpoint";
import {
  buildTelegramIntakeCompletionMessage,
  intakeJustCompleted,
  isIntakeInProgress,
} from "@/lib/operational-cases/telegram-intake-completion-message";
import { classifyOperationalConversationMessage } from "@/lib/operational-cases/operational-conversation-classifier";
import {
  isAwaitingCharacteristicsResponse,
  processCharacteristicsReplyDeterministically,
  shouldProcessInternalCharacteristicsReply,
} from "@/lib/operational-cases/characteristics-response";
import { applyPropertyOptioningPostAgentInvariants } from "@/lib/operational-cases/property-optioning-post-agent-invariants";
import {
  finalizePropertyOptioningAgentTurn,
  maybeRecoverContractPendingTurn,
  maybeRecoverPackageReadyContinue,
} from "@/lib/operational-cases/operational-case-post-turn";
import { resolveTelegramHitlCallback } from "@/lib/operational-cases/hitl-action-contract";
import { handleComparablesExpansionDecision } from "@/lib/business-decisions/comparables-expansion-decision";
import { notifyPriceApprovalForCase } from "@agents/agent";
import { notifyUserRespectingActiveInternalChannel } from "@/lib/operational-cases/deliver-internal-case-follow-up";
import {
  resolveConversationalIntakeTurn,
  type ConversationalIntakeRoute,
} from "@/lib/operational-cases/conversational-intake-orchestrator";
import {
  ensureConversationalE2ELabExternalContact,
  maybeRunPostIntakeConversationalE2ETick,
} from "@/lib/operational-cases/conversational-e2e-post-intake";
import {
  applyDocumentRequestTargetChoice,
  inferInternalDocumentTargetOnUpload,
  messageLooksLikeDocumentTargetChoice,
  resolveCharacteristicsReplyAgainstBindings,
  resolveDocumentTargetReplyAgainstBindings,
  resolveInternalDocumentMessageCase,
  resolveInternalDocumentUploadCaseForMedia,
  shouldPromptCaseDocumentRequestTarget,
} from "@/lib/operational-cases/document-request-target";
import { shouldSendTelegramAgentResponse } from "@/lib/operational-cases/telegram-agent-response-policy";
import {
  isUsableE2ELabSessionCase,
} from "@/lib/operational-cases/e2e-lab-routing-isolation";
import {
  buildExternalContactDeepLink,
  buildExternalContactSetupMessage,
  parseExternalContactLinkPayload,
  verifyExternalContactLink,
} from "@/lib/operational-cases/external-contact-link";
import {
  completeDocumentBatchForCase,
  looksLikeDocumentBatchComplete,
} from "@/lib/operational-cases/document-batch-completion";
import {
  appendRawPhoto,
  internalCaseMediaRegisteredKind,
} from "@/lib/operational-cases/append-raw-photo";
import { photosUploadProgressAckText } from "@/lib/operational-cases/photo-batch-completion";
import { completeUploadBatch } from "@/lib/operational-cases/upload-batch-completion";
import {
  buildDocumentReceivedAck,
  buildMediaGroupReceivedAck,
  buildPhotoMediaGroupReceivedAck,
  looksLikeDocumentUploadSideText,
} from "@/lib/operational-cases/case-document-collection";
import {
  appendMediaGroupAckToCase,
  flushMediaGroupAcksForCase,
  inspectPendingMediaGroupAcks,
  MEDIA_GROUP_ACK_WINDOW_MS,
} from "@/lib/operational-cases/telegram-media-group-ack-store";
import {
  AttachmentRuntimeError,
  ingestGenericAttachment,
  resolveAttachmentRuntimeInput,
} from "@/lib/attachments";

/**
 * Ejecuta el tick del agente E2E que quedó diferido por la aprobación de
 * precio (ver `deferControlledE2ETick`). Debe llamarse *después* de haber
 * enviado la confirmación al usuario, para que el mensaje del siguiente paso
 * no se adelante al ack.
 */
async function maybeRunDeferredPriceTick(
  db: ReturnType<typeof createServerClient>,
  result: {
    ok?: boolean;
    case_id?: unknown;
    deferredControlledE2ETick?: unknown;
  }
): Promise<void> {
  if (!result.ok) return;
  const deferred = result.deferredControlledE2ETick;
  const caseId = typeof result.case_id === "string" ? result.case_id : null;
  if (!deferred || !caseId) return;
  const source =
    typeof (deferred as { source?: unknown }).source === "string"
      ? (deferred as { source: string }).source
      : "price_approved";
  try {
    await runDeferredControlledE2ETick(db, caseId, source);
  } catch (tickError) {
    console.error("[telegram-webhook] deferred price tick failed:", tickError);
  }
}

async function maybeRunDeferredContractTick(
  db: ReturnType<typeof createServerClient>,
  result: {
    ok?: boolean;
    case_id?: unknown;
    deferredControlledE2ETick?: unknown;
  }
): Promise<void> {
  if (!result.ok) return;
  const deferred = result.deferredControlledE2ETick;
  const caseId = typeof result.case_id === "string" ? result.case_id : null;
  if (!deferred || !caseId) return;
  const source =
    typeof (deferred as { source?: unknown }).source === "string"
      ? (deferred as { source: string }).source
      : "contract_email_sent";
  try {
    await runDeferredContractControlledE2ETick(db, caseId, source);
  } catch (tickError) {
    console.error("[telegram-webhook] deferred contract tick failed:", tickError);
  }
}

async function maybeRunDeferredListingDescriptionTick(
  db: ReturnType<typeof createServerClient>,
  result: {
    ok?: boolean;
    case_id?: unknown;
    deferredControlledE2ETick?: unknown;
  }
): Promise<void> {
  if (!result.ok) return;
  const deferred = result.deferredControlledE2ETick;
  const caseId = typeof result.case_id === "string" ? result.case_id : null;
  if (!deferred || !caseId) return;
  const source =
    typeof (deferred as { source?: unknown }).source === "string"
      ? (deferred as { source: string }).source
      : "listing_description_approved";
  try {
    await runDeferredListingDescriptionControlledE2ETick(db, caseId, source);
  } catch (tickError) {
    console.error(
      "[telegram-webhook] deferred listing-description tick failed:",
      tickError
    );
  }
}

async function maybeRunDeferredPublishDestinationTick(
  db: ReturnType<typeof createServerClient>,
  result: {
    ok?: boolean;
    case_id?: unknown;
    deferredControlledE2ETick?: unknown;
  }
): Promise<void> {
  if (!result.ok) return;
  const deferred = result.deferredControlledE2ETick;
  const caseId = typeof result.case_id === "string" ? result.case_id : null;
  if (!deferred || !caseId) return;
  const source =
    typeof (deferred as { source?: unknown }).source === "string"
      ? (deferred as { source: string }).source
      : "publish_destination_easybroker_approved";
  const forceRetryFailedOperation =
    (deferred as { forceRetryFailedOperation?: unknown }).forceRetryFailedOperation ===
    true;
  try {
    await runDeferredPublishDestinationControlledE2ETick(db, caseId, source, {
      forceRetryFailedOperation,
    });
  } catch (tickError) {
    console.error(
      "[telegram-webhook] deferred publish-destination tick failed:",
      tickError
    );
  }
}

function isActiveListingDescriptionReviewNotification(
  notification: InternalUserNotification | null,
  userId: string
): notification is InternalUserNotification {
  return Boolean(
    notification &&
      notification.user_id === userId &&
      notification.kind === "listing_description_review" &&
      notification.status === "unread"
  );
}

function isTelegramCommand(text: string): boolean {
  return /^\s*\//.test(text);
}

const TELEGRAM_INTAKE_ROUTED: Record<ConversationalIntakeRoute, string> = {
  intake_missing_fields_requested: "operational_case_intake_missing_fields",
  intake_reopen_blocked: "operational_case_intake_reopen_blocked",
  intake_still_missing: "operational_case_intake_still_missing",
  intake_updated_incomplete: "operational_case_intake_updated_incomplete",
  intake_completed: "operational_case_intake_completed",
  case_continuation_reprompt: "operational_case_continuation_reprompt",
  delegate_to_agent: "operational_case_intake_delegate_to_agent",
};

const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeForTelegramRouting(value: string) {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function shouldIgnoreConversationalE2EIntakeEcho(params: {
  message: string;
  opCase: OperationalCase;
}) {
  if (
    params.opCase.context_jsonb?.created_from !== "agent_conversation" ||
    params.opCase.context_jsonb?.e2e_controlled !== true ||
    params.opCase.current_step !== "awaiting_documents"
  ) {
    return false;
  }

  const text = normalizeForTelegramRouting(params.message);
  if (!text || looksLikeDocumentBatchComplete(text)) return false;

  const context = params.opCase.context_jsonb ?? {};
  const fieldMatches = [
    context.property_title,
    context.property_zone,
    context.operation_type,
    context.property_type,
  ].filter((value): value is string => {
    if (typeof value !== "string" || !value.trim()) return false;
    const normalizedValue = normalizeForTelegramRouting(value);
    return normalizedValue.length >= 4 && text.includes(normalizedValue);
  });

  return fieldMatches.length >= 2;
}

/**
 * Procesa de forma determinística una respuesta (interna o externa) a la
 * solicitud de características faltantes. Punto único de verdad para las tres
 * entradas (responder externo E2E, responder externo real, asesor interno):
 *
 *   1. Mezcla los campos en `property_data` con el extractor reutilizable.
 *   2. Resuelve el pendiente interno `property_data_minimums_missing` (no-op si
 *      la respuesta vino por canal externo, que no crea ese pendiente).
 *   3. Acusa recibo en el chat.
 *   4. Dispara el tick E2E sólo si el caso es controlado; en producción pide
 *      `property_data_review` de inmediato vía invariants (canal activo).
 *
 * No duplica lógica de merge: reutiliza `processCharacteristicsReplyDeterministically`.
 */
async function processCharacteristicsReply(params: {
  db: ReturnType<typeof createServerClient>;
  opCase: OperationalCase;
  chatId: number;
  text: string;
}): Promise<OperationalCase> {
  const isE2EControlled = params.opCase.context_jsonb?.e2e_controlled === true;
  const merged = await processCharacteristicsReplyDeterministically({
    db: params.db,
    opCase: params.opCase,
    text: params.text,
    source: "telegram_webhook_characteristics_response",
    // E2E: el tick corre de inmediato (cron suprimido). Producción: el cron
    // reanuda el caso, así que despertamos next_action_at = ahora.
    nextActionAt: isE2EControlled ? null : new Date().toISOString(),
  });
  await sendTelegramMessage(
    params.chatId,
    "Gracias, ya registré la información adicional. La voy a procesar y te aviso el siguiente paso."
  );
  if (isE2EControlled) {
    void runSettingsTestCaseAgentTick(params.db, merged, merged.user_id, {
      source: "telegram_webhook_conversational_e2e_characteristics_response",
      ownerResponseText: params.text,
    }).catch((tickError) => {
      console.error(
        "[telegram-webhook] characteristics response tick failed:",
        tickError
      );
    });
  } else {
    void applyPropertyOptioningPostAgentInvariants({
      db: params.db,
      opCase: merged,
      source: "telegram_webhook_characteristics_response",
    }).catch((invariantError) => {
      console.error(
        "[telegram-webhook] characteristics post-agent invariants failed:",
        invariantError
      );
    });
  }
  return merged;
}

/**
 * Completa el lote documental en ruta interna y dispara el procesamiento, con
 * la MISMA mecánica que el chat web (`completeDocumentBatchForCase` + tick E2E).
 * Evita el camino del responder externo y no delega al LLM.
 */
async function finalizeInternalDocumentBatch(params: {
  db: ReturnType<typeof createServerClient>;
  caseId: string;
  chatId: number;
  source: string;
}) {
  const { db, caseId, chatId, source } = params;
  const completion = await completeUploadBatch({
    db,
    caseId,
    channel: "telegram",
    source,
  });
  if (completion.status === "no_files") {
    await sendTelegramProductMessage(chatId, completion.ackText);
    return NextResponse.json({
      ok: true,
      routed: "operational_case_internal_documents_no_documents",
      case_id: caseId,
    });
  }
  if (completion.status === "failed" || completion.status === "wrong_step") {
    await sendTelegramProductMessage(chatId, completion.ackText);
    return NextResponse.json({
      ok: true,
      routed: "operational_case_internal_documents_failed",
      case_id: caseId,
    });
  }
  await sendTelegramProductMessage(chatId, completion.ackText);
  if (completion.case.context_jsonb?.e2e_controlled === true) {
    void runSettingsTestCaseAgentTick(
      db,
      completion.case,
      completion.case.user_id,
      { source }
    ).catch((tickError) => {
      console.error(
        "[telegram-webhook] internal documents marked ready tick failed:",
        tickError
      );
    });
  }
  return NextResponse.json({
    ok: true,
    routed: "operational_case_internal_documents_processing",
    case_id: caseId,
  });
}

const UPLOAD_BATCH_SETTLE_MAX_WAIT_MS = 8_000;
const UPLOAD_BATCH_SETTLE_POLL_MS = 400;

async function sleepMs(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Shared completion path for button «Terminé de subir» and text «listo».
 * Waits briefly for in-flight Telegram album webhooks to settle, flushes
 * consolidated media-group acks, then runs completeUploadBatch on a fresh case.
 */
async function finalizeUploadBatchAfterSettling(params: {
  db: ReturnType<typeof createServerClient>;
  caseId: string;
  chatId: number;
  source: string;
  /** When true, answer Telegram callback quickly before settling. */
  callbackQueryId?: string;
}): Promise<NextResponse> {
  const { db, caseId, chatId, source } = params;

  if (params.callbackQueryId) {
    await answerTelegramCallbackQuery(
      params.callbackQueryId,
      "Confirmando carga…"
    );
  }

  const settleDeadline = Date.now() + UPLOAD_BATCH_SETTLE_MAX_WAIT_MS;
  let opCase = await getOperationalCase(db, caseId);
  while (opCase && Date.now() < settleDeadline) {
    const pending = inspectPendingMediaGroupAcks({
      context: isObjectRecord(opCase.context_jsonb)
        ? (opCase.context_jsonb as Record<string, unknown>)
        : {},
      caseId,
      chatId,
      windowMs: MEDIA_GROUP_ACK_WINDOW_MS,
    });
    // Settle only while album items are still arriving (quiet window not met).
    // Use a short quiet threshold for completion (not the full 12s ack window).
    const quietMs = 1_500;
    if (
      !pending.settling ||
      pending.msSinceLastFile == null ||
      pending.msSinceLastFile >= quietMs
    ) {
      break;
    }
    await sleepMs(UPLOAD_BATCH_SETTLE_POLL_MS);
    opCase = await getOperationalCase(db, caseId);
  }

  if (opCase) {
    const flush = await flushMediaGroupAcksForCase({
      db,
      opCase,
      chatId,
      sendAck: async () => {
        // Final completion ack comes from completeUploadBatch; avoid double message.
      },
      force: true,
    });
    opCase = flush.opCase;
  }

  const completion = await completeUploadBatch({
    db,
    caseId,
    channel: "telegram",
    source,
  });

  const batchKind = completion.batchKind;
  const isPhotos = batchKind === "photos";
  if (completion.status === "insufficient" || completion.status === "no_files") {
    await sendTelegramProductMessage(chatId, completion.ackText);
    return NextResponse.json({
      ok: true,
      routed: isPhotos
        ? "operational_case_internal_photos_insufficient"
        : "upload_batch_done",
      case_id: caseId,
      ...(isPhotos ? { photos_count: completion.fileCount } : {}),
      status: completion.status,
    });
  }
  if (completion.status === "failed" || completion.status === "wrong_step") {
    await sendTelegramProductMessage(chatId, completion.ackText);
    return NextResponse.json({
      ok: true,
      routed: isPhotos
        ? "operational_case_internal_photos_failed"
        : "upload_batch_done",
      case_id: caseId,
      status: completion.status,
    });
  }

  await sendTelegramProductMessage(chatId, completion.ackText);

  if (
    (completion.status === "advanced" ||
      completion.status === "already_advanced") &&
    completion.case.context_jsonb?.e2e_controlled === true
  ) {
    void runSettingsTestCaseAgentTick(
      db,
      completion.case,
      completion.case.user_id,
      { source }
    ).catch((tickError) => {
      console.error(
        `[telegram-webhook] upload batch tick failed (${source}):`,
        tickError
      );
    });
  }

  return NextResponse.json({
    ok: true,
    routed: isPhotos
      ? "operational_case_internal_photos_processing"
      : "upload_batch_done",
    case_id: caseId,
    ...(isPhotos ? { photos_count: completion.fileCount } : {}),
    status: completion.status,
  });
}

async function finalizeInternalPhotoBatch(params: {
  db: ReturnType<typeof createServerClient>;
  caseId: string;
  chatId: number;
  source: string;
}) {
  return finalizeUploadBatchAfterSettling(params);
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    media_group_id?: string;
    from: { id: number; first_name: string };
    chat: { id: number };
    text?: string;
    caption?: string;
    photo?: Array<{
      file_id: string;
      file_unique_id: string;
      width: number;
      height: number;
      file_size?: number;
    }>;
    document?: {
      file_id: string;
      file_unique_id: string;
      file_name?: string;
      mime_type?: string;
      file_size?: number;
    };
  };
  callback_query?: {
    id: string;
    from: { id: number };
    message: { chat: { id: number }; message_id: number };
    data: string;
  };
}

type WebhookClaimState = "claimed" | "duplicate_completed" | "duplicate_in_progress";

const TELEGRAM_WEBHOOK_CLAIM_LEASE_MS = 10 * 60 * 1000;

async function claimTelegramWebhookUpdate(params: {
  db: ReturnType<typeof createServerClient>;
  updateId: number;
  userId: string;
  chatId: number;
  messageId?: number;
}): Promise<WebhookClaimState> {
  const nowIso = new Date().toISOString();
  const { data: inserted, error: insertError } = await params.db
    .from("telegram_webhook_updates")
    .insert({
      update_id: params.updateId,
      user_id: params.userId,
      chat_id: params.chatId,
      message_id: params.messageId ?? null,
      status: "processing",
      claimed_at: nowIso,
      updated_at: nowIso,
    })
    .select("update_id")
    .maybeSingle();
  if (insertError && insertError.code !== "23505") {
    throw insertError;
  }
  if (inserted) return "claimed";

  const { data: existing, error: existingError } = await params.db
    .from("telegram_webhook_updates")
    .select("status, claimed_at")
    .eq("update_id", params.updateId)
    .maybeSingle();
  if (existingError) throw existingError;
  if (!existing) return "claimed";
  if (existing.status === "completed") return "duplicate_completed";

  const leaseCutoffIso = new Date(
    Date.now() - TELEGRAM_WEBHOOK_CLAIM_LEASE_MS
  ).toISOString();
  const { data: takeover, error: takeoverError } = await params.db
    .from("telegram_webhook_updates")
    .update({
      user_id: params.userId,
      chat_id: params.chatId,
      message_id: params.messageId ?? null,
      claimed_at: nowIso,
      updated_at: nowIso,
      status: "processing",
    })
    .eq("update_id", params.updateId)
    .eq("status", "processing")
    .lt("claimed_at", leaseCutoffIso)
    .select("update_id")
    .maybeSingle();
  if (takeoverError) throw takeoverError;
  return takeover ? "claimed" : "duplicate_in_progress";
}

async function completeTelegramWebhookUpdate(params: {
  db: ReturnType<typeof createServerClient>;
  updateId: number;
  turnId?: string | null;
}): Promise<void> {
  const nowIso = new Date().toISOString();
  const { error } = await params.db
    .from("telegram_webhook_updates")
    .update({
      status: "completed",
      completed_at: nowIso,
      turn_id: params.turnId ?? null,
      updated_at: nowIso,
    })
    .eq("update_id", params.updateId);
  if (error) {
    console.warn("[telegram-webhook] could not mark update completed:", error);
  }
}

function describeReceivedTelegramFile(media: ReturnType<typeof bestTelegramMedia>) {
  if (!media?.originalName?.trim()) return "el archivo";
  return `el archivo «${media.originalName.trim()}»`;
}

function documentKindAckHint(kind: string | null | undefined) {
  switch (kind) {
    case "boleta_registral":
      return "La usaré como referencia principal para validar titularidad.";
    case "predial":
      return "La usaré para validar superficies de terreno y construcción.";
    case "escritura_descripcion":
    case "escritura_primera_hoja":
    case "escritura_ultima_hoja":
      return "La revisaré como soporte legal de la propiedad.";
    case "comprobante_domicilio":
      return "Lo usaré para corroborar domicilio y titularidad cuando aplique.";
    default:
      return null;
  }
}

function isPropertyDataReviewCase(opCase: OperationalCase) {
  return (
    opCase.status === "waiting_internal" &&
    (opCase.current_step === "documents_received" ||
      opCase.current_step === "property_data_review")
  );
}

function bestTelegramMedia(message: NonNullable<TelegramUpdate["message"]>) {
  if (message.document) {
    return {
      fileId: message.document.file_id,
      uniqueId: message.document.file_unique_id,
      originalName: message.document.file_name ?? "telegram-document",
      contentType: message.document.mime_type ?? "application/octet-stream",
      fileSize: message.document.file_size ?? null,
      fallbackExtension: "bin",
    };
  }
  if (message.photo?.length) {
    const photo = [...message.photo].sort(
      (a, b) => (b.file_size ?? b.width * b.height) - (a.file_size ?? a.width * a.height)
    )[0];
    return {
      fileId: photo.file_id,
      uniqueId: photo.file_unique_id,
      originalName: "telegram-photo.jpg",
      contentType: "image/jpeg",
      fileSize: photo.file_size ?? null,
      fallbackExtension: "jpg",
    };
  }
  return null;
}

function parseBotCommand(messageText: string): {
  command: string;
  args: string;
} {
  const trimmed = messageText.trim();
  const i = trimmed.indexOf(" ");
  const head = i === -1 ? trimmed : trimmed.slice(0, i);
  const tail = i === -1 ? "" : trimmed.slice(i + 1).trim();
  const at = head.indexOf("@");
  const command = (at === -1 ? head : head.slice(0, at)).toLowerCase();
  return { command, args: tail };
}

async function resumeAgentFromCallback(
  db: ReturnType<typeof createServerClient>,
  toolCallId: string,
  action: "approve" | "reject"
) {
  const toolCall = await getPendingToolCall(db, toolCallId);
  if (!toolCall) return { ok: false, message: "Esta confirmación ya fue procesada o expiró. Envía el comando de nuevo si aún la necesitas." };
  const { data: session } = await db
    .from("agent_sessions")
    .select("id, user_id")
    .eq("id", toolCall.session_id)
    .single();
  if (!session) return { ok: false, message: "Session not found" };

  const userId = session.user_id as string;
  if (action === "reject") {
    await updateToolCallStatus(db, toolCall.id as string, "rejected", {
      message: "Acción cancelada por el usuario.",
      source: "telegram_callback",
    });
    await finalizeCaseAfterToolDecision(db, {
      toolCall,
      userId,
      decision: "reject",
    });
    return {
      ok: true,
      message: "Acción cancelada.",
      pendingConfirmation: null,
    };
  }

  const { data: profile } = await db
    .from("profiles")
    .select(
      "name, agent_system_prompt, timezone, email, phone, business_brain, is_ungga_admin"
    )
    .eq("id", userId)
    .single();
  const { data: toolSettings } = await db
    .from("user_tool_settings")
    .select("*")
    .eq("user_id", userId);
  const { data: skillSettings } = await db
    .from("user_skill_settings")
    .select("*")
    .eq("user_id", userId);
  const { data: integrations } = await db
    .from("user_integrations")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "active");

  const githubIntegration = integrations?.find(
    (i: Record<string, unknown>) =>
      i.provider === "github" && i.status === "active"
  );
  let githubToken: string | undefined;
  if (githubIntegration?.encrypted_tokens) {
    try {
      githubToken = decryptToken(githubIntegration.encrypted_tokens as string);
    } catch (e) {
      console.error("Failed to decrypt GitHub token:", e);
    }
  }
  const googleCalendarAccessToken =
    (await getGoogleCalendarAccessToken(db, userId)) ?? undefined;

  const storedCheckpointThreadId = await findPendingConfirmationCheckpoint(db, {
    sessionId: toolCall.session_id as string,
    toolCallId: toolCall.id as string,
    turnId: (toolCall.turn_id as string | null) ?? null,
  });
  if (!storedCheckpointThreadId) {
    return {
      ok: false,
      message: "No encontré el checkpoint de esta confirmación. Vuelve a ejecutar la acción.",
      pendingConfirmation: null,
    };
  }

  const caseId =
    typeof toolCall.metadata_jsonb?.case_id === "string"
      ? toolCall.metadata_jsonb.case_id
      : typeof toolCall.arguments_json?.case_id === "string"
        ? toolCall.arguments_json.case_id
        : undefined;
  const resumeCase = caseId ? await getOperationalCase(db, caseId) : null;
  const resumeContext =
    resumeCase?.user_id === userId ? (resumeCase.context_jsonb ?? {}) : {};
  const resumePricing =
    resumeContext.pricing_proposal &&
    typeof resumeContext.pricing_proposal === "object" &&
    !Array.isArray(resumeContext.pricing_proposal)
      ? (resumeContext.pricing_proposal as Record<string, unknown>)
      : {};
  const e2eResumePolicy = isAgentE2EToolCall(toolCall)
    ? buildPublicationAwareE2EToolApprovalPolicy({
        context: resumeContext,
        documentRequestTarget:
          operationalCaseDocumentRequestTargetFromContext(resumeContext),
        autoExecuteContractDraftGeneration:
          resumeCase?.current_step === "contract_pending" &&
          resumePricing.approval_status === "approved",
      })
    : undefined;
  const opsResumePolicy = buildTelegramOperationalCaseToolApprovalPolicy(
    resumeCase?.user_id === userId ? resumeCase : null
  );
  const resumeToolApprovalPolicy = {
    ...(opsResumePolicy ?? {}),
    ...(e2eResumePolicy ?? {}),
  };
  const hasResumePolicy =
    Boolean(opsResumePolicy) || Boolean(e2eResumePolicy);
  console.info("[telegram-webhook] resume policy", {
    case_id: caseId ?? null,
    current_step: resumeCase?.current_step ?? null,
    policy_keys: hasResumePolicy ? Object.keys(resumeToolApprovalPolicy) : [],
    e2e: Boolean(e2eResumePolicy),
  });

  const result = await runAgent({
    resumeDecision: "approve",
    checkpointThreadId: storedCheckpointThreadId,
    turnId: (toolCall.turn_id as string | null) ?? undefined,
    userId,
    sessionId: session.id as string,
    systemPrompt:
      (profile?.agent_system_prompt as string) ?? "Eres un asistente útil.",
    db,
    enabledTools: (toolSettings ?? []).map((t: Record<string, unknown>) => ({
      id: t.id as string,
      user_id: t.user_id as string,
      tool_id: t.tool_id as string,
      enabled: t.enabled as boolean,
      config_json: (t.config_json as Record<string, unknown>) ?? {},
    })),
    enabledSkills: (skillSettings ?? []).map((s: Record<string, unknown>) => ({
      id: s.id as string,
      user_id: s.user_id as string,
      skill_id: s.skill_id as string,
      enabled: s.enabled as boolean,
      config_json: (s.config_json as Record<string, unknown>) ?? {},
    })),
    integrations: (integrations ?? []).map((i: Record<string, unknown>) => ({
      id: i.id as string,
      user_id: i.user_id as string,
      provider: i.provider as string,
      scopes: (i.scopes as string[]) ?? [],
      status: i.status as "active" | "revoked" | "expired",
      created_at: i.created_at as string,
    })),
    githubToken,
    userTimezone: (profile?.timezone as string) ?? undefined,
    userName: (profile?.name as string | null) ?? null,
    userEmail: (profile?.email as string | null) ?? null,
    userPhone: (profile?.phone as string | null) ?? null,
    businessBrain:
      (profile?.business_brain as Record<string, unknown> | null) ?? {},
    isUnggaAdmin: (profile?.is_ungga_admin as boolean | null) ?? false,
    channel: isAgentE2EToolCall(toolCall) ? "case_runner" : "telegram",
    googleCalendarAccessToken,
    caseId,
    toolCallSource: isAgentE2EToolCall(toolCall) ? "agent_e2e" : undefined,
    toolApprovalPolicy: hasResumePolicy ? resumeToolApprovalPolicy : undefined,
  });
  await finalizeCaseAfterToolDecision(db, {
    toolCall,
    userId,
    decision: "approve",
  });

  return {
    ok: true,
    message: result.pendingConfirmation ? null : result.response,
    pendingConfirmation: result.pendingConfirmation,
  };
}

export async function POST(request: Request) {
  const secret = request.headers.get("x-telegram-bot-api-secret-token");
  if (WEBHOOK_SECRET && secret !== WEBHOOK_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  ensureAgentToolDepsWired();
  const update: TelegramUpdate = await request.json();
  const db = createServerClient();

  // Handle callback queries (confirmation buttons)
  if (update.callback_query) {
    const cb = update.callback_query;
    const [action, targetId] = cb.data.split(":");

    if (!targetId) {
      await answerTelegramCallbackQuery(cb.id, "Datos inválidos");
      return NextResponse.json({ ok: true });
    }

    // Resolve user from telegram
    const { data: telegramAccount } = await db
      .from("telegram_accounts")
      .select("user_id")
      .eq("telegram_user_id", cb.from.id)
      .single();

    if (!telegramAccount) {
      await answerTelegramCallbackQuery(cb.id, "Cuenta no vinculada");
      return NextResponse.json({ ok: true });
    }

    const userId = telegramAccount.user_id as string;

    // Idempotency for callbacks (same ledger as message updates).
    const callbackClaimState = await claimTelegramWebhookUpdate({
      db,
      updateId: update.update_id,
      userId,
      chatId: cb.message.chat.id,
      messageId: cb.message.message_id,
    });
    if (callbackClaimState !== "claimed") {
      await answerTelegramCallbackQuery(cb.id, "Ya procesado");
      return NextResponse.json({
        ok: true,
        routed:
          callbackClaimState === "duplicate_completed"
            ? "telegram_duplicate_callback_completed"
            : "telegram_duplicate_callback_in_progress",
      });
    }
    try {
    const clarifyFreeText = freeTextForClarificationCallback(action);
    if (clarifyFreeText) {
      const binding = await getConversationBindingById(db, targetId);
      if (
        !binding ||
        binding.user_id !== userId ||
        binding.status !== "clarification_needed"
      ) {
        await answerTelegramCallbackQuery(cb.id, "Ya no aplica");
        await sendTelegramMessage(
          cb.message.chat.id,
          "Esa opción ya no está activa. Si quieres opcionar una propiedad, escríbemelo de nuevo."
        );
        return NextResponse.json({
          ok: true,
          routed: "clarification_callback_stale",
        });
      }
      const reply = await resolveConversationalClarificationReply({
        db,
        binding,
        message: clarifyFreeText,
      });
      if (reply.status === "resolved_case") {
        await answerTelegramCallbackQuery(cb.id, "Continuamos ese caso");
        const opCase = reply.case;
        await sendTelegramProductMessage(
          cb.message.chat.id,
          opCase
            ? buildClarificationContinueResponse(opCase)
            : "Perfecto, seguimos con ese caso."
        );
        return NextResponse.json({
          ok: true,
          routed: "clarification_callback_continue",
          case_id: reply.case?.id ?? null,
        });
      }
      if (reply.status === "resolved_new_case") {
        await answerTelegramCallbackQuery(cb.id, "Empezamos otra");
        let session = await db
          .from("agent_sessions")
          .select("id")
          .eq("user_id", userId)
          .eq("channel", "telegram")
          .eq("status", "active")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle()
          .then((r) => r.data);
        if (!session) {
          const { data: createdSession } = await db
            .from("agent_sessions")
            .insert({
              user_id: userId,
              channel: "telegram",
              status: "active",
              budget_tokens_used: 0,
              budget_tokens_limit: 100000,
            })
            .select("id")
            .single();
          session = createdSession;
        }
        const ensured = await ensureConversationalCase(db, {
          userId,
          caseType: "property_optioning",
          channel: "telegram",
          chatId: cb.message.chat.id,
          forceNew: true,
        });
        if (!ensured?.case || !session) {
          await sendTelegramMessage(
            cb.message.chat.id,
            "No pude abrir el nuevo caso. Intenta de nuevo con «Quiero opcionar una propiedad»."
          );
          return NextResponse.json({
            ok: true,
            routed: "clarification_callback_new_failed",
          });
        }
        await upsertConversationBinding(db, {
          userId,
          caseId: ensured.case.id,
          caseType: ensured.case.case_type,
          channel: "telegram",
          chatId: cb.message.chat.id,
          sessionId: session.id as string,
          status: "awaiting_user",
          awaitingFields:
            (ensured.case.context_jsonb?.missing_required as unknown[]) ?? [],
          metadata: { source: "telegram_clarification_callback_new" },
        });
        const firstPrompt = await resolveConversationalIntakeTurn({
          db,
          userId,
          sessionId: session.id as string,
          opCase: ensured.case,
          message: reply.effectiveMessage ?? "Quiero opcionar una propiedad",
          channel: "telegram",
          justCreated: true,
          chatId: cb.message.chat.id,
        });
        if (firstPrompt.responseText) {
          await sendTelegramMarkdownMessage(
            cb.message.chat.id,
            firstPrompt.responseText
          );
        }
        return NextResponse.json({
          ok: true,
          routed: "clarification_callback_new",
          case_id: ensured.case.id,
        });
      }
      await answerTelegramCallbackQuery(cb.id, "No pude aplicar la opción");
      await sendTelegramMessage(
        cb.message.chat.id,
        'No pude aplicar esa opción. Responde «continuar» o «nueva».'
      );
      return NextResponse.json({
        ok: true,
        routed: "clarification_callback_unrecognized",
      });
    }
    if (action === "ld_approve" || action === "ld_changes" || action === "ld_highlights") {
      const notification = await getInternalUserNotification(db, targetId);
      if (!isActiveListingDescriptionReviewNotification(notification, userId)) {
        await answerTelegramCallbackQuery(cb.id, "Revisión no activa");
        await sendTelegramMessage(
          cb.message.chat.id,
          "Esta revisión de descripción ya no está activa. Usa la notificación más reciente del caso."
        );
        return NextResponse.json({
          ok: true,
          routed: "listing_description_review_stale_callback",
          notification_id: targetId,
        });
      }
      if (action === "ld_changes" || action === "ld_highlights") {
        await updateInternalUserNotificationMetadata(db, notification, {
          telegram_pending_reply_intent: "request_changes",
          telegram_pending_reply_requested_at: new Date().toISOString(),
        });
        await answerTelegramCallbackQuery(cb.id, "Escribe los cambios");
        await sendTelegramMessage(
          cb.message.chat.id,
          "Claro. Escríbeme qué cambiar: ajustes editoriales, puntos clave a agregar o pega la versión exacta que quieres usar. Ejemplo:\nHacer el tono más ejecutivo y mencionar cercanía a servicios."
        );
        return NextResponse.json({
          ok: true,
          routed: "listing_description_changes_guidance",
          notification_id: targetId,
        });
      }
      const result = await businessDecisionHandler("listing_description_review").handle(db, {
        userId,
        notificationId: targetId,
        text: "APROBAR DESCRIPCIÓN",
        deferControlledE2ETick: true,
      });
      await answerTelegramCallbackQuery(
        cb.id,
        result.ok ? "Descripción aprobada" : "No pude procesarlo"
      );
      await sendTelegramMessage(
        cb.message.chat.id,
        result.message ??
          (result.ok
            ? "Descripción aprobada. El caso avanzó a aprobación de publicación."
            : "No pude procesar la revisión de descripción.")
      );
      await maybeRunDeferredListingDescriptionTick(db, result);
      return NextResponse.json({
        ok: true,
        routed: "listing_description_review",
        notification_id: targetId,
      });
    }

    if (action === "price_approve" || action === "price_reject") {
      const result = await businessDecisionHandler("price_approval").handle(db, {
        userId,
        notificationId: targetId,
        text: action === "price_approve" ? "APROBAR PRECIO" : "RECHAZAR PRECIO",
        // Diferimos el avance del caso para enviar primero la confirmación.
        deferControlledE2ETick: true,
      });
      await answerTelegramCallbackQuery(
        cb.id,
        result.ok
          ? action === "price_approve"
            ? "Precio aprobado"
            : "Precio rechazado"
          : "No pude procesarlo"
      );
      await sendTelegramMessage(
        cb.message.chat.id,
        result.message ??
          (result.ok
            ? "Listo, procese tu decision de precio."
            : "No pude procesar la decision de precio.")
      );
      // Tras enviar la confirmación, disparamos el tick del agente E2E que
      // quedó diferido (puede producir sus propios mensajes del siguiente paso).
      await maybeRunDeferredPriceTick(db, result);
      return NextResponse.json({
        ok: true,
        routed: "price_approval",
        notification_id: targetId,
      });
    }

    if (action === "price_adjust") {
      await answerTelegramCallbackQuery(cb.id, "Envía el ajuste");
      await sendTelegramMessage(
        cb.message.chat.id,
        "Claro. Respóndeme con los montos, por ejemplo:\nAJUSTAR PRECIO salida=23500 ideal=22000 minimo=18000"
      );
      return NextResponse.json({
        ok: true,
        routed: "price_adjust_guidance",
        notification_id: targetId,
      });
    }

    if (action === "upload_done") {
      const caseId = targetId;
      const opCase = await getOperationalCase(db, caseId);
      if (!opCase || opCase.user_id !== userId) {
        await answerTelegramCallbackQuery(cb.id, "Caso no encontrado");
        return NextResponse.json({
          ok: true,
          routed: "upload_batch_done_case_missing",
        });
      }
      return await finalizeUploadBatchAfterSettling({
        db,
        caseId,
        chatId: cb.message.chat.id,
        source: "telegram_upload_done_button",
        callbackQueryId: cb.id,
      });
    }

    if (action === "pub_approve" || action === "pub_skip" || action === "pub_reject") {
      const text =
        action === "pub_approve"
          ? "APROBAR"
          : action === "pub_skip"
            ? "OMITIR"
            : "RECHAZAR";
      const result = await businessDecisionHandler("publish_destination_approval").handle(
        db,
        {
          userId,
          notificationId: targetId,
          text,
          deferControlledE2ETick: true,
        }
      );
      await answerTelegramCallbackQuery(
        cb.id,
        result.ok ? "Decisión registrada" : "No pude procesarlo"
      );
      await sendTelegramMessage(
        cb.message.chat.id,
        result.message ??
          (result.ok
            ? "Listo, procesé tu decisión de publicación."
            : "No pude procesar la decisión de publicación.")
      );
      await maybeRunDeferredPublishDestinationTick(db, result);
      return NextResponse.json({
        ok: true,
        routed: "publish_destination_approval",
        notification_id: targetId,
      });
    }

    if (action === "pubrev_approve" || action === "pubrev_stop") {
      const text =
        action === "pubrev_approve"
          ? "Aprobar y continuar"
          : "Detener y revisar";
      const result = await businessDecisionHandler("publication_review").handle(db, {
        userId,
        notificationId: targetId,
        text,
        deferControlledE2ETick: true,
      });
      await answerTelegramCallbackQuery(
        cb.id,
        result.ok ? "Revisión registrada" : "No pude procesarlo"
      );
      await sendTelegramMessage(
        cb.message.chat.id,
        result.message ??
          (result.ok
            ? "Listo, procesé la revisión condicional."
            : "No pude procesar la revisión condicional.")
      );
      if (
        result.ok &&
        result.case_id &&
        result.deferredControlledE2ETick &&
        action === "pubrev_approve"
      ) {
        const source =
          typeof (result.deferredControlledE2ETick as { source?: string }).source ===
          "string"
            ? (result.deferredControlledE2ETick as { source: string }).source
            : "publication_review_telegram";
        const forceRetryFailedOperation =
          (result.deferredControlledE2ETick as { forceRetryFailedOperation?: boolean })
            .forceRetryFailedOperation === true;
        const { requestPublicationProgress } = await import(
          "@/lib/operational-cases/publication-runner"
        );
        const { createPublicationRunnerOwnedAgentTick } = await import(
          "@/lib/operational-cases/run-settings-test-case-tick"
        );
        void requestPublicationProgress(db, String(result.case_id), source, {
          forceRetryFailedOperation,
          runAgentTick: createPublicationRunnerOwnedAgentTick(
            db,
            userId,
            source
          ),
        }).catch((error) => {
          console.error(
            "[telegram-webhook] deferred publication review progress failed:",
            error
          );
        });
      }
      return NextResponse.json({
        ok: true,
        routed: "publication_review",
        notification_id: targetId,
      });
    }

    const isContractSendEmailAction =
      action === "contract_email" || action === "contract_send_email";
    const isContractUploadAction =
      action === "contract_upload" || action === "contract_upload_adjusted_send";
    if (isContractSendEmailAction || isContractUploadAction) {
      const result = await businessDecisionHandler("contract_review").handle(db, {
        userId,
        notificationId: targetId,
        text:
          isContractSendEmailAction
            ? "enviar por email al propietario"
            : "subir contrato corregido y enviar",
        deferControlledE2ETick: true,
      });
      await answerTelegramCallbackQuery(
        cb.id,
        result.ok
          ? isContractSendEmailAction
            ? "Contrato enviado por email"
            : "Sube el contrato corregido"
          : "No pude procesarlo"
      );
      await sendTelegramMessage(
        cb.message.chat.id,
        result.message ??
          (result.ok
            ? "Listo, procesé tu decisión sobre el contrato."
            : "No pude procesar la decisión del contrato.")
      );
      await maybeRunDeferredContractTick(db, result);
      if (
        result.ok &&
        (result.status === "approved_send" ||
          result.status === "revision_uploaded_and_sent") &&
        typeof result.case_id === "string"
      ) {
        const photosCase = await getOperationalCase(db, result.case_id);
        if (photosCase?.current_step === "photos_requested") {
          const { ensurePhotosUploadRequestForCase } = await import(
            "@/lib/operational-cases/ensure-photos-upload-request"
          );
          await ensurePhotosUploadRequestForCase({
            db,
            opCase: photosCase,
            source: "telegram_contract_review_callback",
          });
        }
      }
      return NextResponse.json({
        ok: true,
        routed: "contract_review",
        notification_id: targetId,
      });
    }

    if (action === "cdr_yes" || action === "cdr_no") {
      const notification = await getInternalUserNotification(db, targetId);
      if (
        !notification ||
        notification.user_id !== userId ||
        notification.kind !== "contract_data_review" ||
        notification.status !== "unread"
      ) {
        await answerTelegramCallbackQuery(cb.id, "Pendiente no activo");
        return NextResponse.json({
          ok: true,
          routed: "contract_data_review_stale_callback",
          notification_id: targetId,
        });
      }
      const metadata =
        notification.metadata_jsonb &&
        typeof notification.metadata_jsonb === "object"
          ? (notification.metadata_jsonb as Record<string, unknown>)
          : {};
      const missingFields = Array.isArray(metadata.missing_fields)
        ? metadata.missing_fields
        : [];
      // Solo aceptar Sí/No cuando queda exactamente un booleano obligatorio.
      const singleBoolean = resolveSingleRequiredBooleanField(missingFields);
      if (!singleBoolean) {
        await answerTelegramCallbackQuery(cb.id, "Escribe el dato faltante");
        await sendTelegramMessage(
          cb.message.chat.id,
          notification.body ||
            "Responde con los datos contractuales faltantes (correo, porcentajes o meses)."
        );
        return NextResponse.json({
          ok: true,
          routed: "contract_data_review_text_guidance",
          notification_id: targetId,
        });
      }
      const patchKey =
        singleBoolean.key === "collaboration_enabled"
          ? "collaboration_enabled"
          : singleBoolean.key;
      const result = await businessDecisionHandler("contract_data_review").handle(
        db,
        {
          userId,
          notificationId: targetId,
          text: "",
          patch: {
            [patchKey]: action === "cdr_yes",
          },
        }
      );
      await answerTelegramCallbackQuery(
        cb.id,
        result.ok ? "Registrado" : "No pude procesarlo"
      );
      await sendTelegramMessage(
        cb.message.chat.id,
        result.message ??
          (result.ok
            ? "Listo, registré tu respuesta."
            : "No pude registrar los datos contractuales.")
      );
      if (
        result.ok &&
        result.status === "captured" &&
        typeof result.case_id === "string"
      ) {
        const capturedCase = await getOperationalCase(db, result.case_id);
        if (
          capturedCase &&
          capturedCase.context_jsonb?.e2e_controlled !== true
        ) {
          const { kickContractPendingAfterDataCapture } = await import(
            "@/lib/operational-cases/run-settings-test-case-tick"
          );
          await kickContractPendingAfterDataCapture({
            db,
            opCase: capturedCase,
            source: "telegram_contract_data_callback",
          });
        }
      }
      return NextResponse.json({
        ok: true,
        routed: "contract_data_review",
        notification_id: targetId,
      });
    }

    if (action === "property_data_confirm" || action === "property_data_correct") {
      if (action === "property_data_correct") {
        await answerTelegramCallbackQuery(cb.id, "Escribe el ajuste");
        await sendTelegramMessage(
          cb.message.chat.id,
          "Perfecto. Envíame el ajuste en texto, por ejemplo:\nTipo: Terreno · Operación: Venta · Zona: Bucerías"
        );
        return NextResponse.json({
          ok: true,
          routed: "property_data_review_guidance",
          notification_id: targetId,
        });
      }
      const result = await handlePropertyDataReviewDecision(db, {
        userId,
        notificationId: targetId,
        text: "Confirmo la información",
      });
      await answerTelegramCallbackQuery(
        cb.id,
        result.ok ? "Datos confirmados" : "No pude procesarlo"
      );
      await sendTelegramMessage(
        cb.message.chat.id,
        result.message ??
          (result.ok
            ? "Listo, procesé tu revisión de datos."
            : "No pude procesar la revisión de datos.")
      );
      return NextResponse.json({
        ok: true,
        routed: "property_data_review",
        notification_id: targetId,
      });
    }

    // Prefijos HITL canónicos (titularidad, comparables, …) vía contrato
    // compartido — evita drift si cambian labels/prefixes en un solo lado.
    const hitlCallback = resolveTelegramHitlCallback({
      callbackAction: action,
    });
    if (hitlCallback?.kind === "titularidad_review") {
      const actionId = hitlCallback.action.id;
      if (actionId === "continue_override") {
        // Motivo obligatorio: el botón solo inicia la captura por texto libre.
        await answerTelegramCallbackQuery(cb.id, "Indica el motivo");
        await sendTelegramMessage(
          cb.message.chat.id,
          "Para **continuar bajo excepción**, responde con el motivo. Ejemplo:\n«continuar bajo excepción: revisé INE y escritura; el OCR omitió el segundo apellido»."
        );
        return NextResponse.json({
          ok: true,
          routed: "titularidad_review_reason_prompt",
          notification_id: targetId,
          action_id: actionId,
        });
      }
      const result = await businessDecisionHandler("titularidad_review").handle(
        db,
        {
          userId,
          notificationId: targetId,
          text: "",
          action: actionId,
          source: "telegram",
        }
      );
      await answerTelegramCallbackQuery(
        cb.id,
        result.ok ? "Registrado" : "No pude procesarlo"
      );
      await sendTelegramMessage(
        cb.message.chat.id,
        result.message ??
          (result.ok
            ? "Listo, registré tu decisión de titularidad."
            : "No pude procesar la decisión de titularidad.")
      );
      return NextResponse.json({
        ok: true,
        routed: "titularidad_review",
        notification_id: targetId,
        status: result.status,
        action_id: actionId,
      });
    }

    if (hitlCallback?.kind === "comparables_search_expansion_decision") {
      const decisionText =
        hitlCallback.action.freeText?.trim() || hitlCallback.action.id;
      const result = await handleComparablesExpansionDecision(db, {
        userId,
        notificationId: targetId,
        text: decisionText,
        source: "telegram",
        deferPriceApprovalNotify: true,
      });
      await answerTelegramCallbackQuery(
        cb.id,
        result.ok ? "Decisión registrada" : "No pude procesarlo"
      );
      await sendTelegramMessage(
        cb.message.chat.id,
        result.message ??
          (result.ok
            ? "Registré tu decisión de comparables."
            : "No pude procesar la decisión de comparables.")
      );
      if (
        result.ok &&
        result.status === "processed" &&
        result.deferredPriceApproval &&
        result.case_id
      ) {
        try {
          await notifyPriceApprovalForCase({
            db,
            caseId: result.case_id,
            userId,
            pricingProposal: result.deferredPriceApproval.pricingProposal,
            source: `comparables_decision_telegram_${result.decision}`,
            notifyUser: notifyUserRespectingActiveInternalChannel,
          });
        } catch (notifyError) {
          console.error(
            "[telegram-webhook] deferred price approval notify failed:",
            notifyError
          );
        }
      }
      if (
        result.ok &&
        result.status === "processed" &&
        result.decision === "expand_search" &&
        result.case_id
      ) {
        const refreshedCase = await getOperationalCase(db, result.case_id);
        if (refreshedCase?.context_jsonb?.e2e_controlled === true) {
          void runSettingsTestCaseAgentTick(
            db,
            refreshedCase,
            refreshedCase.user_id,
            {
              source:
                "telegram_webhook_conversational_e2e_comparables_expand_search",
              ownerResponseText: decisionText,
            }
          ).catch((tickError) => {
            console.error(
              "[telegram-webhook] comparables expand tick failed:",
              tickError
            );
          });
        }
      }
      return NextResponse.json({
        ok: true,
        routed: "comparables_expansion_decision",
        notification_id: targetId,
        decision: result.decision,
        action_id: hitlCallback.action.id,
      });
    }

    if (action === "approve") {
      await answerTelegramCallbackQuery(cb.id, "✅ Aprobado");
      await sendTelegramMessage(cb.message.chat.id, "Acción aprobada. Procesando...");
      const result = await withTypingHeartbeat(cb.message.chat.id, () =>
        resumeAgentFromCallback(db, targetId, "approve")
      );
      if (result.pendingConfirmation) {
        const pc = result.pendingConfirmation;
        await sendTelegramMessage(cb.message.chat.id, pc.message, {
          inline_keyboard: [
            [
              {
                text: "✅ Aprobar",
                callback_data: `approve:${pc.toolCallId}`,
              },
              {
                text: "❌ Cancelar",
                callback_data: `reject:${pc.toolCallId}`,
              },
            ],
          ],
        });
      } else {
        await sendTelegramMessage(cb.message.chat.id, result.message ?? "Hecho.");
      }
    } else if (action === "reject") {
      const result = await resumeAgentFromCallback(db, targetId, "reject");
      await answerTelegramCallbackQuery(
        cb.id,
        result.ok ? "❌ Cancelado" : "Ya no aplica"
      );
      await sendTelegramMessage(
        cb.message.chat.id,
        result.message ??
          (result.ok
            ? "Acción cancelada."
            : "Esta confirmación ya fue procesada o expiró.")
      );
    }

    return NextResponse.json({ ok: true });
    } finally {
      await completeTelegramWebhookUpdate({
        db,
        updateId: update.update_id,
      });
    }
  }

  const message = update.message;
  if (!message) {
    return NextResponse.json({ ok: true });
  }

  const telegramUserId = message.from.id;
  const chatId = message.chat.id;
  // `let`: Slice 4.1-5 puede reasignar al residual unmatched_intent para
  // continuar al agente tras el ack de una decisión multi-intent.
  let text = (message.text ?? message.caption ?? "").trim();
  const inboundMedia = bestTelegramMedia(message);
  let agentMessageText = text;
  const { command, args } = parseBotCommand(text);
  const deterministicPropertyIntent = isPropertyOptioningIntent(text);

  if (command === "/start") {
    const externalContactToken = parseExternalContactLinkPayload(args);
    if (externalContactToken) {
      const displayName =
        typeof message.from.first_name === "string" &&
        message.from.first_name.trim()
          ? message.from.first_name.trim()
          : null;
      const verification = await verifyExternalContactLink(db, {
        token: externalContactToken,
        chatId,
        displayName,
      });
      if (verification.ok) {
        const label = verification.propertyTitle
          ? `«${verification.propertyTitle}»`
          : "la propiedad";
        await sendTelegramMessage(
          chatId,
          `¡Listo! Quedaste vinculado al caso de ${label}. En breve te indicaré qué documentos necesito; puedes enviármelos aquí mismo como archivos.`
        );
        try {
          const advisorChatId = verification.advisorUserId
            ? await getTelegramChatId(db, verification.advisorUserId)
            : null;
          if (advisorChatId) {
            await sendTelegramMessage(
              advisorChatId,
              `El contacto externo quedó vinculado${
                verification.propertyTitle
                  ? ` al caso de «${verification.propertyTitle}»`
                  : ""
              }. Le solicitaré los documentos y te aviso cuando responda.`
            );
          }
        } catch (notifyError) {
          console.warn(
            "[telegram-webhook] external contact link advisor notify failed:",
            notifyError
          );
        }
        return NextResponse.json({
          ok: true,
          routed: "external_contact_linked",
          case_id: verification.caseId,
        });
      }
      await sendTelegramMessage(
        chatId,
        verification.reason === "expired" || verification.reason === "used"
          ? "Este enlace de vinculación ya no es válido. Pídele al asesor que te genere uno nuevo."
          : "No pude validar este enlace de vinculación. Pídele al asesor que te genere uno nuevo."
      );
      return NextResponse.json({
        ok: true,
        routed: "external_contact_link_failed",
      });
    }
    await sendTelegramMessage(
      chatId,
      "¡Hola! Soy tu agente personal.\n\nSi ya tienes cuenta web, ve a Ajustes → Telegram en la web, genera un código de vinculación y envíamelo así:\n/link TU_CODIGO"
    );
    return NextResponse.json({ ok: true });
  }

  if (command === "/link") {
    const code = args.trim().toUpperCase();
    if (!code) {
      await sendTelegramMessage(
        chatId,
        "Indica el código que generaste en la web, por ejemplo:\n/link ABC123"
      );
      return NextResponse.json({ ok: true });
    }

    const { data: linkRecord } = await db
      .from("telegram_link_codes")
      .select("*")
      .eq("code", code)
      .eq("used", false)
      .gt("expires_at", new Date().toISOString())
      .single();

    if (!linkRecord) {
      await sendTelegramMessage(
        chatId,
        "Código inválido o expirado. Genera uno nuevo desde la web."
      );
      return NextResponse.json({ ok: true });
    }

    await db.from("telegram_accounts").upsert(
      {
        user_id: linkRecord.user_id,
        telegram_user_id: telegramUserId,
        chat_id: chatId,
        linked_at: new Date().toISOString(),
      },
      { onConflict: "user_id" }
    );

    await db
      .from("telegram_link_codes")
      .update({ used: true })
      .eq("id", linkRecord.id);

    await sendTelegramMessage(
      chatId,
      "¡Cuenta vinculada correctamente! Ya puedes chatear conmigo."
    );
    return NextResponse.json({ ok: true });
  }

  // ── Operational case external responder ────────────────────────────
  // Si este chat_id es el contacto externo de un caso esperando respuesta
  // (waiting_external), no es un usuario de Gu OS sino, p.ej., el dueño de
  // una propiedad. Asociamos su mensaje al caso y disparamos procesamiento
  // en el siguiente tick del cron — sin pasar por el flujo /link.
  try {
    let matchedCase = await findOperationalCaseByExternalChatId(
      db,
      "telegram",
      chatId
    );
    if (
      matchedCase?.context_jsonb?.created_from === "agent_conversation" &&
      matchedCase.context_jsonb?.e2e_controlled === true &&
      deterministicPropertyIntent
    ) {
      matchedCase = null;
    }
    if (!matchedCase && text && looksLikeDocumentBatchComplete(text)) {
      const { data: pendingBindings } = await db
        .from("operational_case_conversation_bindings")
        .select("case_id")
        .eq("channel", "telegram")
        .eq("chat_id", chatId)
        .in("status", ["awaiting_user", "clarification_needed"])
        .order("updated_at", { ascending: false })
        .limit(5);
      for (const binding of pendingBindings ?? []) {
        const candidate = await getOperationalCase(db, binding.case_id);
        if (!candidate) continue;
        // Los casos de ruta interna NO se procesan por el camino del responder
        // externo: su "listo" lo maneja el handler interno (finalizeInternalDocumentBatch),
        // que no registra external_response ni usa source externo.
        if (
          operationalCaseDocumentRequestTargetFromContext(
            candidate.context_jsonb
          ) === "internal_user"
        ) {
          continue;
        }
        if (
          candidate.context_jsonb?.created_from === "agent_conversation" &&
          candidate.context_jsonb?.e2e_controlled === true &&
          candidate.status !== "paused" &&
          candidate.status !== "completed" &&
          candidate.status !== "failed" &&
          (candidate.current_step === "awaiting_documents" ||
            candidate.current_step === "documents_received")
        ) {
          matchedCase = candidate;
          break;
        }
      }
    }
    if (matchedCase) {
      const media = bestTelegramMedia(message);
      if (
        !media &&
        text &&
        shouldIgnoreConversationalE2EIntakeEcho({
          message: text,
          opCase: matchedCase,
        })
      ) {
        return NextResponse.json({
          ok: true,
          routed: "operational_case_intake_echo_ignored",
          case_id: matchedCase.id,
        });
      }
      let documentPayload: CaseDocumentPayload | null = null;
      if (media) {
        const fileInfo = await getTelegramFile(media.fileId);
        if (!fileInfo.file_path) {
          throw new Error("telegram_file_path_missing");
        }
        const bytes = Buffer.from(await downloadTelegramFile(fileInfo.file_path));
        const ingested = await ingestCaseDocument({
          db,
          caseId: matchedCase.id,
          userId: matchedCase.user_id,
          source: "external_telegram",
          fileName: media.originalName,
          contentType: media.contentType,
          bytes,
          captionText: text || null,
          extension: documentExtensionFromPath(
            fileInfo.file_path,
            media.fallbackExtension
          ),
          fileSizeBytes: media.fileSize ?? bytes.byteLength,
          sourceMetadata: {
            message_id: message.message_id,
            from: message.from,
            telegram_file_id: media.fileId,
            telegram_file_unique_id: media.uniqueId,
            caption: text || null,
          },
        });
        documentPayload = ingested.payload;
      }
      await associateExternalResponseWithCase(db, {
        caseId: matchedCase.id,
        channel: "telegram",
        chatId,
        payload: {
          message_id: message.message_id,
          from: message.from,
          text,
          ...(documentPayload ? { documents: [documentPayload] } : {}),
          received_at: new Date().toISOString(),
        },
      });
      const refreshedCase = await getOperationalCase(db, matchedCase.id);
      const conversationalE2ECase =
        refreshedCase?.context_jsonb?.created_from === "agent_conversation" &&
        refreshedCase.context_jsonb?.e2e_controlled === true;
      if (media && message.media_group_id && refreshedCase) {
        const withGroupedAck = await appendMediaGroupAckToCase({
          db,
          opCase: refreshedCase,
          chatId,
          mediaGroupId: message.media_group_id,
          file: {
            originalName: media.originalName,
            kind: documentPayload?.kind ?? null,
          },
          markReady: false,
        });
        const flush = await flushMediaGroupAcksForCase({
          db,
          opCase: withGroupedAck,
          chatId,
          mediaGroupId: message.media_group_id,
          sendAck: async (files) => {
            await sendTelegramMessage(chatId, buildMediaGroupReceivedAck(files));
          },
        });
        return NextResponse.json({
          ok: true,
          routed:
            flush.flushed > 0
              ? "operational_case_external_document_group_ack_flushed"
              : "operational_case_external_document_group_ack_queued",
          case_id: matchedCase.id,
        });
      }
      const kindHint = documentKindAckHint(documentPayload?.kind);
      const cannedAck = media
        ? `Recibí ${describeReceivedTelegramFile(media)}, gracias. Lo registré en el caso.${
            kindHint ? ` ${kindHint}` : ""
          }`
        : "Recibí tu mensaje, gracias. Lo paso al asesor y te confirmamos el siguiente paso pronto.";
      if (
        refreshedCase &&
        shouldPromptCaseDocumentRequestTarget(refreshedCase) &&
        !media &&
        text.trim()
      ) {
        // Handler de negocio compartido (paridad con web y con el camino
        // conversacional): persiste el destino, registra `recordDocumentFlowReminder`
        // y devuelve el ack canónico. Evita la divergencia de audit trail que tenía
        // este bloque inline (no registraba el recordatorio documental).
        const choice = await applyDocumentRequestTargetChoice({
          db,
          opCase: refreshedCase,
          message: text,
          channel: "telegram",
        });
        if (choice.handled) {
          if (choice.shouldRunPostChoiceE2ETick) {
            try {
              await maybeRunPostIntakeConversationalE2ETick({
                db,
                opCase: choice.updatedCase,
                userId: choice.updatedCase.user_id,
                channel: "telegram",
                chatId,
              });
            } catch (tickError) {
              console.error(
                "[telegram-webhook] post-choice E2E tick failed:",
                tickError
              );
            }
          }
          if (choice.externalContactSetupToken) {
            const deepLink = await buildExternalContactDeepLink(
              choice.externalContactSetupToken
            );
            await sendTelegramMessage(
              chatId,
              buildExternalContactSetupMessage({ deepLink })
            );
            return NextResponse.json({
              ok: true,
              routed: "operational_case_external_contact_setup_requested",
              case_id: matchedCase.id,
            });
          }
          await sendTelegramMarkdownMessage(chatId, choice.responseText);
          return NextResponse.json({
            ok: true,
            routed: "operational_case_document_target_set",
            case_id: matchedCase.id,
          });
        }
      }
      if (refreshedCase && conversationalE2ECase) {
        const awaitingCharacteristics = await isAwaitingCharacteristicsResponse(
          db,
          refreshedCase
        );
        const readyToProcessCharacteristics =
          !media &&
          text.trim() &&
          awaitingCharacteristics &&
          !looksLikeDocumentBatchComplete(text);
        if (readyToProcessCharacteristics) {
          await processCharacteristicsReply({
            db,
            opCase: refreshedCase,
            chatId,
            text,
          });
          return NextResponse.json({
            ok: true,
            routed: "operational_case_characteristics_processing",
            case_id: matchedCase.id,
          });
        }
        if (!media && awaitingCharacteristics && looksLikeDocumentBatchComplete(text)) {
          await sendTelegramMessage(
            chatId,
            "Aún necesito la información adicional solicitada para completar características; responde con esos datos, no con “listo”."
          );
          return NextResponse.json({
            ok: true,
            routed: "operational_case_characteristics_waiting",
            case_id: matchedCase.id,
          });
        }
        const readyToProcessDocuments = !media && looksLikeDocumentBatchComplete(text);
        if (readyToProcessDocuments) {
          const flushedBeforeReady = await flushMediaGroupAcksForCase({
            db,
            opCase: refreshedCase,
            chatId,
            sendAck: async (files) => {
              await sendTelegramMessage(chatId, buildMediaGroupReceivedAck(files));
            },
            force: true,
          });
          const completion = await completeDocumentBatchForCase({
            db,
            caseId: flushedBeforeReady.opCase.id,
            channel: "telegram",
            source: "telegram_webhook_conversational_e2e_external_response",
          });
          if (completion.status === "no_documents") {
            await sendTelegramMessage(
              chatId,
              "Aún no veo documentos registrados en el caso. Envía al menos uno y luego responde “listo”."
            );
            return NextResponse.json({
              ok: true,
              routed: "operational_case_documents_waiting",
              case_id: matchedCase.id,
            });
          }
          if (completion.status === "failed") {
            await sendTelegramMessage(
              chatId,
              "Recibí tu confirmación, pero no pude avanzar el caso en este momento. Inténtalo de nuevo en unos segundos o usa la revisión manual en el laboratorio E2E."
            );
            return NextResponse.json({
              ok: true,
              routed: "operational_case_documents_failed",
              case_id: matchedCase.id,
            });
          }
          await sendTelegramMessage(
            chatId,
            "Gracias, ya registré que terminaste de enviar documentos. Voy a procesarlos y te aviso el siguiente paso."
          );
          void runSettingsTestCaseAgentTick(
            db,
            completion.case,
            completion.case.user_id,
            {
              source: "telegram_webhook_conversational_e2e_external_response",
              ownerResponseText: text,
            }
          ).catch((tickError) => {
            console.error(
              "[telegram-webhook] conversational E2E external response tick failed:",
              tickError
            );
          });
          return NextResponse.json({
            ok: true,
            routed: "operational_case_documents_processing",
            case_id: matchedCase.id,
          });
        }
        await sendTelegramMessage(
          chatId,
          media
            ? `${cannedAck} Cuando termines de enviar los documentos, responde “listo” para revisar el siguiente paso.`
            : `${cannedAck} Cuando termines de enviar los documentos, responde “listo” para revisar el siguiente paso.`
        );
      } else if (refreshedCase && isSettingsTestCase(refreshedCase)) {
        try {
          await runSettingsTestCaseAgentTick(db, refreshedCase, refreshedCase.user_id, {
            source: "telegram_webhook_settings_test",
          });
          await sendTelegramMessage(
            chatId,
            `${cannedAck}\n\n(Caso de prueba: actualiza «Preparación operativa» en Ajustes para ver property_data y el paso del caso.)`
          );
        } catch (tickError) {
          console.error(
            "[telegram-webhook] settings test case tick failed:",
            tickError
          );
          await sendTelegramMessage(chatId, cannedAck);
        }
      } else if (
        refreshedCase &&
        !media &&
        text.trim() &&
        (await isAwaitingCharacteristicsResponse(db, refreshedCase)) &&
        !looksLikeDocumentBatchComplete(text)
      ) {
        await processCharacteristicsReply({
          db,
          opCase: refreshedCase,
          chatId,
          text,
        });
      } else {
        // Acuse de recibo cortés al externo. El procesamiento real lo hace el
        // próximo tick del cron (≤ 1 minuto típicamente).
        await sendTelegramMessage(chatId, cannedAck);
      }
      return NextResponse.json({ ok: true, routed: "operational_case", case_id: matchedCase.id });
    }
  } catch (err) {
    console.error("[telegram-webhook] external case routing failed:", err);
    if (inboundMedia) {
      await sendTelegramMessage(
        chatId,
        "Recibí tu archivo, pero tuve un problema registrándolo en el caso. Intenta reenviarlo en unos minutos o avísale al asesor."
      );
      return NextResponse.json({
        ok: true,
        routed: "operational_case_media_error",
      });
    }
    // Continuamos al flujo normal sólo para texto sin archivo: si era un usuario,
    // no lo bloqueamos por un fallo de búsqueda del caso externo.
  }

  // Resolve user from telegram_user_id
  const { data: telegramAccount } = await db
    .from("telegram_accounts")
    .select("*")
    .eq("telegram_user_id", telegramUserId)
    .single();

  if (!telegramAccount) {
    await sendTelegramMessage(
      chatId,
      "No tienes una cuenta vinculada. Usa /link TU_CODIGO (código desde Ajustes en la web)."
    );
    return NextResponse.json({ ok: true });
  }

  const userId = telegramAccount.user_id;

  const pendingInternal = await listInternalUserNotifications(db, userId, {
    statuses: ["unread"],
    limit: 30,
  });

  // Gates 1-6 (listing description, precio, datos/revisión de contrato,
  // titularidad, comparables) viven en el router compartido con el chat web.
  // property_data_review permanece abajo: está ligado al chat del contacto
  // externo (sin equivalente web). Slice 4.1: el multiplexer descompone
  // turnos multi-intent antes de la cadena de gates y compone la respuesta;
  // cuando no aplica, es exactamente el router de siempre.
  const pendingDecisionTurn = await resolveDecomposedPendingDecisionTurn(db, {
    userId,
    text,
    channel: "telegram",
    chatId,
    isCommand: isTelegramCommand(text),
    isExplicitNewCaseIntent: deterministicPropertyIntent,
    pendingNotifications: pendingInternal,
  });
  if (pendingDecisionTurn.handled) {
    // Slice 4.1-5: si hay pregunta diferida (unmatched_intent), el ack NO
    // lleva "No actué sobre" — se responde abajo vía el flujo conversacional.
    const continuation = deferredAgentContinuationText({
      residual: pendingDecisionTurn.residual,
    });
    const decisionMessage = continuation
      ? pendingDecisionTurn.message
      : appendResidualAcknowledgment(
          pendingDecisionTurn.message,
          pendingDecisionTurn.residual
        );
    if (pendingDecisionTurn.artifact) {
      // read_artifact: entrega el borrador completo como .txt; la revisión
      // sigue pendiente (sin cambio de estado).
      try {
        await sendTelegramDocument(chatId, {
          filename: pendingDecisionTurn.artifact.filename,
          bytes: Buffer.from(pendingDecisionTurn.artifact.content, "utf-8"),
          contentType: "text/plain; charset=utf-8",
          caption: decisionMessage,
        });
      } catch {
        await sendTelegramMessage(
          chatId,
          truncateTelegramText(
            `${decisionMessage}\n\n${pendingDecisionTurn.artifact.content}`
          )
        );
      }
    } else {
      await sendTelegramMessage(chatId, decisionMessage);
    }
    if (pendingDecisionTurn.runAfterReply) {
      await pendingDecisionTurn.runAfterReply();
    }
    if (!continuation) {
      return NextResponse.json({
        ok: true,
        routed: pendingDecisionTurn.routed,
        ...(pendingDecisionTurn.caseId
          ? { case_id: pendingDecisionTurn.caseId }
          : {}),
        ...(pendingDecisionTurn.notificationId
          ? { notification_id: pendingDecisionTurn.notificationId }
          : {}),
        ...(pendingDecisionTurn.status
          ? { status: pendingDecisionTurn.status }
          : {}),
        ...(pendingDecisionTurn.decision
          ? { decision: pendingDecisionTurn.decision }
          : {}),
      });
    }
    // Re-despachar SOLO el residual (nunca el turno original multi-intent).
    text = continuation;
    agentMessageText = continuation;
  }

  if (text) {
    const propertyDataReviewCandidates = (
      await Promise.all(
        pendingInternal
          .filter(
            (notification) =>
              notification.kind === "property_data_review" ||
              notification.kind === "property_data_quality_review"
          )
          .map(async (notification) => {
            if (!notification.case_id) return null;
            const opCase = await getOperationalCase(db, notification.case_id);
            if (!opCase || opCase.user_id !== userId) return null;
            const external = opCase.external_contact_jsonb ?? {};
            if (
              String(external.chat_id ?? "") !== String(chatId) ||
              !isPropertyDataReviewCase(opCase)
            ) {
              return null;
            }
            return { notification, opCase };
          })
      )
    ).filter(
      (candidate): candidate is {
        notification: (typeof pendingInternal)[number];
        opCase: OperationalCase;
      } => Boolean(candidate)
    );

    if (propertyDataReviewCandidates.length === 1) {
      const { notification, opCase } = propertyDataReviewCandidates[0]!;
      const result = await handlePropertyDataReviewDecision(db, {
        userId,
        notificationId: notification.id,
        text,
      });
      if (!result.ok) {
        await sendTelegramMessage(
          chatId,
          result.message ?? "No pude procesar esa respuesta todavía."
        );
        return NextResponse.json({
          ok: true,
          routed: "property_data_review_response_rejected",
          case_id: opCase.id,
          notification_id: notification.id,
          status: result.status,
        });
      }
      const updatedCase = (await getOperationalCase(db, opCase.id)) ?? opCase;
      await associateExternalResponseWithCase(db, {
        caseId: updatedCase.id,
        channel: "telegram",
        chatId,
        payload: {
          message_id: message.message_id,
          from: message.from,
          text,
          purpose: "property_data_review_response",
          received_at: new Date().toISOString(),
        },
      });
      const { data: reviewBindings } = await db
        .from("operational_case_conversation_bindings")
        .select("id")
        .eq("case_id", updatedCase.id)
        .eq("channel", "telegram")
        .eq("chat_id", chatId)
        .in("status", ["awaiting_user", "clarification_needed"])
        .limit(1);
      const reviewBindingId = (reviewBindings?.[0] as { id?: string } | undefined)
        ?.id;
      if (reviewBindingId) {
        await setConversationBindingStatus(db, {
          bindingId: reviewBindingId,
          status: "awaiting_user",
          pendingMessage: {},
          candidateRoutes: [],
          metadataMerge: {
            property_data_review_responded_at: new Date().toISOString(),
          },
          lastUserMessageAt: new Date().toISOString(),
        });
      }
      await sendTelegramMessage(
        chatId,
        result.message ??
          "Gracias, registré la revisión de datos del caso. Ya puedes revisar el siguiente avance en el laboratorio E2E."
      );
      return NextResponse.json({
        ok: true,
        routed: "property_data_review_response",
        case_id: updatedCase.id,
        notification_id: notification.id,
        status: result.status,
      });
    }
  }

  // Get or create session
  let session = await db
    .from("agent_sessions")
    .select("*")
    .eq("user_id", userId)
    .eq("channel", "telegram")
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .single()
    .then((r) => r.data);

  if (!session) {
    const { data } = await db
      .from("agent_sessions")
      .insert({
        user_id: userId,
        channel: "telegram",
        status: "active",
        budget_tokens_used: 0,
        budget_tokens_limit: 100000,
      })
      .select()
      .single();
    session = data;
  }

  if (!session) {
    await sendTelegramMessage(chatId, "Error interno creando sesión.");
    return NextResponse.json({ ok: true });
  }

  // Slice 0.4: contexto ambiente de metering AI para clasificadores y
  // extractores pre-agente (runAgent lo enriquece con turn/case ids).
  bindAiUsageContext(
    {
      userId,
      channel: "telegram",
      sessionId: session.id,
    },
    db
  );

  // Load profile, tools, integrations
  const { data: profile } = await db
    .from("profiles")
    .select(
      "name, agent_system_prompt, timezone, email, phone, business_brain, is_ungga_admin"
    )
    .eq("id", userId)
    .single();

  const { data: toolSettings } = await db
    .from("user_tool_settings")
    .select("*")
    .eq("user_id", userId);
  const { data: skillSettings } = await db
    .from("user_skill_settings")
    .select("*")
    .eq("user_id", userId);

  const { data: integrations } = await db
    .from("user_integrations")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "active");

  // Decrypt GitHub token if available
  const githubIntegration = integrations?.find(
    (i: Record<string, unknown>) =>
      i.provider === "github" && i.status === "active"
  );
  let githubToken: string | undefined;
  if (githubIntegration?.encrypted_tokens) {
    try {
      githubToken = decryptToken(
        githubIntegration.encrypted_tokens as string
      );
    } catch (e) {
      console.error("Failed to decrypt GitHub token:", e);
    }
  }

  const googleCalendarAccessToken =
    (await getGoogleCalendarAccessToken(db, userId)) ?? undefined;

  // Routing conversacional durable:
  //  1) Usa bindings pendientes para decidir si asociar, ignorar o aclarar.
  //  2) Si no hay binding pero hay intención explícita, crea/adopta draft.
  //     TODO(refactor): delegar a resolveConversationalCaseForChannel + adapter
  //     de canal; hoy inline por labTelegramChatId, binding con chatId y primer
  //     prompt Telegram. Ver future-considerations.md §10.
  let conversationalCase: OperationalCase | null = null;
  const initialIntentClassification =
    text && !deterministicPropertyIntent
      ? await classifyOperationalConversationMessage({
          message: text,
          stage: "no_case",
        })
      : null;
  const llmPropertyIntent =
    initialIntentClassification?.route === "property_optioning" &&
    initialIntentClassification.intent === "start_case" &&
    initialIntentClassification.confidence !== "low";
  let explicitPropertyIntent =
    deterministicPropertyIntent || llmPropertyIntent;
  let forceNewConversationalCase = false;
  const pendingBindings = await findPendingConversationBindings(db, {
    userId,
    channel: "telegram",
    chatId,
  });
  const activeE2ELabSession = await getActiveE2ELabSession(db, {
    userId,
    caseType: "property_optioning",
  });
  const e2eLabSessionActive = Boolean(activeE2ELabSession);
  const routingResolution = await resolveRoutableConversationBindings({
    db,
    pendingBindings,
    e2eLabSessionActive,
    caseType: "property_optioning",
  });
  const routingBindings = routingResolution.routableBindings;
  const routingCasesById = routingResolution.candidateCasesById;
  if (text && explicitPropertyIntent) {
    console.info("[telegram-webhook] routing bindings resolved", {
      raw_bindings_count: pendingBindings.length,
      routable_bindings_count: routingBindings.length,
      ignored_binding_reasons: routingResolution.ignoredBindings.map(
        (entry) => entry.reason
      ),
      active_e2e_session_id: activeE2ELabSession?.id ?? null,
      deterministic_property_intent: deterministicPropertyIntent,
    });
  }
  const activeE2ELabSessionCaseId =
    typeof activeE2ELabSession?.case_id === "string" &&
    activeE2ELabSession.case_id.trim().length > 0
      ? activeE2ELabSession.case_id.trim()
      : null;
  if (
    !conversationalCase &&
    text &&
    !explicitPropertyIntent &&
    activeE2ELabSessionCaseId
  ) {
    const sessionCase = await getOperationalCase(db, activeE2ELabSessionCaseId);
    if (
      isUsableE2ELabSessionCase({
        opCase: sessionCase,
        userId,
        caseType: "property_optioning",
      }) &&
      sessionCase &&
      isIntakeInProgress(sessionCase) &&
      shouldBindTelegramMessageToConversationalCase({
        message: agentMessageText,
        opCase: sessionCase,
      })
    ) {
      conversationalCase = sessionCase;
      await upsertConversationBinding(db, {
        userId,
        caseId: sessionCase.id,
        caseType: sessionCase.case_type,
        channel: "telegram",
        chatId,
        sessionId: session.id,
        status: "awaiting_user",
        awaitingFields:
          (sessionCase.context_jsonb?.missing_required as unknown[]) ?? [],
        metadata: {
          source: "telegram_webhook_e2e_session_intake_owner",
        },
      });
    }
  }
  const pendingClarificationBinding = routingBindings.find(
    (binding) => binding.status === "clarification_needed"
  );
  if (
    !conversationalCase &&
    text &&
    messageLooksLikeDocumentTargetChoice(text)
  ) {
    const targetChoiceFromClarification =
      await resolveDocumentTargetReplyAgainstBindings({
        db,
        message: text,
        pendingBindings: routingBindings,
      });
    if (targetChoiceFromClarification.matchedCase) {
      conversationalCase = targetChoiceFromClarification.matchedCase;
      if (pendingClarificationBinding) {
        await setConversationBindingStatus(db, {
          bindingId: pendingClarificationBinding.id,
          status: "awaiting_user",
          pendingMessage: {},
          candidateRoutes: [],
          metadataMerge: {
            clarification_bypassed_at: new Date().toISOString(),
            clarification_bypassed_reason: "document_target_choice",
          },
          lastUserMessageAt: new Date().toISOString(),
        });
      }
    }
  }
  if (!conversationalCase && pendingClarificationBinding && text) {
    const clarificationReply = await resolveConversationalClarificationReply({
      db,
      binding: pendingClarificationBinding,
      message: text,
    });
    if (clarificationReply.status === "invalid_index") {
      await sendTelegramProductMessage(chatId, clarificationReply.responseText);
      return NextResponse.json({
        ok: true,
        routed: "clarification_invalid_index",
      });
    }
    if (clarificationReply.status === "resolved_no") {
      await sendTelegramProductMessage(chatId, clarificationReply.responseText);
      return NextResponse.json({ ok: true, routed: "clarification_resolved_no" });
    }
    if (clarificationReply.status === "resolved_new_case") {
      forceNewConversationalCase = true;
      explicitPropertyIntent = true;
      if (clarificationReply.effectiveMessage) {
        agentMessageText = clarificationReply.effectiveMessage;
      }
    }
    if (clarificationReply.status === "resolved_case") {
      if (clarificationReply.case) {
        conversationalCase = clarificationReply.case;
      }
      if (clarificationReply.effectiveMessage) {
        agentMessageText = clarificationReply.effectiveMessage;
      } else if (
        clarificationReply.case &&
        clarificationReply.effectiveAttachments.length === 0 &&
        !inboundMedia
      ) {
        // "continuar" tras un arranque vacío: retoma el paso del caso
        // (paridad con el callback; no "¿En qué te ayudo?" genérico).
        await sendTelegramProductMessage(
          chatId,
          buildClarificationContinueResponse(clarificationReply.case)
        );
        return NextResponse.json({
          ok: true,
          routed: "clarification_resolved_continue",
          case_id: clarificationReply.case.id,
        });
      }
    }
  }
  // Fase 1 (media-first): un mensaje con ARCHIVO en ruta interna nunca debe
  // perderse por el routing de texto. Resolvemos el caso interno ANTES del
  // bloque `if (text)`, de modo que un caption de álbum (p. ej. "Adjunto
  // documentos" en el primer elemento) no dispare clarify ni descarte el
  // archivo: con `conversationalCase` ya fijado, todo el routing de texto se
  // omite y el flujo llega directo a la ingestión documental.
  if (!conversationalCase && inboundMedia) {
    try {
      const mediaCase = await resolveInternalDocumentUploadCaseForMedia({
        db,
        pendingBindings: routingBindings,
      });
      if (mediaCase) conversationalCase = mediaCase;
    } catch (err) {
      console.error(
        "[telegram-webhook] media-first internal case resolution failed:",
        err
      );
    }
  }
  // Razón por la que un mensaje de TEXTO se asoció a un caso interno recabando
  // documentos (gate barato o fallback LLM); dirige el manejo posterior
  // (cierre de lote vs. acuse lateral) sin re-derivar de regex frágiles.
  let internalDocumentTextReason:
    | "batch_complete"
    | "upload_side_text"
    | null = null;
  if (text) {
    if (
      !conversationalCase &&
      explicitPropertyIntent &&
      (routingBindings.length === 0 ||
        forceNewConversationalCase ||
        Boolean(activeE2ELabSession))
    ) {
      try {
        if (activeE2ELabSessionCaseId && !forceNewConversationalCase) {
          const sessionCase = await getOperationalCase(
            db,
            activeE2ELabSessionCaseId
          );
          const usableSessionCase = isUsableE2ELabSessionCase({
            opCase: sessionCase,
            userId,
            caseType: "property_optioning",
          });
          if (activeE2ELabSession && !usableSessionCase) {
            forceNewConversationalCase = true;
          } else if (sessionCase) {
            if (
              shouldForceNewConversationalCaseOnExplicitStartIntent(
                text,
                sessionCase
              )
            ) {
              forceNewConversationalCase = true;
            } else {
              conversationalCase = sessionCase;
            }
          }
        }
        if (
          !conversationalCase &&
          !forceNewConversationalCase &&
          deterministicPropertyIntent
        ) {
          const latestConversationalCase =
            await findLatestConversationalOperationalCase(db, {
              userId,
              caseType: "property_optioning",
              statuses: ["active", "waiting_internal", "waiting_external"],
            });
          if (
            shouldForceNewConversationalCaseOnExplicitStartIntent(
              text,
              latestConversationalCase
            )
          ) {
            forceNewConversationalCase = true;
          } else if (
            latestConversationalCase &&
            !activeE2ELabSession &&
            !inboundMedia
          ) {
            // Arranque explícito con draft de intake existente: NUNCA adoptar
            // en silencio (un draft de semanas atrás puede traer contexto
            // contaminado). Misma UX continuar-vs-nueva del routing con
            // bindings; se llega aquí cuando el binding del draft quedó fuera
            // de la ventana o no existe para este canal. E2E lab y mensajes
            // con archivo conservan la adopción determinística.
            const draftBinding = await upsertConversationBinding(db, {
              userId,
              caseId: latestConversationalCase.id,
              caseType: latestConversationalCase.case_type,
              channel: "telegram",
              chatId,
              sessionId: session.id,
              status: "awaiting_user",
              awaitingFields:
                (latestConversationalCase.context_jsonb
                  ?.missing_required as unknown[]) ?? [],
              metadata: { source: "telegram_webhook_intent_draft_clarify" },
            });
            const adoptRoute = await routeConversationalMessageAgainstBindings({
              db,
              channel: "telegram",
              message: agentMessageText,
              pendingBindings: [draftBinding],
              explicitIntent: true,
              candidateCasesById: new Map([
                [latestConversationalCase.id, latestConversationalCase],
              ]),
            });
            if (adoptRoute.route === "clarify") {
              await sendTelegramProductMessage(
                chatId,
                adoptRoute.responseText,
                adoptRoute.telegramReplyMarkup
              );
              return NextResponse.json({
                ok: true,
                routed: "clarification_requested",
              });
            }
            if (adoptRoute.route === "case") {
              conversationalCase = adoptRoute.case;
            }
          }
        }
        const ensured = conversationalCase
          ? null
          : await ensureConversationalCase(db, {
              userId,
              caseType: "property_optioning",
              channel: "telegram",
              chatId,
              e2eControlled: Boolean(activeE2ELabSession),
              labTelegramChatId: activeE2ELabSession ? chatId : undefined,
              forceNew:
                forceNewConversationalCase ||
                looksLikeNewCaseIntent(text) ||
                Boolean(activeE2ELabSession && !activeE2ELabSessionCaseId),
            });
        conversationalCase = conversationalCase ?? ensured?.case ?? null;
        if (
          conversationalCase &&
          activeE2ELabSession &&
          conversationalCase.context_jsonb?.e2e_controlled === true &&
          activeE2ELabSession.case_id !== conversationalCase.id
        ) {
          await linkE2ELabSessionToCase(db, {
            sessionId: activeE2ELabSession.id,
            caseId: conversationalCase.id,
          });
        } else if (
          conversationalCase &&
          activeE2ELabSession &&
          conversationalCase.context_jsonb?.e2e_controlled !== true
        ) {
          console.warn(
            "[telegram-webhook] skipped linking e2e session to non-e2e case",
            {
              sessionId: activeE2ELabSession.id,
              caseId: conversationalCase.id,
            }
          );
        }
        if (conversationalCase) {
          await upsertConversationBinding(db, {
            userId,
            caseId: conversationalCase.id,
            caseType: conversationalCase.case_type,
            channel: "telegram",
            chatId,
            sessionId: session.id,
            status: "awaiting_user",
            awaitingFields:
              (conversationalCase.context_jsonb?.missing_required as unknown[]) ?? [],
            metadata: { source: "telegram_webhook_intent" },
          });
        }
        const intakePromptCase = conversationalCase;
        const intakePromptIncomplete =
          intakePromptCase !== null &&
          intakePromptCase.current_step === "intake" &&
          intakePromptCase.context_jsonb?.intake_status !== "complete";
        const shouldSendFreshIntakePrompt =
          intakePromptIncomplete &&
          (ensured?.created === true || deterministicPropertyIntent);
        if (shouldSendFreshIntakePrompt) {
          const firstPrompt = await resolveConversationalIntakeTurn({
            db,
            userId,
            sessionId: session.id,
            opCase: intakePromptCase,
            message: text,
            channel: "telegram",
            justCreated: true,
            chatId,
          });
          if (firstPrompt.handled) {
            conversationalCase = firstPrompt.updatedCase;
            if (firstPrompt.responseText) {
              await sendTelegramMarkdownMessage(chatId, firstPrompt.responseText);
            }
            return NextResponse.json({
              ok: true,
              routed: TELEGRAM_INTAKE_ROUTED[firstPrompt.route],
              case_id: conversationalCase.id,
            });
          }
        }
      } catch (err) {
        console.error(
          "[telegram-webhook] ensure conversational case failed:",
          err
        );
      }
    }
    // Respuesta interno/externo a un caso que espera esa decisión: resolver el
    // caso correcto ANTES del routing genérico para no disparar una
    // desambiguación multi-caso innecesaria.
    if (!conversationalCase) {
      const targetReply = await resolveDocumentTargetReplyAgainstBindings({
        db,
        message: agentMessageText,
        pendingBindings: routingBindings,
      });
      if (targetReply.matchedCase) {
        conversationalCase = targetReply.matchedCase;
      }
    }
    // Texto lateral de subida ("documentos adjuntos") o cierre de lote ("listo")
    // en ruta interna: asociar al caso interno que está recabando documentos,
    // sin pedir aclaración multi-caso ni delegar al LLM.
    if (!conversationalCase) {
      const uploadReply = await resolveInternalDocumentMessageCase({
        db,
        message: agentMessageText,
        pendingBindings: routingBindings,
      });
      if (uploadReply.matchedCase) {
        conversationalCase = uploadReply.matchedCase;
        internalDocumentTextReason = uploadReply.reason;
      }
    }
    // Respuesta esperada de características: resolver antes del routing
    // genérico para evitar aclaración multi-caso innecesaria.
    if (!conversationalCase) {
      const characteristicsReply = await resolveCharacteristicsReplyAgainstBindings({
        db,
        message: agentMessageText,
        pendingBindings: routingBindings,
      });
      if (characteristicsReply.matchedCase) {
        conversationalCase = characteristicsReply.matchedCase;
      }
    }
    if (!conversationalCase && !forceNewConversationalCase) {
      // Paridad web: con bindings activos, cargar el hilo reciente para no
      // confundir continuaciones analíticas ("y en julio?", "dame los leads
      // de junio") con un caso operativo pendiente.
      const recentMessagesForRouting =
        routingBindings.length > 0
          ? await getSessionMessages(db, session.id, 8)
          : undefined;
      const routeResult = await routeConversationalMessageAgainstBindings({
        db,
        channel: "telegram",
        message: agentMessageText,
        pendingBindings: routingBindings,
        explicitIntent: explicitPropertyIntent,
        candidateCasesById: routingCasesById,
        recentMessages: recentMessagesForRouting,
        hasAttachments: Boolean(inboundMedia),
      });
      if (routeResult.route === "clarify") {
        // Salvaguarda: si el mensaje trae archivo, NUNCA cortamos con clarify
        // (el archivo se perdería). La ingestión documental de abajo lo maneja.
        if (!inboundMedia) {
          await sendTelegramProductMessage(
            chatId,
            routeResult.responseText,
            routeResult.telegramReplyMarkup
          );
          return NextResponse.json({
            ok: true,
            routed: "clarification_requested",
          });
        }
      }
      if (routeResult.route === "case") {
        conversationalCase = routeResult.case;
      }
    }
  }

  if (!conversationalCase && text && deterministicPropertyIntent) {
    console.warn(
      "[telegram-webhook] deterministic property intent without routable case; forcing deterministic ensure",
      {
        raw_bindings_count: pendingBindings.length,
        routable_bindings_count: routingBindings.length,
        force_new_requested: forceNewConversationalCase,
        active_e2e_session_id: activeE2ELabSession?.id ?? null,
      }
    );
    try {
      const forcedEnsure = await ensureConversationalCase(db, {
        userId,
        caseType: "property_optioning",
        channel: "telegram",
        chatId,
        e2eControlled: Boolean(activeE2ELabSession),
        labTelegramChatId: activeE2ELabSession ? chatId : undefined,
        forceNew: true,
      });
      conversationalCase = forcedEnsure?.case ?? null;
      if (conversationalCase) {
        await upsertConversationBinding(db, {
          userId,
          caseId: conversationalCase.id,
          caseType: conversationalCase.case_type,
          channel: "telegram",
          chatId,
          sessionId: session.id,
          status: "awaiting_user",
          awaitingFields:
            (conversationalCase.context_jsonb?.missing_required as unknown[]) ?? [],
          metadata: { source: "telegram_webhook_intent_fallback_forced" },
        });
      }
    } catch (fallbackEnsureError) {
      console.error(
        "[telegram-webhook] deterministic fallback ensure failed:",
        fallbackEnsureError
      );
    }
  }

  // En laboratorio E2E sólo cableamos chat externo cuando el caso realmente
  // está en ruta "external_contact". En flujos internos no se debe contaminar
  // `external_contact_jsonb`, para evitar fallbacks incorrectos en contrato.
  if (
    conversationalCase &&
    conversationalCase.context_jsonb?.e2e_controlled === true &&
    operationalCaseDocumentRequestTargetFromContext(
      conversationalCase.context_jsonb
    ) === "external_contact"
  ) {
    try {
      conversationalCase = await ensureConversationalE2ELabExternalContact(
        db,
        conversationalCase,
        chatId
      );
    } catch (err) {
      console.error(
        "[telegram-webhook] failed to wire E2E external contact:",
        err
      );
    }
  }

  if (!conversationalCase && inboundMedia) {
    if (activeE2ELabSessionCaseId) {
      const sessionCase = await getOperationalCase(db, activeE2ELabSessionCaseId);
      if (
        isUsableE2ELabSessionCase({
          opCase: sessionCase,
          userId,
          caseType: "property_optioning",
        }) &&
        sessionCase &&
        (sessionCase.current_step === "awaiting_documents" ||
          sessionCase.current_step === "documents_received" ||
          sessionCase.current_step === "photos_requested")
      ) {
        conversationalCase = sessionCase;
      }
    }
    if (!conversationalCase) {
      const mediaCase = await resolveInternalDocumentUploadCaseForMedia({
        db,
        pendingBindings: routingBindings,
      });
      if (mediaCase) conversationalCase = mediaCase;
    }
  }

  if (inboundMedia && conversationalCase) {
    const caseContext = (conversationalCase.context_jsonb ?? {}) as Record<
      string,
      unknown
    >;
    const contractReviewContext =
      caseContext.contract_review &&
      typeof caseContext.contract_review === "object" &&
      !Array.isArray(caseContext.contract_review)
        ? (caseContext.contract_review as Record<string, unknown>)
        : null;
    const waitingRevisionUpload =
      conversationalCase.current_step === "contract_pending" &&
      conversationalCase.status === "waiting_internal" &&
      contractReviewContext?.status === "awaiting_revision_upload";

    if (waitingRevisionUpload) {
      const fileInfo = await getTelegramFile(inboundMedia.fileId);
      if (!fileInfo.file_path) {
        throw new Error("telegram_file_path_missing");
      }
      const extension = documentExtensionFromPath(
        fileInfo.file_path,
        inboundMedia.fallbackExtension
      );
      const allowedExtensions = new Set(["pdf", "doc", "docx"]);
      if (!allowedExtensions.has(extension)) {
        await sendTelegramMessage(
          chatId,
          "Para enviar el contrato corregido necesito un archivo DOCX o PDF."
        );
        return NextResponse.json({
          ok: true,
          routed: "operational_case_contract_revision_upload_invalid_type",
          case_id: conversationalCase.id,
        });
      }
      const bytes = Buffer.from(await downloadTelegramFile(fileInfo.file_path));
      const ingested = await ingestCaseDocument({
        db,
        caseId: conversationalCase.id,
        userId: conversationalCase.user_id,
        source: "advisor_telegram",
        fileName: inboundMedia.originalName,
        contentType: inboundMedia.contentType,
        bytes,
        captionText: text || null,
        extension,
        fileSizeBytes: inboundMedia.fileSize ?? bytes.byteLength,
        sourceMetadata: {
          message_id: message.message_id,
          from: message.from,
          telegram_file_id: inboundMedia.fileId,
          telegram_file_unique_id: inboundMedia.uniqueId,
          caption: text || null,
          source: "advisor_telegram",
          purpose: "contract_revision_upload",
        },
      });
      const sent = await handleContractRevisionUploadAndSend(db, {
        userId,
        caseId: conversationalCase.id,
        storagePath: ingested.document.storage_path,
        storageBucket: ingested.document.storage_bucket,
        fileName: inboundMedia.originalName,
        deferControlledE2ETick: true,
      });
      await sendTelegramMessage(
        chatId,
        sent.ok
          ? sent.message ??
              "Contrato corregido recibido y enviado por email al propietario."
          : sent.message ??
              "Recibí el archivo, pero no pude enviarlo por email. Revisa Gmail y owner_email."
      );
      await maybeRunDeferredContractTick(db, sent);
      return NextResponse.json({
        ok: true,
        routed: sent.ok
          ? "operational_case_contract_revision_uploaded_and_sent"
          : "operational_case_contract_revision_uploaded_send_failed",
        case_id: conversationalCase.id,
      });
    }

    // Subida de documentos por el asesor ANTES de elegir destino: inferimos
    // ruta interna (los archivos llegan del propio chat del asesor). Paridad
    // con web via inferInternalDocumentTargetOnUpload.
    const inferredTarget = await inferInternalDocumentTargetOnUpload({
      db,
      opCase: conversationalCase,
      source: "telegram_webhook",
      reason: "advisor_uploaded_documents_before_choice",
      eventExtras: {
        message_id: message.message_id,
        media_group_id: message.media_group_id ?? null,
      },
    });
    conversationalCase = inferredTarget.opCase;
    const requestTarget = operationalCaseDocumentRequestTargetFromContext(
      conversationalCase.context_jsonb
    );
    const isInternalDocumentStep =
      requestTarget === "internal_user" &&
      (conversationalCase.current_step === "awaiting_documents" ||
        conversationalCase.current_step === "documents_received");
    const isInternalPhotosStep = conversationalCase.current_step === "photos_requested";
    if (isInternalDocumentStep || isInternalPhotosStep) {
      const fileInfo = await getTelegramFile(inboundMedia.fileId);
      if (!fileInfo.file_path) {
        throw new Error("telegram_file_path_missing");
      }
      const bytes = Buffer.from(await downloadTelegramFile(fileInfo.file_path));
      const ingested = await ingestCaseDocument({
        db,
        caseId: conversationalCase.id,
        userId: conversationalCase.user_id,
        source: "advisor_telegram",
        fileName: inboundMedia.originalName,
        contentType: inboundMedia.contentType,
        bytes,
        captionText: text || null,
        extension: documentExtensionFromPath(
          fileInfo.file_path,
          inboundMedia.fallbackExtension
        ),
        fileSizeBytes: inboundMedia.fileSize ?? bytes.byteLength,
        sourceMetadata: {
          message_id: message.message_id,
          from: message.from,
          telegram_file_id: inboundMedia.fileId,
          telegram_file_unique_id: inboundMedia.uniqueId,
          caption: text || null,
          source: "advisor_telegram",
        },
      });
      await insertOperationalCaseEvent(db, {
        caseId: conversationalCase.id,
        eventType: "external_response",
        actor: "user",
        payload: {
          kind: internalCaseMediaRegisteredKind(conversationalCase.current_step),
          source: "advisor_telegram",
          document_id: ingested.document.id,
          document_kind: ingested.document.kind,
          current_step: conversationalCase.current_step,
          step_key: conversationalCase.current_step,
          original_name: inboundMedia.originalName,
          message_id: message.message_id,
          media_group_id: message.media_group_id ?? null,
          telegram_file_unique_id: inboundMedia.uniqueId,
        },
      });
      console.info(
        isInternalPhotosStep
          ? "[telegram-webhook] internal photo ingested"
          : "[telegram-webhook] internal doc ingested",
        {
        caseId: conversationalCase.id,
        message_id: message.message_id,
        media_group_id: message.media_group_id ?? null,
        file_unique_id: inboundMedia.uniqueId,
        original_name: inboundMedia.originalName,
        kind: ingested.document.kind,
      });
      const photoResult = await appendRawPhoto({
        db,
        opCase: conversationalCase,
        ingested,
      });
      conversationalCase = photoResult.opCase;
      const markReadyFromCaption = Boolean(
        text &&
          looksLikeDocumentBatchComplete(text) &&
          (isInternalDocumentStep || isInternalPhotosStep)
      );
      if (message.media_group_id) {
        conversationalCase = await appendMediaGroupAckToCase({
          db,
          opCase: conversationalCase,
          chatId,
          mediaGroupId: message.media_group_id,
          file: {
            originalName: inboundMedia.originalName,
            kind: ingested.document.kind,
          },
          markReady: markReadyFromCaption,
        });
        const flush = await flushMediaGroupAcksForCase({
          db,
          opCase: conversationalCase,
          chatId,
          mediaGroupId: message.media_group_id,
          sendAck: async (files) => {
            await sendTelegramMessage(
              chatId,
              isInternalPhotosStep
                ? buildPhotoMediaGroupReceivedAck(files)
                : buildMediaGroupReceivedAck(files)
            );
          },
        });
        conversationalCase = flush.opCase;
        if (flush.markReady) {
          if (isInternalPhotosStep) {
            return await finalizeInternalPhotoBatch({
              db,
              caseId: conversationalCase.id,
              chatId,
              source: "telegram_internal_photos_marked_ready",
            });
          }
          return await finalizeInternalDocumentBatch({
            db,
            caseId: conversationalCase.id,
            chatId,
            source: "telegram_internal_documents_marked_ready",
          });
        }
        return NextResponse.json({
          ok: true,
          routed:
            flush.flushed > 0
              ? "operational_case_internal_document_registered_group_ack_flushed"
              : "operational_case_internal_document_registered_group_ack_queued",
          case_id: conversationalCase.id,
          photos_added: photoResult.photoAdded,
          photos_count: photoResult.photoCount,
        });
      }
      if (photoResult.photoAdded && isInternalPhotosStep) {
        await sendTelegramMarkdownMessage(
          chatId,
          photosUploadProgressAckText(photoResult.photoCount)
        );
        if (markReadyFromCaption) {
          return await finalizeInternalPhotoBatch({
            db,
            caseId: conversationalCase.id,
            chatId,
            source: "telegram_internal_photos_marked_ready",
          });
        }
        return NextResponse.json({
          ok: true,
          routed: "operational_case_internal_photo_registered",
          case_id: conversationalCase.id,
          photos_count: photoResult.photoCount,
        });
      }
      await sendTelegramMessage(
        chatId,
        buildDocumentReceivedAck({
          originalName: inboundMedia.originalName,
          kind: ingested.document.kind,
          channel: "telegram",
        })
      );
      if (markReadyFromCaption) {
        if (isInternalPhotosStep) {
          return await finalizeInternalPhotoBatch({
            db,
            caseId: conversationalCase.id,
            chatId,
            source: "telegram_internal_photos_marked_ready",
          });
        }
        return await finalizeInternalDocumentBatch({
          db,
          caseId: conversationalCase.id,
          chatId,
          source: "telegram_internal_documents_marked_ready",
        });
      }
      return NextResponse.json({
        ok: true,
        routed: "operational_case_internal_document_registered",
        case_id: conversationalCase.id,
      });
    }
  }

  // "listo" como texto suelto en ruta interna (sin adjunto en este mensaje):
  // completar el lote de forma determinística, igual que web chat, sin pasar
  // por el LLM ni por el camino del responder externo.
  if (
    agentMessageText &&
    conversationalCase &&
    (looksLikeDocumentBatchComplete(agentMessageText) ||
      internalDocumentTextReason === "batch_complete") &&
    conversationalCase.current_step === "photos_requested"
  ) {
    return await finalizeUploadBatchAfterSettling({
      db,
      caseId: conversationalCase.id,
      chatId,
      source: "telegram_internal_photos_marked_ready",
    });
  }

  if (
    agentMessageText &&
    conversationalCase &&
    (looksLikeDocumentBatchComplete(agentMessageText) ||
      internalDocumentTextReason === "batch_complete") &&
    (conversationalCase.current_step === "awaiting_documents" ||
      conversationalCase.current_step === "documents_received") &&
    operationalCaseDocumentRequestTargetFromContext(
      conversationalCase.context_jsonb
    ) === "internal_user"
  ) {
    const flush = await flushMediaGroupAcksForCase({
      db,
      opCase: conversationalCase,
      chatId,
      sendAck: async () => {
        // Avoid double ack with finalizeInternalDocumentBatch message.
      },
      force: true,
    });
    conversationalCase = flush.opCase;
    return await finalizeInternalDocumentBatch({
      db,
      caseId: conversationalCase.id,
      chatId,
      source: "telegram_internal_documents_marked_ready",
    });
  }

  // Texto lateral de subida ("documentos adjuntos") en ruta interna mientras se
  // recaban documentos: acuse suave y cortar, sin delegar al LLM (evita que el
  // agente liste documentos o pida de nuevo la decisión).
  if (
    agentMessageText &&
    !inboundMedia &&
    conversationalCase &&
    (looksLikeDocumentUploadSideText(agentMessageText) ||
      internalDocumentTextReason === "upload_side_text") &&
    (conversationalCase.current_step === "awaiting_documents" ||
      conversationalCase.current_step === "photos_requested") &&
    (conversationalCase.current_step === "photos_requested" ||
      operationalCaseDocumentRequestTargetFromContext(
        conversationalCase.context_jsonb
      ) === "internal_user")
  ) {
    const flush = await flushMediaGroupAcksForCase({
      db,
      opCase: conversationalCase,
      chatId,
      sendAck: async (files) => {
        await sendTelegramMessage(chatId, buildMediaGroupReceivedAck(files));
      },
    });
    conversationalCase = flush.opCase;
    if (flush.flushed > 0) {
      return NextResponse.json({
        ok: true,
        routed: "operational_case_internal_group_ack_flushed_on_side_text",
        case_id: conversationalCase.id,
      });
    }
    await sendTelegramMessage(
      chatId,
      conversationalCase.current_step === "photos_requested"
        ? 'Ya registré los archivos que me llegaron. Cuando termines de enviar todas las fotos, escribe «listo».'
        : 'Ya registré los archivos que me llegaron. Cuando termines de enviar todo lo disponible, escribe «listo» para procesarlos.'
    );
    return NextResponse.json({
      ok: true,
      routed: "operational_case_internal_upload_side_text",
      case_id: conversationalCase.id,
    });
  }

  // Respuesta del asesor interno a la solicitud de características mínimas. El
  // responder externo (waiting_external) nunca alcanza casos waiting_internal,
  // así que esta es la entrada simétrica para la ruta interna: reutiliza el
  // mismo procesamiento determinístico en vez de delegar al LLM (que intentaría
  // operational_case_update_intake fuera de intake).
  if (
    agentMessageText &&
    !inboundMedia &&
    conversationalCase &&
    (await shouldProcessInternalCharacteristicsReply({
      db,
      opCase: conversationalCase,
      text: agentMessageText,
    }))
  ) {
    conversationalCase = await processCharacteristicsReply({
      db,
      opCase: conversationalCase,
      chatId,
      text: agentMessageText,
    });
    return NextResponse.json({
      ok: true,
      routed: "operational_case_internal_characteristics_processing",
      case_id: conversationalCase.id,
    });
  }

  if (agentMessageText && conversationalCase) {
    if (
      !inboundMedia &&
      conversationalCase.current_step === "awaiting_documents" &&
      operationalCaseDocumentRequestTargetFromContext(
        conversationalCase.context_jsonb
      ) === "internal_user"
    ) {
      const flush = await flushMediaGroupAcksForCase({
        db,
        opCase: conversationalCase,
        chatId,
        sendAck: async (files) => {
          await sendTelegramMessage(chatId, buildMediaGroupReceivedAck(files));
        },
      });
      conversationalCase = flush.opCase;
    }

    const intakeTurn = await resolveConversationalIntakeTurn({
      db,
      userId,
      sessionId: session.id,
      opCase: conversationalCase,
      message: agentMessageText,
      channel: "telegram",
      justCreated: false,
      chatId,
    });
    if (intakeTurn.handled) {
      conversationalCase = intakeTurn.updatedCase;
      if (intakeTurn.responseText) {
        await sendTelegramMarkdownMessage(chatId, intakeTurn.responseText);
      }
      if (intakeTurn.shouldRunPostIntakeE2ETick) {
        try {
          await maybeRunPostIntakeConversationalE2ETick({
            db,
            opCase: conversationalCase,
            userId,
            channel: "telegram",
            chatId,
          });
        } catch (tickError) {
          console.error(
            "[telegram-webhook] deterministic post-intake E2E tick failed:",
            tickError
          );
          await sendTelegramMessage(
            chatId,
            "El intake quedó completo, pero no pude ejecutar automáticamente la solicitud de documentos. Revisa el laboratorio E2E e intenta la revisión manual."
          );
        }
      }
      return NextResponse.json({
        ok: true,
        routed: TELEGRAM_INTAKE_ROUTED[intakeTurn.route],
        case_id: conversationalCase.id,
      });
    }

    // Decisión interno/externo del asesor (paridad con web chat): manejar de
    // forma determinística antes de delegar al LLM, para persistir
    // document_request_target y evitar que el tick E2E vuelva a preguntar.
    conversationalCase = intakeTurn.updatedCase;
    const choice = await applyDocumentRequestTargetChoice({
      db,
      opCase: conversationalCase,
      message: agentMessageText,
      channel: "telegram",
    });
    if (choice.handled) {
      conversationalCase = choice.updatedCase;
      if (choice.shouldRunPostChoiceE2ETick) {
        try {
          await maybeRunPostIntakeConversationalE2ETick({
            db,
            opCase: conversationalCase,
            userId,
            channel: "telegram",
            chatId,
          });
        } catch (tickError) {
          console.error(
            "[telegram-webhook] post-choice E2E tick failed:",
            tickError
          );
        }
      }
      if (choice.externalContactSetupToken) {
        const deepLink = await buildExternalContactDeepLink(
          choice.externalContactSetupToken
        );
        await sendTelegramMessage(
          chatId,
          buildExternalContactSetupMessage({ deepLink })
        );
        return NextResponse.json({
          ok: true,
          routed: "operational_case_external_contact_setup_requested",
          case_id: conversationalCase.id,
        });
      }
      await sendTelegramMarkdownMessage(chatId, choice.responseText);
      return NextResponse.json({
        ok: true,
        routed: "operational_case_document_target_set",
        case_id: conversationalCase.id,
      });
    }
  }

  if (!conversationalCase && text && deterministicPropertyIntent) {
    console.error(
      "[telegram-webhook] deterministic property intent unresolved; aborting LLM fallback",
      {
        raw_bindings_count: pendingBindings.length,
        routable_bindings_count: routingBindings.length,
        force_new_requested: forceNewConversationalCase,
        active_e2e_session_id: activeE2ELabSession?.id ?? null,
      }
    );
    await sendTelegramMessage(
      chatId,
      "No pude resolver el caso operativo de forma determinística en este momento. Intenta de nuevo en unos segundos para iniciar el intake."
    );
    return NextResponse.json({
      ok: true,
      routed: "operational_case_deterministic_routing_failed",
    });
  }

  // Recuperaciones channel-agnostic (paridad web): contract_pending / package_ready.
  if (conversationalCase?.id && text) {
    try {
      const contractRecovery = await maybeRecoverContractPendingTurn({
        db,
        userId,
        caseId: conversationalCase.id,
        channel: "telegram",
        message: text,
      });
      if (contractRecovery.handled) {
        await sendTelegramMarkdownMessage(chatId, contractRecovery.responseText);
        return NextResponse.json({
          ok: true,
          routed: "operational_case_contract_pending_recovery",
          case_id: conversationalCase.id,
        });
      }
      const packageRecovery = await maybeRecoverPackageReadyContinue({
        db,
        userId,
        caseId: conversationalCase.id,
        channel: "telegram",
        message: text,
      });
      if (packageRecovery.handled) {
        await sendTelegramMarkdownMessage(chatId, packageRecovery.responseText);
        return NextResponse.json({
          ok: true,
          routed: "operational_case_package_ready_continue",
          case_id: conversationalCase.id,
        });
      }
    } catch (recoveryError) {
      console.error(
        "[telegram-webhook] operational recovery failed:",
        recoveryError
      );
    }
  }

  // Catch-up de memoria larga ANTES de runAgent. Ver comentario equivalente
  // en `apps/web/src/app/api/chat/route.ts`. En callbacks (resume HITL) NO
  // se ejecuta — ese branch sale mucho antes.
  const webhookClaimState = await claimTelegramWebhookUpdate({
    db,
    updateId: update.update_id,
    userId,
    chatId,
    messageId: message.message_id,
  });
  if (webhookClaimState !== "claimed") {
    return NextResponse.json({
      ok: true,
      routed:
        webhookClaimState === "duplicate_completed"
          ? "telegram_duplicate_update_completed"
          : "telegram_duplicate_update_in_progress",
    });
  }

  await maybeCatchUpFlush({
    db,
    userId,
    sessionId: session.id,
    channel: "telegram",
  });

  const conversationalCaseBeforeAgent = conversationalCase;
  let processedTurnId: string | null = null;

  try {
    const runtimeTurnId = randomUUID();
    let runtimeInput: AgentRuntimeInput | undefined;
    if (inboundMedia) {
      try {
        const fileInfo = await getTelegramFile(inboundMedia.fileId);
        if (!fileInfo.file_path) {
          throw new Error("telegram_file_path_missing");
        }
        const bytes = new Uint8Array(
          await downloadTelegramFile(fileInfo.file_path)
        );
        const stored = await ingestGenericAttachment({
          db,
          userId,
          fileName: inboundMedia.originalName,
          mimeType: inboundMedia.contentType,
          bytes,
          channel: "telegram",
          source: "external_copy",
          metadata: {
            source: "telegram_inbound",
            telegram_message_id: message.message_id,
            telegram_file_id: inboundMedia.fileId,
            telegram_file_unique_id: inboundMedia.uniqueId,
          },
        });
        runtimeInput = await resolveAttachmentRuntimeInput({
          db,
          userId,
          sessionId: session.id,
          turnId: runtimeTurnId,
          channel: "telegram",
          envelopes: [stored.envelope],
        });
        if (!agentMessageText) {
          agentMessageText = `Analiza el archivo adjunto «${inboundMedia.originalName}» según la habilidad aplicable.`;
        }
      } catch (error) {
        if (
          error instanceof AttachmentRuntimeError &&
          error.code.startsWith("attachment_validation:")
        ) {
          await sendTelegramMessage(
            chatId,
            error.code.endsWith("legacy_xls_parser_unsafe")
              ? "Los archivos .xls antiguos no están habilitados porque el parser disponible no cumple el estándar de seguridad. Convierte el archivo a .xlsx."
              : "No pude aceptar ese archivo. Usa PDF, DOCX, PPTX, XLSX, TXT, CSV, JSON, XML, HTML, YAML o una imagen compatible de hasta 25 MB."
          );
          return NextResponse.json({
            ok: true,
            routed: "generic_attachment_rejected",
            reason: error.code,
          });
        }
        throw error;
      }
    }
    const result = await withTypingHeartbeat(chatId, () =>
      runAgent({
        message: agentMessageText,
        turnId: runtimeTurnId,
        userId,
        sessionId: session.id,
        systemPrompt:
          profile?.agent_system_prompt ?? "Eres un asistente útil.",
        db,
        enabledTools: (toolSettings ?? []).map(
          (t: Record<string, unknown>) => ({
            id: t.id as string,
            user_id: t.user_id as string,
            tool_id: t.tool_id as string,
            enabled: t.enabled as boolean,
            config_json: (t.config_json as Record<string, unknown>) ?? {},
          })
        ),
        enabledSkills: (skillSettings ?? []).map(
          (s: Record<string, unknown>) => ({
            id: s.id as string,
            user_id: s.user_id as string,
            skill_id: s.skill_id as string,
            enabled: s.enabled as boolean,
            config_json: (s.config_json as Record<string, unknown>) ?? {},
          })
        ),
        integrations: (integrations ?? []).map(
          (i: Record<string, unknown>) => ({
            id: i.id as string,
            user_id: i.user_id as string,
            provider: i.provider as string,
            scopes: (i.scopes as string[]) ?? [],
            status: i.status as "active" | "revoked" | "expired",
            created_at: i.created_at as string,
          })
        ),
        githubToken,
        userTimezone: profile?.timezone as string | undefined,
        userName: (profile?.name as string | null) ?? null,
        userEmail: (profile?.email as string | null) ?? null,
        userPhone: (profile?.phone as string | null) ?? null,
        businessBrain:
          (profile?.business_brain as Record<string, unknown> | null) ?? {},
        isUnggaAdmin: (profile?.is_ungga_admin as boolean | null) ?? false,
        channel: "telegram",
        googleCalendarAccessToken,
        caseId: conversationalCase?.id,
        toolApprovalPolicy:
          buildTelegramOperationalCaseToolApprovalPolicy(conversationalCase),
        runtimeInput,
      })
    );
    processedTurnId = result.turnId ?? null;

    if (result.pendingConfirmation) {
      const pc = result.pendingConfirmation;
      await sendTelegramMessage(chatId, pc.message, {
        inline_keyboard: [
          [
            {
              text: "✅ Aprobar",
              callback_data: `approve:${pc.toolCallId}`,
            },
            {
              text: "❌ Cancelar",
              callback_data: `reject:${pc.toolCallId}`,
            },
          ],
        ],
      });
    } else {
      const refreshedConversationalCase = conversationalCaseBeforeAgent
        ? await getOperationalCase(db, conversationalCaseBeforeAgent.id)
        : null;
      const intakeCompletedThisTurn = intakeJustCompleted(
        conversationalCaseBeforeAgent,
        refreshedConversationalCase
      );

      // Confirmar intake ANTES del tick que solicita documentos: el tick envía
      // telegram_send_message_to_contact y ese mensaje debe ir después.
      if (intakeCompletedThisTurn && refreshedConversationalCase) {
        await sendTelegramMessage(
          chatId,
          buildTelegramIntakeCompletionMessage(refreshedConversationalCase)
        );
      }

      if (conversationalCase?.context_jsonb?.e2e_controlled === true) {
        try {
          await maybeRunPostIntakeConversationalE2ETick({
            db,
            opCase: conversationalCase,
            userId,
            channel: "telegram",
            chatId,
          });
        } catch (tickError) {
          console.error(
            "[telegram-webhook] post-intake conversational E2E tick failed:",
            tickError
          );
          await sendTelegramMessage(
            chatId,
            intakeCompletedThisTurn
              ? "No pude solicitar los documentos automáticamente; usa «Revisar avance de caso» en el laboratorio E2E."
              : "El intake quedó completo, pero no pude ejecutar automáticamente la solicitud de documentos. Revisa el laboratorio E2E e intenta la revisión manual."
          );
        }
      }

      if (
        !intakeCompletedThisTurn &&
        shouldSendTelegramAgentResponse({
          response: result.response,
          toolCalls: result.toolCalls,
          hasConversationalCase: Boolean(conversationalCaseBeforeAgent),
        })
      ) {
        await sendTelegramMarkdownMessage(chatId, result.response);
      }

      // Paridad web: invariants post-agente en el mismo turno (no solo cron).
      void finalizePropertyOptioningAgentTurn({
        db,
        caseId: conversationalCaseBeforeAgent?.id ?? conversationalCase?.id,
        source: "telegram_webhook_post_agent",
        hasPendingConfirmation: false,
      });

      // Flush POST fire-and-forget: solo si el turno cerró limpio.
      // Callbacks (resume HITL) no entran aquí — ese branch retorna antes.
      fireAndForgetFlush({
        db,
        userId,
        sessionId: session.id,
        memoryFlushPending: result.memoryFlushPending,
      });
    }
  } catch (error) {
    console.error("Telegram agent error:", error);
    await sendTelegramMessage(
      chatId,
      "Hubo un error procesando tu mensaje. Intenta de nuevo."
    );
  } finally {
    await completeTelegramWebhookUpdate({
      db,
      updateId: update.update_id,
      turnId: processedTurnId,
    });
  }

  return NextResponse.json({ ok: true });
}
