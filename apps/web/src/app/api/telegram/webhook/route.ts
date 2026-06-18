import { NextResponse } from "next/server";
import {
  createServerClient,
  decryptToken,
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
  insertOperationalCaseEvent,
  listInternalUserNotifications,
  linkE2ELabSessionToCase,
  resolveUnreadInternalNotificationsByKindForCaseWithReminders,
  resolveInternalNotificationWithReminders,
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
import { looksLikeNewCaseIntent } from "@/lib/operational-cases/conversational-case-routing";
import {
  resolveConversationalClarificationReply,
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
  resolveDocumentTargetReplyAgainstBindings,
  setCaseDocumentRequestTarget,
  shouldPromptCaseDocumentRequestTarget,
} from "@/lib/operational-cases/document-request-target";
import {
  completeDocumentBatchForCase,
  looksLikeDocumentBatchComplete,
} from "@/lib/operational-cases/document-batch-completion";

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

async function isAwaitingCharacteristicsResponse(
  db: ReturnType<typeof createServerClient>,
  opCase: OperationalCase
) {
  if (opCase.current_step !== "documents_received" || opCase.status !== "waiting_external") {
    return false;
  }
  const events = await getRecentOperationalCaseEvents(db, opCase.id, 20);
  return events.some((event) => {
    const payload = event.payload_jsonb;
    return (
      event.event_type === "reminder_sent" &&
      payload &&
      typeof payload === "object" &&
      (payload as Record<string, unknown>).purpose === "characteristics_pending"
    );
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
        if (
          candidate?.context_jsonb?.created_from === "agent_conversation" &&
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
          await sendTelegramMessage(
            chatId,
            "No veo un contacto externo verificado para este caso. Elige «interno», o primero registra un contacto externo válido."
          );
          return NextResponse.json({
            ok: true,
            routed: "operational_case_document_target_choice_needed",
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
          await sendTelegramMessage(
            chatId,
            "Gracias, ya registré la información adicional. La voy a procesar y te aviso el siguiente paso."
          );
          const caseForTick =
            await mergeCharacteristicsOwnerResponseDeterministically({
              db,
              opCase: refreshedCase,
              text,
              source: "telegram_webhook_characteristics_response",
              nextActionAt: null,
            });
          void runSettingsTestCaseAgentTick(
            db,
            caseForTick,
            caseForTick.user_id,
            {
              source:
                "telegram_webhook_conversational_e2e_characteristics_response",
              ownerResponseText: text,
            }
          ).catch((tickError) => {
            console.error(
              "[telegram-webhook] conversational E2E characteristics response tick failed:",
              tickError
            );
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
          const completion = await completeDocumentBatchForCase({
            db,
            caseId: refreshedCase.id,
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
        await mergeCharacteristicsOwnerResponseDeterministically({
          db,
          opCase: refreshedCase,
          text,
          source: "telegram_webhook_characteristics_response",
          nextActionAt: new Date().toISOString(),
        });
        await sendTelegramMessage(
          chatId,
          "Gracias, ya registré la información adicional. La voy a procesar y te aviso el siguiente paso."
        );
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
      let updatedCase = opCase;
      if (Object.keys(correctionPatch).length > 0) {
        updatedCase =
          (await updateOperationalCase(db, opCase.id, opCase.version, {
            context: {
              ...opCase.context_jsonb,
              ...correctionPatch,
              property_data_review_corrections: [
                ...(((opCase.context_jsonb?.property_data_review_corrections as unknown[]) ??
                  []) as unknown[]),
                {
                  text,
                  source: "telegram",
                  received_at: new Date().toISOString(),
                  patch: correctionPatch,
                },
              ],
            },
          })) ?? opCase;
      }
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
          ...(Object.keys(correctionPatch).length > 0
            ? { correction_patch: correctionPatch }
            : {}),
        },
      });
      await insertOperationalCaseEvent(db, {
        caseId: updatedCase.id,
        eventType: "human_decision",
        actor: "user",
        payload: {
          kind: "property_data_review_response",
          source: "telegram",
          notification_id: notification.id,
          text,
          correction_patch: correctionPatch,
        },
      });
      await resolveInternalNotificationWithReminders(db, {
        id: notification.id,
        userId,
        status: "actioned",
      });
      const caseBeforeReviewAdvance =
        (await getOperationalCase(db, updatedCase.id)) ?? updatedCase;
      const reviewAdvanceNextActionAt =
        caseBeforeReviewAdvance.context_jsonb?.e2e_controlled === true
          ? null
          : new Date().toISOString();
      const advancedCase =
        (await updateOperationalCase(
          db,
          caseBeforeReviewAdvance.id,
          caseBeforeReviewAdvance.version,
          {
            status: "active",
            currentStep: "comparables_in_progress",
            nextActionAt: reviewAdvanceNextActionAt,
            context: {
              ...caseBeforeReviewAdvance.context_jsonb,
              property_data_review_confirmed_at: new Date().toISOString(),
              property_data_review_notification_id: notification.id,
            },
          }
        )) ?? caseBeforeReviewAdvance;
      await insertOperationalCaseEvent(db, {
        caseId: advancedCase.id,
        eventType: "state_changed",
        actor: "system",
        payload: {
          kind: "property_data_review_confirmed",
          source: "telegram",
          notification_id: notification.id,
          from: {
            current_step: caseBeforeReviewAdvance.current_step,
            status: caseBeforeReviewAdvance.status,
          },
          to: {
            current_step: advancedCase.current_step,
            status: advancedCase.status,
          },
        },
      });
      updatedCase = advancedCase;
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
        Object.keys(correctionPatch).length > 0
          ? "Gracias, registré la corrección en el caso. Ya puedes revisar el siguiente avance en el laboratorio E2E."
          : "Gracias, registré tu confirmación en el caso. Ya puedes revisar el siguiente avance en el laboratorio E2E."
      );
      return NextResponse.json({
        ok: true,
        routed: "property_data_review_response",
        case_id: updatedCase.id,
        notification_id: notification.id,
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
  const explicitPropertyIntent =
    deterministicPropertyIntent || llmPropertyIntent;
  const activeE2ELabSession = explicitPropertyIntent
    ? await getActiveE2ELabSession(db, {
        userId,
        caseType: "property_optioning",
      })
    : null;
  const activeE2ELabSessionCaseId =
    typeof activeE2ELabSession?.case_id === "string" &&
    activeE2ELabSession.case_id.trim().length > 0
      ? activeE2ELabSession.case_id.trim()
      : null;
  const pendingBindings = await findPendingConversationBindings(db, {
    userId,
    channel: "telegram",
    chatId,
  });
  const pendingClarificationBinding = pendingBindings.find(
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
    if (clarificationReply.status === "resolved_case") {
      if (clarificationReply.case) {
        conversationalCase = clarificationReply.case;
      }
      if (clarificationReply.effectiveMessage) {
        agentMessageText = clarificationReply.effectiveMessage;
      }
    }
  }
  if (text) {
    if (!conversationalCase && explicitPropertyIntent) {
      try {
        if (activeE2ELabSessionCaseId) {
          const sessionCase = await getOperationalCase(
            db,
            activeE2ELabSessionCaseId
          );
          if (
            sessionCase &&
            sessionCase.user_id === userId &&
            sessionCase.case_type === "property_optioning" &&
            sessionCase.context_jsonb?.created_from === "agent_conversation" &&
            sessionCase.status !== "completed" &&
            sessionCase.status !== "failed"
          ) {
            conversationalCase = sessionCase;
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
                looksLikeNewCaseIntent(text) ||
                Boolean(activeE2ELabSession && !activeE2ELabSessionCaseId),
            });
        conversationalCase = conversationalCase ?? ensured?.case ?? null;
        if (
          conversationalCase &&
          activeE2ELabSession &&
          activeE2ELabSession.case_id !== conversationalCase.id
        ) {
          await linkE2ELabSessionToCase(db, {
            sessionId: activeE2ELabSession.id,
            caseId: conversationalCase.id,
          });
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
        if (
          ensured?.created &&
          conversationalCase?.current_step === "intake" &&
          conversationalCase.context_jsonb?.intake_status !== "complete"
        ) {
          const firstPrompt = await resolveConversationalIntakeTurn({
            db,
            userId,
            sessionId: session.id,
            opCase: conversationalCase,
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
        pendingBindings,
      });
      if (targetReply.matchedCase) {
        conversationalCase = targetReply.matchedCase;
      }
    }
    if (!conversationalCase) {
      const routeResult = await routeConversationalMessageAgainstBindings({
        db,
        channel: "telegram",
        message: agentMessageText,
        pendingBindings,
        explicitIntent: explicitPropertyIntent,
      });
      if (routeResult.route === "clarify") {
        await sendTelegramMessage(chatId, routeResult.responseText);
        return NextResponse.json({ ok: true, routed: "clarification_requested" });
      }
      if (routeResult.route === "case") {
        conversationalCase = routeResult.case;
      }
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
    const requestTarget = operationalCaseDocumentRequestTargetFromContext(
      conversationalCase.context_jsonb
    );
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
          message_id: message.message_id,
        },
      });
      await sendTelegramMessage(
        chatId,
        "Documento interno registrado en el caso. Cuando termines de subirlos, responde “listo” para procesarlos."
      );
      if (text && looksLikeDocumentBatchComplete(text)) {
        const moved =
          (await updateOperationalCase(
            db,
            conversationalCase.id,
            conversationalCase.version,
            {
              status: "waiting_internal",
              currentStep: "documents_received",
              nextActionAt: new Date().toISOString(),
            }
          )) ?? conversationalCase;
        return NextResponse.json({
          ok: true,
          routed: "operational_case_internal_documents_processing",
          case_id: moved.id,
        });
      }
      return NextResponse.json({
        ok: true,
        routed: "operational_case_internal_document_registered",
        case_id: conversationalCase.id,
      });
    }
  }

  if (agentMessageText && conversationalCase) {
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
      await sendTelegramMessage(chatId, choice.responseText);
      return NextResponse.json({
        ok: true,
        routed: "operational_case_document_target_set",
        case_id: conversationalCase.id,
      });
    }
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
