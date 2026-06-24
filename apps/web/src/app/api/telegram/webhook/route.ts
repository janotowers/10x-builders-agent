import { NextResponse } from "next/server";
import {
  createServerClient,
  decryptToken,
  findLatestConversationalOperationalCase,
  findPendingConversationBindings,
  getConversationBindingForCase,
  setConversationBindingStatus,
  getPendingToolCall,
  getGoogleCalendarAccessToken,
  associateExternalResponseWithCase,
  countPendingToolCallsForCase,
  findOperationalCaseByExternalChatId,
  getOperationalCase,
  getRecentOperationalCaseEvents,
  getActiveE2ELabSession,
  getTelegramChatId,
  insertOperationalCaseEvent,
  listInternalUserNotifications,
  linkE2ELabSessionToCase,
  resolveUnreadInternalNotificationsByKindForCaseWithReminders,
  shortOperationalCaseId,
  updateOperationalCase,
  updateToolCallStatus,
  upsertConversationBinding,
} from "@agents/db";
import {
  evaluatePropertyDataMinimumsForReview,
  isPropertyOptioningIntent,
  runAgent,
} from "@agents/agent";
import { extractOwnerCharacteristics } from "@/lib/operational-cases/owner-characteristics-extraction";
import {
  downloadTelegramFile,
  getTelegramFile,
  sendTelegramMessage,
  withTypingHeartbeat,
} from "@/lib/telegram/send-message";
import { maybeCatchUpFlush, fireAndForgetFlush } from "@/lib/memory/trigger";
import { ensureAgentToolDepsWired } from "@/lib/agent/wire-tool-deps";
import { parsePriceApprovalDecision } from "@/lib/business-decisions/price-approval";
import { parseContractReviewDecision } from "@/lib/business-decisions/contract-review";
import { businessDecisionHandler } from "@/lib/business-decisions/registry";
import { handlePropertyDataReviewDecision } from "@/lib/business-decisions/property-data-review";
import {
  looksLikeNewCaseIntent,
  shouldForceNewConversationalCaseOnExplicitStartIntent,
} from "@/lib/operational-cases/conversational-case-routing";
import {
  resolveConversationalClarificationReply,
  resolveRoutableConversationBindings,
  routeConversationalMessageAgainstBindings,
} from "@/lib/operational-cases/conversational-routing-orchestrator";
import {
  documentExtensionFromPath,
  ingestCaseDocument,
  type CaseDocumentPayload,
} from "@/lib/operational-cases/case-document-ingestion";
import { ensureConversationalCase } from "@/lib/operational-cases/ensure-conversational-case";
import { buildTelegramOperationalCaseToolApprovalPolicy } from "@/lib/operational-cases/telegram-operational-case-tool-policy";
import type { OperationalCase } from "@agents/types";
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
} from "@/lib/operational-cases/telegram-intake-completion-message";
import { classifyOperationalConversationMessage } from "@/lib/operational-cases/operational-conversation-classifier";
import { syncIntakeFieldsFromPropertyData } from "@/lib/operational-cases/parse-owner-characteristics";
import { processCharacteristicsReplyDeterministically } from "@/lib/operational-cases/characteristics-response";
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
  buildCaseDocumentRequestTargetPrompt,
  parseCaseDocumentRequestTargetChoice,
  resolveCharacteristicsReplyAgainstBindings,
  resolveDocumentTargetReplyAgainstBindings,
  resolveInternalDocumentMessageCase,
  resolveInternalDocumentUploadCaseForMedia,
  setCaseDocumentRequestTarget,
  shouldPromptCaseDocumentRequestTarget,
} from "@/lib/operational-cases/document-request-target";
import {
  isUsableE2ELabSessionCase,
} from "@/lib/operational-cases/e2e-lab-routing-isolation";
import {
  beginExternalContactLink,
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
  buildDocumentReceivedAck,
  buildMediaGroupReceivedAck,
  looksLikeDocumentUploadSideText,
} from "@/lib/operational-cases/case-document-collection";
import {
  appendMediaGroupAckToCase,
  flushMediaGroupAcksForCase,
} from "@/lib/operational-cases/telegram-media-group-ack-store";

const TELEGRAM_INTAKE_ROUTED: Record<ConversationalIntakeRoute, string> = {
  intake_missing_fields_requested: "operational_case_intake_missing_fields",
  intake_reopen_blocked: "operational_case_intake_reopen_blocked",
  intake_still_missing: "operational_case_intake_still_missing",
  intake_updated_incomplete: "operational_case_intake_updated_incomplete",
  intake_completed: "operational_case_intake_completed",
  delegate_to_agent: "operational_case_intake_delegate_to_agent",
};

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";
const TOOL_CONFIRMATION_PENDING_KIND = "tool_confirmation_pending";

function toolCallCaseId(toolCall: {
  arguments_json?: unknown;
  metadata_jsonb?: unknown;
}): string | null {
  const args = toolCall.arguments_json;
  if (
    args &&
    typeof args === "object" &&
    !Array.isArray(args) &&
    typeof (args as Record<string, unknown>).case_id === "string"
  ) {
    const caseId = ((args as Record<string, unknown>).case_id as string).trim();
    if (caseId) return caseId;
  }
  const metadata = toolCall.metadata_jsonb;
  if (
    metadata &&
    typeof metadata === "object" &&
    !Array.isArray(metadata) &&
    typeof (metadata as Record<string, unknown>).case_id === "string"
  ) {
    const caseId = ((metadata as Record<string, unknown>).case_id as string).trim();
    if (caseId) return caseId;
  }
  return null;
}

async function finalizeCaseAfterToolDecision(
  db: ReturnType<typeof createServerClient>,
  params: {
    toolCall: { arguments_json?: unknown; metadata_jsonb?: unknown };
    userId: string;
  }
) {
  const caseId = toolCallCaseId(params.toolCall);
  if (!caseId) return;
  const pending = await countPendingToolCallsForCase(db, caseId);
  if (pending > 0) return;

  await resolveUnreadInternalNotificationsByKindForCaseWithReminders(db, {
    userId: params.userId,
    caseId,
    kind: TOOL_CONFIRMATION_PENDING_KIND,
    status: "actioned",
  });

  const opCase = await getOperationalCase(db, caseId);
  if (
    !opCase ||
    opCase.user_id !== params.userId ||
    !["active", "waiting_internal", "waiting_external"].includes(opCase.status)
  ) {
    return;
  }
  await updateOperationalCase(db, opCase.id, opCase.version, {
    nextActionAt: new Date().toISOString(),
  });
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
 * ¿El caso está esperando que el dueño (externo) o el asesor (interno) respondan
 * los campos mínimos de características que el sistema pidió?
 *
 * Simétrico por ruta: el invariante post-agente emite `characteristics_pending`
 * al contacto externo (`waiting_external`) o `characteristics_pending_internal`
 * al asesor (`waiting_internal`). Reconocer ambos es lo que permite procesar la
 * respuesta de forma determinística en cualquier ruta, sin delegar al LLM.
 */
async function isAwaitingCharacteristicsResponse(
  db: ReturnType<typeof createServerClient>,
  opCase: OperationalCase
) {
  if (opCase.current_step !== "documents_received") return false;
  let expectedPurpose: string;
  if (opCase.status === "waiting_external") {
    expectedPurpose = "characteristics_pending";
  } else if (opCase.status === "waiting_internal") {
    expectedPurpose = "characteristics_pending_internal";
  } else {
    return false;
  }
  const events = await getRecentOperationalCaseEvents(db, opCase.id, 20);
  return events.some((event) => {
    const payload = event.payload_jsonb;
    return (
      event.event_type === "reminder_sent" &&
      payload &&
      typeof payload === "object" &&
      (payload as Record<string, unknown>).purpose === expectedPurpose
    );
  });
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
 *   4. Dispara el tick E2E sólo si el caso es controlado; en producción el cron
 *      reanuda el caso con `next_action_at`.
 *
 * No duplica lógica de merge: reutiliza `mergeCharacteristicsOwnerResponseDeterministically`.
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
  const completion = await completeDocumentBatchForCase({
    db,
    caseId,
    channel: "telegram",
    source,
  });
  if (completion.status === "no_documents") {
    await sendTelegramMessage(
      chatId,
      "Aún no veo documentos registrados en el caso. Súbeme al menos uno y luego escribe «listo»."
    );
    return NextResponse.json({
      ok: true,
      routed: "operational_case_internal_documents_no_documents",
      case_id: caseId,
    });
  }
  if (completion.status === "failed") {
    await sendTelegramMessage(
      chatId,
      "Registré tu confirmación, pero no pude avanzar el caso en este momento. Inténtalo de nuevo en unos segundos."
    );
    return NextResponse.json({
      ok: true,
      routed: "operational_case_internal_documents_failed",
      case_id: caseId,
    });
  }
  await sendTelegramMessage(
    chatId,
    "Gracias, ya registré que terminaste de enviar documentos. Voy a procesarlos y te aviso el siguiente paso."
  );
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function derivePropertyTypeHint(
  context: Record<string, unknown>,
  propertyData: Record<string, unknown>
): string | null {
  const fromData = propertyData.property_type;
  if (typeof fromData === "string" && fromData.trim()) return fromData.trim();
  const fromContext = context.property_type;
  if (typeof fromContext === "string" && fromContext.trim()) {
    return fromContext.trim();
  }
  if (Array.isArray(fromContext)) {
    const first = fromContext.find(
      (value): value is string => typeof value === "string" && value.trim().length > 0
    );
    if (first) return first.trim();
  }
  return null;
}

/**
 * Merge an owner's free-form characteristics reply into the case.
 *
 * Interpretation is delegated to the reusable LLM structured extractor
 * (with a deterministic parser fallback); the case is always advanced to the
 * documents_received review point so the deterministic invariants decide
 * whether to request internal review or re-ask only the still-missing fields.
 */
async function mergeCharacteristicsOwnerResponseDeterministically(params: {
  db: ReturnType<typeof createServerClient>;
  opCase: OperationalCase;
  text: string;
  source: string;
  nextActionAt: string | null;
}): Promise<OperationalCase> {
  const currentContext = isRecord(params.opCase.context_jsonb)
    ? params.opCase.context_jsonb
    : {};
  const currentPropertyData = isRecord(currentContext.property_data)
    ? currentContext.property_data
    : {};

  const missingFields = evaluatePropertyDataMinimumsForReview(currentContext).missing;
  const extraction = await extractOwnerCharacteristics({
    text: params.text,
    propertyType: derivePropertyTypeHint(currentContext, currentPropertyData),
    missingFields,
    currentPropertyData,
  });
  const parsedKeys = Object.keys(extraction.patch);

  const propertyData = {
    ...currentPropertyData,
    ...extraction.patch,
  };
  const mergedContext = syncIntakeFieldsFromPropertyData(
    currentContext,
    propertyData
  );
  const updated = await updateOperationalCase(
    params.db,
    params.opCase.id,
    params.opCase.version,
    {
      status: "waiting_internal",
      currentStep: "documents_received",
      nextActionAt: params.nextActionAt,
      context: {
        ...mergedContext,
        owner_response_processed_at: new Date().toISOString(),
        owner_response_extraction_method: extraction.method,
        owner_response_extraction_confidence: extraction.confidence,
        owner_response_extraction_parsed_fields: parsedKeys,
        owner_response_extraction_unresolved: extraction.unresolved,
        ...(extraction.assumptions.length > 0
          ? { owner_response_extraction_assumptions: extraction.assumptions }
          : {}),
        ...(extraction.validationErrors
          ? { owner_response_extraction_validation_errors: extraction.validationErrors }
          : {}),
      },
    }
  );
  await insertOperationalCaseEvent(params.db, {
    caseId: params.opCase.id,
    eventType: "state_changed",
    actor: "system",
    payload: {
      kind: "owner_characteristics_merged",
      source: params.source,
      parsed_fields: parsedKeys,
      extraction_method: extraction.method,
      extraction_confidence: extraction.confidence,
      unresolved: extraction.unresolved,
    },
  });
  return updated ?? params.opCase;
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

async function answerCallbackQuery(callbackQueryId: string, text: string) {
  await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
    }
  );
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
    await finalizeCaseAfterToolDecision(db, { toolCall, userId });
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
    channel: "telegram",
    googleCalendarAccessToken,
  });
  await finalizeCaseAfterToolDecision(db, { toolCall, userId });

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
      await answerCallbackQuery(cb.id, "Datos inválidos");
      return NextResponse.json({ ok: true });
    }

    // Resolve user from telegram
    const { data: telegramAccount } = await db
      .from("telegram_accounts")
      .select("user_id")
      .eq("telegram_user_id", cb.from.id)
      .single();

    if (!telegramAccount) {
      await answerCallbackQuery(cb.id, "Cuenta no vinculada");
      return NextResponse.json({ ok: true });
    }

    const userId = telegramAccount.user_id as string;
    if (action === "price_approve" || action === "price_reject") {
      const result = await businessDecisionHandler("price_approval").handle(db, {
        userId,
        notificationId: targetId,
        text: action === "price_approve" ? "APROBAR PRECIO" : "RECHAZAR PRECIO",
      });
      await answerCallbackQuery(
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
      return NextResponse.json({
        ok: true,
        routed: "price_approval",
        notification_id: targetId,
      });
    }

    if (action === "price_adjust") {
      await answerCallbackQuery(cb.id, "Envia el ajuste para aprobar");
      await sendTelegramMessage(
        cb.message.chat.id,
        "Claro. Respondeme con los montos para ajustar y aprobar, por ejemplo:\nAJUSTAR PRECIO salida=23500 ideal=22000 minimo=18000"
      );
      return NextResponse.json({
        ok: true,
        routed: "price_adjust_guidance",
        notification_id: targetId,
      });
    }

    if (action === "contract_approve_send" || action === "contract_request_changes") {
      const result = await businessDecisionHandler("contract_review").handle(db, {
        userId,
        notificationId: targetId,
        text:
          action === "contract_approve_send"
            ? "mándalo al dueño"
            : "necesita cambios en el contrato",
      });
      await answerCallbackQuery(
        cb.id,
        result.ok
          ? action === "contract_approve_send"
            ? "Contrato enviado al dueño"
            : "Cambios registrados"
          : "No pude procesarlo"
      );
      await sendTelegramMessage(
        cb.message.chat.id,
        result.message ??
          (result.ok
            ? "Listo, procesé tu decisión sobre el contrato."
            : "No pude procesar la decisión del contrato.")
      );
      return NextResponse.json({
        ok: true,
        routed: "contract_review",
        notification_id: targetId,
      });
    }

    if (action === "property_data_confirm" || action === "property_data_correct") {
      if (action === "property_data_correct") {
        await answerCallbackQuery(cb.id, "Escribe la corrección");
        await sendTelegramMessage(
          cb.message.chat.id,
          "Perfecto. Envíame la corrección en texto, por ejemplo:\nTipo: Terreno · Operación: Venta · Zona: Bucerías"
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
      await answerCallbackQuery(
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

    if (action === "approve") {
      await answerCallbackQuery(cb.id, "✅ Aprobado");
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
      await answerCallbackQuery(cb.id, "❌ Cancelado");
      await sendTelegramMessage(cb.message.chat.id, "Acción cancelada.");
      await resumeAgentFromCallback(db, targetId, "reject");
    }

    return NextResponse.json({ ok: true });
  }

  const message = update.message;
  if (!message) {
    return NextResponse.json({ ok: true });
  }

  const telegramUserId = message.from.id;
  const chatId = message.chat.id;
  const text = (message.text ?? message.caption ?? "").trim();
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
        const parsedChoice = parseCaseDocumentRequestTargetChoice({
          opCase: refreshedCase,
          message: text,
        });
        if (parsedChoice.target) {
          let withTarget = await setCaseDocumentRequestTarget({
            db,
            opCase: refreshedCase,
            target: parsedChoice.target,
            decidedBy: "user",
          });
          const withStatus =
            (await updateOperationalCase(db, withTarget.id, withTarget.version, {
              status:
                parsedChoice.target === "external_contact" ? "active" : "waiting_internal",
              nextActionAt:
                parsedChoice.target === "external_contact" &&
                withTarget.context_jsonb?.e2e_controlled !== true
                  ? new Date().toISOString()
                  : null,
            })) ?? withTarget;
          withTarget = withStatus;
          if (
            parsedChoice.target === "external_contact" &&
            withTarget.context_jsonb?.e2e_controlled === true
          ) {
            try {
              await maybeRunPostIntakeConversationalE2ETick({
                db,
                opCase: withTarget,
                userId: withTarget.user_id,
                channel: "telegram",
              });
            } catch (tickError) {
              console.error(
                "[telegram-webhook] post-choice E2E tick failed:",
                tickError
              );
            }
          }
          await sendTelegramMessage(
            chatId,
            parsedChoice.target === "internal_user"
              ? "Perfecto: usaré ruta interna. Sube documentos por web o Telegram interno y confirma con «listo»."
              : "Perfecto: usaré ruta externa. Solicitaré los documentos al contacto propietario."
          );
          return NextResponse.json({
            ok: true,
            routed: "operational_case_document_target_set",
            case_id: matchedCase.id,
          });
        }
        if (parsedChoice.reason === "both_not_supported") {
          await sendTelegramMessage(
            chatId,
            "Por ahora el modo «ambos» aún no está habilitado. Elige una ruta: «interno» o «externo»."
          );
          return NextResponse.json({
            ok: true,
            routed: "operational_case_document_target_choice_needed",
            case_id: matchedCase.id,
          });
        }
        if (parsedChoice.reason === "external_unavailable") {
          const { token } = await beginExternalContactLink(db, refreshedCase);
          const deepLink = await buildExternalContactDeepLink(token);
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
        await sendTelegramMessage(
          chatId,
          buildCaseDocumentRequestTargetPrompt(refreshedCase)
        );
        return NextResponse.json({
          ok: true,
          routed: "operational_case_document_target_choice_needed",
          case_id: matchedCase.id,
        });
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
    limit: 10,
  });

  const parsedPriceDecision = parsePriceApprovalDecision(text);
  if (parsedPriceDecision.intent !== "unclear") {
    const pendingPriceApproval = pendingInternal.find(
      (notification) => notification.kind === "price_approval"
    );
    if (pendingPriceApproval) {
      const result = await businessDecisionHandler("price_approval").handle(db, {
        userId,
        notificationId: pendingPriceApproval.id,
        text,
      });
      await sendTelegramMessage(
        chatId,
        result.message ??
          (result.ok
            ? "Listo, procese tu decision de precio."
            : "No pude procesar la decision de precio.")
      );
      return NextResponse.json({
        ok: true,
        routed: "price_approval",
        notification_id: pendingPriceApproval.id,
      });
    }
  }

  const parsedContractDecision = parseContractReviewDecision(text);
  if (parsedContractDecision.intent !== "unclear") {
    const pendingContractReview = pendingInternal.find(
      (notification) =>
        notification.kind === "contract_review" ||
        notification.kind === "contract_pending"
    );
    if (pendingContractReview) {
      const result = await businessDecisionHandler("contract_review").handle(db, {
        userId,
        notificationId: pendingContractReview.id,
        text,
      });
      await sendTelegramMessage(
        chatId,
        result.message ??
          (result.ok
            ? "Listo, procesé tu decisión sobre el contrato."
            : "No pude procesar la decisión del contrato.")
      );
      return NextResponse.json({
        ok: true,
        routed: "contract_review",
        notification_id: pendingContractReview.id,
      });
    }
  }

  if (text) {
    const propertyDataReviewCandidates = (
      await Promise.all(
        pendingInternal
          .filter((notification) => notification.kind === "property_data_review")
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
  const pendingClarificationBinding = routingBindings.find(
    (binding) => binding.status === "clarification_needed"
  );
  if (pendingClarificationBinding && text) {
    const clarificationReply = await resolveConversationalClarificationReply({
      db,
      binding: pendingClarificationBinding,
      message: text,
    });
    if (clarificationReply.status === "invalid_index") {
      await sendTelegramMessage(chatId, clarificationReply.responseText);
      return NextResponse.json({
        ok: true,
        routed: "clarification_invalid_index",
      });
    }
    if (clarificationReply.status === "resolved_no") {
      await sendTelegramMessage(chatId, clarificationReply.responseText);
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
      (routingBindings.length === 0 || forceNewConversationalCase)
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
          }
        }
        const ensured = conversationalCase
          ? null
          : await ensureConversationalCase(db, {
              userId,
              caseType: "property_optioning",
              channel: "telegram",
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
              await sendTelegramMessage(chatId, firstPrompt.responseText);
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
      const routeResult = await routeConversationalMessageAgainstBindings({
        db,
        channel: "telegram",
        message: agentMessageText,
        pendingBindings: routingBindings,
        explicitIntent: explicitPropertyIntent,
        candidateCasesById: routingCasesById,
      });
      if (routeResult.route === "clarify") {
        // Salvaguarda: si el mensaje trae archivo, NUNCA cortamos con clarify
        // (el archivo se perdería). La ingestión documental de abajo lo maneja.
        if (!inboundMedia) {
          await sendTelegramMessage(chatId, routeResult.responseText);
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

  // En el laboratorio E2E el chat del operador hace de "contacto externo"
  // simulado: cuando luego suba documentos (con el caso en waiting_external),
  // el responder externo debe reconocer su chat_id. Persistimos ese chat_id en
  // el caso en cuanto lo asociamos a este chat —durante el intake, mucho antes
  // de waiting_external— para no depender del auto-advance ni de la sesión de
  // laboratorio. Sin esto, external_contact_jsonb queda vacío y los adjuntos
  // caen al flujo normal del agente ("Hubo un error…" / clarificación).
  if (
    conversationalCase &&
    conversationalCase.context_jsonb?.e2e_controlled === true
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
    const pendingTelegramBindings = await findPendingConversationBindings(db, {
      userId,
      channel: "telegram",
      chatId,
      statuses: ["awaiting_user", "clarification_needed"],
      limit: 5,
    });
    for (const binding of pendingTelegramBindings) {
      const candidate = await getOperationalCase(db, binding.case_id);
      if (!candidate || candidate.user_id !== userId) continue;
      if (
        candidate.current_step === "awaiting_documents" ||
        candidate.current_step === "documents_received"
      ) {
        conversationalCase = candidate;
        break;
      }
    }
  }

  if (inboundMedia && conversationalCase) {
    let requestTarget = operationalCaseDocumentRequestTargetFromContext(
      conversationalCase.context_jsonb
    );
    // Subida de documentos por el asesor ANTES de elegir destino: inferimos
    // ruta interna (los archivos llegan del propio chat del asesor) en vez de
    // re-preguntar interno/externo por cada archivo. Así la ingesta y el acuse
    // siguen la misma rama interna de abajo (acuse en bloque, sin repetir la
    // pregunta). El asesor puede cambiar a externo explícitamente más tarde.
    if (
      requestTarget == null &&
      shouldPromptCaseDocumentRequestTarget(conversationalCase) &&
      conversationalCase.current_step === "awaiting_documents"
    ) {
      const inferred = await setCaseDocumentRequestTarget({
        db,
        opCase: conversationalCase,
        target: "internal_user",
        decidedBy: "inferred",
      });
      conversationalCase =
        (await updateOperationalCase(db, inferred.id, inferred.version, {
          status: "waiting_internal",
        })) ?? inferred;
      await insertOperationalCaseEvent(db, {
        caseId: conversationalCase.id,
        eventType: "state_changed",
        actor: "system",
        payload: {
          kind: "document_request_target_inferred",
          source: "telegram_webhook",
          target: "internal_user",
          reason: "advisor_uploaded_documents_before_choice",
          message_id: message.message_id,
          media_group_id: message.media_group_id ?? null,
        },
      });
      requestTarget = "internal_user";
    }
    if (
      requestTarget === "internal_user" &&
      (conversationalCase.current_step === "awaiting_documents" ||
        conversationalCase.current_step === "documents_received")
    ) {
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
          kind: "document_registered",
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
      console.info("[telegram-webhook] internal doc ingested", {
        caseId: conversationalCase.id,
        message_id: message.message_id,
        media_group_id: message.media_group_id ?? null,
        file_unique_id: inboundMedia.uniqueId,
        original_name: inboundMedia.originalName,
        kind: ingested.document.kind,
      });
      const markReadyFromCaption = Boolean(
        text && looksLikeDocumentBatchComplete(text)
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
          sendAck: async (files) => {
            await sendTelegramMessage(chatId, buildMediaGroupReceivedAck(files));
          },
        });
        conversationalCase = flush.opCase;
        if (flush.markReady) {
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
    conversationalCase.current_step === "awaiting_documents" &&
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
    if (flush.flushed > 0) {
      return NextResponse.json({
        ok: true,
        routed: "operational_case_internal_group_ack_flushed_on_side_text",
        case_id: conversationalCase.id,
      });
    }
    await sendTelegramMessage(
      chatId,
      'Ya registré los archivos que me llegaron. Cuando termines de enviar todo lo disponible, escribe «listo» para procesarlos.'
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
    conversationalCase.current_step === "documents_received" &&
    conversationalCase.status === "waiting_internal" &&
    operationalCaseDocumentRequestTargetFromContext(
      conversationalCase.context_jsonb
    ) === "internal_user" &&
    !looksLikeDocumentBatchComplete(agentMessageText) &&
    (await isAwaitingCharacteristicsResponse(db, conversationalCase))
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
        await sendTelegramMessage(chatId, intakeTurn.responseText);
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
      await sendTelegramMessage(chatId, choice.responseText);
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

  // Catch-up de memoria larga ANTES de runAgent. Ver comentario equivalente
  // en `apps/web/src/app/api/chat/route.ts`. En callbacks (resume HITL) NO
  // se ejecuta — ese branch sale mucho antes.
  await maybeCatchUpFlush({
    db,
    userId,
    sessionId: session.id,
    channel: "telegram",
  });

  const conversationalCaseBeforeAgent = conversationalCase;

  try {
    const result = await withTypingHeartbeat(chatId, () =>
      runAgent({
        message: agentMessageText,
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
      })
    );

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

      let postIntakeAutoAdvanced = false;
      if (conversationalCase?.context_jsonb?.e2e_controlled === true) {
        try {
          postIntakeAutoAdvanced = await maybeRunPostIntakeConversationalE2ETick({
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

      if (!intakeCompletedThisTurn) {
        await sendTelegramMessage(chatId, result.response);
      }
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
  }

  return NextResponse.json({ ok: true });
}
