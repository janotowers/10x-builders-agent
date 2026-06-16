import { NextResponse } from "next/server";
import { createHash, randomUUID } from "node:crypto";
import {
  CASE_DOCUMENTS_BUCKET,
  createServerClient,
  createOperationalCaseDocument,
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
  listOperationalCaseDocuments,
  getOperationalCaseTypeForUser,
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
  buildOperationalCaseIntakeUpdateContext,
  isPropertyOptioningIntent,
  runAgent,
} from "@agents/agent";
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
  resolveTelegramConversationRoute,
  shouldBindTelegramMessageToConversationalCase,
} from "@/lib/operational-cases/conversational-case-routing";
import { ensureConversationalCase } from "@/lib/operational-cases/ensure-conversational-case";
import { buildConversationCaseIdentity } from "@/lib/operational-cases/conversation-case-identity";
import { buildTelegramOperationalCaseToolApprovalPolicy } from "@/lib/operational-cases/telegram-operational-case-tool-policy";
import type { OperationalCase } from "@agents/types";
import {
  isSettingsTestCase,
  runSettingsTestCaseAgentTick,
} from "@/lib/operational-cases/run-settings-test-case-tick";
import { findPendingConfirmationCheckpoint } from "@/lib/agent/pending-confirmation-checkpoint";
import {
  buildTelegramIntakeCompletionMessage,
  isIntakeInProgress,
  intakeJustCompleted,
} from "@/lib/operational-cases/telegram-intake-completion-message";
import { classifyOperationalConversationMessage } from "@/lib/operational-cases/operational-conversation-classifier";
import {
  extractConservativeIntakePatch,
  mergeIntakePatches,
  normalizeIntakePatchValues,
} from "@/lib/operational-cases/property-optioning-intake-extraction";
import {
  parseOwnerCharacteristics,
  syncIntakeFieldsFromPropertyData,
} from "@/lib/operational-cases/parse-owner-characteristics";

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

async function ensureConversationalE2ELabExternalContact(
  db: ReturnType<typeof createServerClient>,
  opCase: OperationalCase,
  chatId: number
): Promise<OperationalCase> {
  if (opCase.context_jsonb?.e2e_controlled !== true) return opCase;
  const external = opCase.external_contact_jsonb ?? {};
  if (
    external.channel === "telegram" &&
    String(external.chat_id ?? "") === String(chatId)
  ) {
    return opCase;
  }
  const updated = await updateOperationalCase(db, opCase.id, opCase.version, {
    externalContact: {
      ...external,
      channel: "telegram",
      chat_id: chatId,
      display_name:
        typeof external.display_name === "string" && external.display_name.trim()
          ? external.display_name
          : "Contacto de prueba E2E",
    },
  });
  return updated ?? opCase;
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

async function mergeCharacteristicsOwnerResponseDeterministically(params: {
  db: ReturnType<typeof createServerClient>;
  opCase: OperationalCase;
  text: string;
  source: string;
  nextActionAt: string | null;
}): Promise<OperationalCase> {
  const parsed = parseOwnerCharacteristics(params.text);
  const parsedKeys = Object.keys(parsed);
  if (parsedKeys.length === 0) return params.opCase;

  const currentContext = isRecord(params.opCase.context_jsonb)
    ? params.opCase.context_jsonb
    : {};
  const currentPropertyData = isRecord(currentContext.property_data)
    ? currentContext.property_data
    : {};
  const propertyData = {
    ...currentPropertyData,
    ...parsed,
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
        deterministic_owner_response_processed_at: new Date().toISOString(),
        deterministic_owner_response_parsed_fields: parsedKeys,
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
    },
  });
  return updated ?? params.opCase;
}

async function maybeRunPostIntakeConversationalE2ETick(params: {
  db: ReturnType<typeof createServerClient>;
  opCase: OperationalCase | null;
  userId: string;
  chatId: number;
}) {
  if (!params.opCase || params.opCase.context_jsonb?.e2e_controlled !== true) {
    return false;
  }
  const fresh = await getOperationalCase(params.db, params.opCase.id);
  if (
    !fresh ||
    fresh.user_id !== params.userId ||
    fresh.context_jsonb?.created_from !== "agent_conversation" ||
    fresh.context_jsonb?.e2e_controlled !== true ||
    fresh.status !== "active" ||
    fresh.current_step !== "awaiting_documents"
  ) {
    return false;
  }
  const events = await getRecentOperationalCaseEvents(params.db, fresh.id, 30);
  const alreadyRequestedDocuments = events.some((event) => {
    const payload = event.payload_jsonb;
    return (
      event.event_type === "reminder_sent" &&
      payload &&
      typeof payload === "object" &&
      (payload as Record<string, unknown>).purpose === "initial_request"
    );
  });
  if (alreadyRequestedDocuments) return false;

  const wired = await ensureConversationalE2ELabExternalContact(
    params.db,
    fresh,
    params.chatId
  );
  await runSettingsTestCaseAgentTick(params.db, wired, params.userId, {
    source: "telegram_webhook_conversational_e2e_post_intake",
  });
  return true;
}

function firstOperationalStepAfterIntake(flow: unknown) {
  if (!Array.isArray(flow)) return "awaiting_documents";
  const steps = flow.filter(
    (step): step is { step_key?: unknown } =>
      Boolean(step) && typeof step === "object"
  );
  const intakeIndex = steps.findIndex((step) => step.step_key === "intake");
  const nextStep =
    intakeIndex >= 0 ? steps[intakeIndex + 1]?.step_key : steps[0]?.step_key;
  return typeof nextStep === "string" && nextStep.trim()
    ? nextStep.trim()
    : "awaiting_documents";
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

function parseClarificationSelection(text: string): "yes" | "no" | null {
  const normalized = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
  if (!normalized) return null;
  if (
    /^(si|sí|ok|dale|va|correcto|afirmativo|confirmo|usar ese caso|completar ese caso)$/.test(
      normalized
    )
  ) {
    return "yes";
  }
  if (
    /^(no|negativo|otro|otra cosa|no es ese caso|no corresponde)$/.test(
      normalized
    )
  ) {
    return "no";
  }
  return null;
}

function looksLikeDocumentBatchComplete(text: string) {
  const normalized = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
  return /^(listo|ya esta|ya estan|termin[eé]|eso es todo|ya mande todo|ya te mande todo|documentos enviados)$/.test(
    normalized
  );
}

function buildMissingIntakeFieldsPrompt(missingFields: unknown[]) {
  const labels = missingFields
    .map((field) => {
      if (!field || typeof field !== "object" || Array.isArray(field)) return null;
      const record = field as Record<string, unknown>;
      const label =
        typeof record.label === "string" && record.label.trim()
          ? record.label.trim()
          : typeof record.name === "string" && record.name.trim()
            ? record.name.trim()
            : null;
      return label;
    })
    .filter((label): label is string => Boolean(label));

  const fallback = [
    "Título / propiedad",
    "Zona / colonia",
    "Operación aplicable",
    "Tipo de propiedad",
  ];
  const items = (labels.length > 0 ? labels : fallback)
    .map((label, index) => `${index + 1}. ${label}:`)
    .join("\n");

  return [
    "Para iniciar el proceso de opción de la propiedad, necesito estos datos:",
    "",
    items,
    "",
    "Compártemelos en un solo mensaje y continúo con el registro.",
  ].join("\n");
}

function buildIntakeProgressPrompt(params: {
  context: Record<string, unknown> | null | undefined;
  missingFields: unknown[];
}) {
  const context = params.context ?? {};
  const captured = [
    ["Título / propiedad", context.property_title],
    ["Zona / colonia", context.property_zone],
    ["Operación aplicable", context.operation_type],
    ["Tipo de propiedad", context.property_type],
  ]
    .filter(([, value]) => typeof value === "string" && value.trim())
    .map(([label, value]) => `- ${label}: ${String(value).trim()}`);
  const missingPrompt = buildMissingIntakeFieldsPrompt(params.missingFields);
  if (captured.length === 0) return missingPrompt;
  return [
    "Perfecto, ya registré estos datos:",
    "",
    ...captured,
    "",
    missingPrompt,
  ].join("\n");
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

function safePathSegment(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "file";
}

function extensionFromPath(filePath: string, fallback = "bin") {
  const ext = filePath.split(".").pop()?.toLowerCase();
  return ext && /^[a-z0-9]{1,8}$/.test(ext) ? ext : fallback;
}

function inferDocumentKind(params: { text?: string; fileName?: string }) {
  const normalized = `${params.text ?? ""} ${params.fileName ?? ""}`
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  if (
    /boleta|boleta registral|folio real|registro publico|registral/.test(
      normalized
    )
  ) {
    return "boleta_registral";
  }
  if (
    /predial|impuesto predial|sup\.?\s*terr|sup\.?\s*const|cuenta predial/.test(
      normalized
    )
  )
    return "predial";
  if (
    /descripcion|descriptiva|metraje|superficie|escritura|testimonio|(?:^|[^a-z])esc(?:[^a-z]|$)|desdeesc/.test(
      normalized
    )
  ) {
    return "escritura_descripcion";
  }
  if (/\bine\b|identificacion|identidad/.test(normalized)) return "ine";
  if (
    /comprobante|domicilio|estado\s+de\s+cuenta|estado\s+cuenta|banco|bancario|bbva|banorte|santander|hsbc|banamex|citibanamex|scotiabank/.test(
      normalized
    )
  ) {
    return "comprobante_domicilio";
  }
  return "unknown";
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
      let documentPayload:
        | {
            document_id: string;
            kind: string;
            storage_bucket: string;
            storage_path: string;
            original_name: string;
            content_type: string;
            sha256: string;
          }
        | null = null;
      if (media) {
        const fileInfo = await getTelegramFile(media.fileId);
        if (!fileInfo.file_path) {
          throw new Error("telegram_file_path_missing");
        }
        const bytes = Buffer.from(await downloadTelegramFile(fileInfo.file_path));
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        const kind = inferDocumentKind({
          text,
          fileName: media.originalName,
        });
        const extension = extensionFromPath(fileInfo.file_path!, media.fallbackExtension);
        const storagePath = `${matchedCase.user_id}/${matchedCase.id}/${randomUUID()}-${safePathSegment(
          media.originalName.replace(/\.[^.]+$/, "")
        )}.${extension}`;
        const { error: uploadError } = await db.storage
          .from(CASE_DOCUMENTS_BUCKET)
          .upload(storagePath, bytes, {
            contentType: media.contentType,
            upsert: false,
          });
        if (uploadError) throw uploadError;
        const doc = await createOperationalCaseDocument(db, {
          caseId: matchedCase.id,
          userId: matchedCase.user_id,
          kind,
          displayName: kind === "unknown" ? null : kind,
          storagePath,
          originalName: media.originalName,
          contentType: media.contentType,
          fileSizeBytes: media.fileSize ?? bytes.byteLength,
          sha256,
          source: "external_telegram",
          sourceMetadata: {
            message_id: message.message_id,
            from: message.from,
            telegram_file_id: media.fileId,
            telegram_file_unique_id: media.uniqueId,
            caption: text || null,
          },
          blocking: kind === "escritura_descripcion",
        });
        documentPayload = {
          document_id: doc.id,
          kind: doc.kind,
          storage_bucket: doc.storage_bucket,
          storage_path: doc.storage_path,
          original_name: media.originalName,
          content_type: media.contentType,
          sha256,
        };
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
          await sendTelegramMessage(
            chatId,
            "Gracias, ya registré que terminaste de enviar documentos. Voy a procesarlos y te aviso el siguiente paso."
          );
          try {
            const documentsReceivedCase =
              refreshedCase.current_step === "documents_received"
                ? refreshedCase
                : await updateOperationalCase(db, refreshedCase.id, refreshedCase.version, {
                    status: "waiting_internal",
                    currentStep: "documents_received",
                    nextActionAt: null,
                  });
            void runSettingsTestCaseAgentTick(
              db,
              documentsReceivedCase ?? refreshedCase,
              refreshedCase.user_id,
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
          } catch (tickError) {
            console.error(
              "[telegram-webhook] conversational E2E external response tick failed:",
              tickError
            );
            await sendTelegramMessage(
              chatId,
              "Recibí tus documentos, pero no pude iniciar el procesamiento automático. Revisa el laboratorio E2E e intenta la revisión manual."
            );
          }
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
    if (bestTelegramMedia(message)) {
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
  const pendingBindings = await findPendingConversationBindings(db, {
    userId,
    channel: "telegram",
    chatId,
  });
  const pendingClarificationBinding = pendingBindings.find(
    (binding) => binding.status === "clarification_needed"
  );
  if (pendingClarificationBinding && text) {
    const selection = parseClarificationSelection(text);
    if (selection === "yes") {
      const pendingMessageText =
        typeof pendingClarificationBinding.pending_message_jsonb?.text === "string"
          ? pendingClarificationBinding.pending_message_jsonb.text.trim()
          : "";
      const clarifiedCase = await getOperationalCase(
        db,
        pendingClarificationBinding.case_id
      );
      if (clarifiedCase) {
        conversationalCase = clarifiedCase;
      }
      if (pendingMessageText) {
        agentMessageText = pendingMessageText;
      }
      await setConversationBindingStatus(db, {
        bindingId: pendingClarificationBinding.id,
        status: "awaiting_user",
        pendingMessage: {},
        candidateRoutes: [],
        metadataMerge: {
          clarification_last_decision: "yes",
          clarification_resolved_at: new Date().toISOString(),
        },
        lastUserMessageAt: new Date().toISOString(),
      });
    } else if (selection === "no") {
      await setConversationBindingStatus(db, {
        bindingId: pendingClarificationBinding.id,
        status: "awaiting_user",
        pendingMessage: {},
        candidateRoutes: [],
        metadataMerge: {
          clarification_last_decision: "no",
          clarification_resolved_at: new Date().toISOString(),
        },
        lastUserMessageAt: new Date().toISOString(),
      });
      await sendTelegramMessage(
        chatId,
        "Perfecto. No asocié ese mensaje al caso pendiente. Si quieres abrir otro flujo, dímelo explícitamente (por ejemplo: publicar en EasyBroker u opcionar otra propiedad)."
      );
      return NextResponse.json({ ok: true, routed: "clarification_resolved_no" });
    }
  }
  if (text) {
    if (!conversationalCase && explicitPropertyIntent) {
      try {
        const ensured = await ensureConversationalCase(db, {
          userId,
          caseType: "property_optioning",
          channel: "telegram",
          e2eControlled: Boolean(activeE2ELabSession),
          labTelegramChatId: activeE2ELabSession ? chatId : undefined,
        });
        conversationalCase = ensured?.case ?? null;
        if (conversationalCase && activeE2ELabSession) {
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
          await insertOperationalCaseEvent(db, {
            caseId: conversationalCase.id,
            eventType: "reminder_sent",
            actor: "system",
            payload: {
              kind: "intake_fields_requested",
              source: "telegram_webhook_deterministic_intake",
              current_step: "intake",
              missing_required:
                conversationalCase.context_jsonb?.missing_required ?? [],
            },
          });
          await sendTelegramMessage(
            chatId,
            buildMissingIntakeFieldsPrompt(
              (conversationalCase.context_jsonb?.missing_required as unknown[]) ?? []
            )
          );
          return NextResponse.json({
            ok: true,
            routed: "operational_case_intake_missing_fields",
            case_id: conversationalCase.id,
          });
        }
      } catch (err) {
        console.error(
          "[telegram-webhook] ensure conversational case failed:",
          err
        );
      }
    }
    if (!conversationalCase) {
      const candidateCaseIds = pendingBindings.map((binding) => binding.case_id);
      const candidateCaseRows = await Promise.all(
        candidateCaseIds.map((caseId) => getOperationalCase(db, caseId))
      );
      const candidateCasesById = new Map<string, OperationalCase>();
      candidateCaseRows.forEach((row) => {
        if (row) candidateCasesById.set(row.id, row);
      });
      const routeDecision = resolveTelegramConversationRoute({
        message: text,
        bindings: pendingBindings,
        candidateCasesById,
        explicitIntent: explicitPropertyIntent,
      });
      if (routeDecision.route === "case") {
        conversationalCase = candidateCasesById.get(routeDecision.caseId) ?? null;
        if (routeDecision.bindingId) {
          await setConversationBindingStatus(db, {
            bindingId: routeDecision.bindingId,
            status: "awaiting_user",
            metadataMerge: {
              last_route_reason: routeDecision.reason,
              last_route_confidence: routeDecision.confidence,
            },
            lastUserMessageAt: new Date().toISOString(),
          });
        }
      } else if (routeDecision.route === "clarify" && routeDecision.candidates.length > 0) {
        const primary = routeDecision.candidates[0]!;
        const primaryCase = candidateCasesById.get(primary.caseId);
        if (primaryCase) {
          const identity = buildConversationCaseIdentity({ opCase: primaryCase });
          await setConversationBindingStatus(db, {
            bindingId: primary.bindingId ?? pendingBindings[0]!.id,
            status: "clarification_needed",
            pendingMessage: {
              text,
              received_at: new Date().toISOString(),
            },
            candidateRoutes: routeDecision.candidates,
            metadataMerge: {
              clarification_reason: routeDecision.reason,
              clarification_case_id: primaryCase.id,
            },
            lastUserMessageAt: new Date().toISOString(),
          });
          await sendTelegramMessage(
            chatId,
            `Tu mensaje podría corresponder al caso pendiente de ${identity.caseTypeLabel}:\n` +
              `• ${identity.summary}\n` +
              `• Técnico: ${identity.technical}\n` +
              `• Caso: ${identity.shortId}\n\n` +
              "¿Quieres que lo asocie a ese caso? Responde: sí / no."
          );
          return NextResponse.json({ ok: true, routed: "clarification_requested" });
        }
      } else {
        const fallbackBinding = pendingBindings[0];
        const fallbackCase = fallbackBinding
          ? candidateCasesById.get(fallbackBinding.case_id)
          : null;
        if (
          fallbackBinding &&
          fallbackCase &&
          shouldBindTelegramMessageToConversationalCase({
            message: text,
            opCase: fallbackCase,
          })
        ) {
          conversationalCase = fallbackCase;
        }
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

  if (
    text &&
    conversationalCase &&
    conversationalCase.context_jsonb?.created_from === "agent_conversation" &&
    conversationalCase.current_step !== "intake" &&
    conversationalCase.context_jsonb?.intake_status !== "complete"
  ) {
    const deterministicPatch = normalizeIntakePatchValues(
      extractConservativeIntakePatch(text)
    );
    let looksLikeIntakeContinuation = Object.keys(deterministicPatch).length > 0;
    if (!looksLikeIntakeContinuation) {
      const intakeClassification = await classifyOperationalConversationMessage({
        message: text,
        stage: "intake",
        caseSummary: [
          conversationalCase.context_jsonb?.property_title,
          conversationalCase.context_jsonb?.property_zone,
          conversationalCase.context_jsonb?.operation_type,
          conversationalCase.context_jsonb?.property_type,
          `current_step=${conversationalCase.current_step}`,
          `intake_status=${String(conversationalCase.context_jsonb?.intake_status ?? "")}`,
        ]
          .filter((value) => typeof value === "string" && value.trim())
          .join(" · "),
      });
      looksLikeIntakeContinuation = Boolean(
        intakeClassification &&
          (intakeClassification.intent === "provide_intake" ||
            intakeClassification.intent === "start_case")
      );
    }
    if (looksLikeIntakeContinuation) {
      const [documents, recentEvents] = await Promise.all([
        listOperationalCaseDocuments(db, {
          caseId: conversationalCase.id,
          statuses: ["received"],
        }),
        getRecentOperationalCaseEvents(db, conversationalCase.id, 80),
      ]);
      const lastIntakeTimestamp = recentEvents.reduce<string | null>((latest, event) => {
        if (event.event_type !== "state_changed") return latest;
        const payload =
          event.payload_jsonb && typeof event.payload_jsonb === "object"
            ? (event.payload_jsonb as Record<string, unknown>)
            : null;
        const payloadStep =
          typeof payload?.current_step === "string" ? payload.current_step : null;
        const toStep =
          payload?.to && typeof payload.to === "object"
            ? (payload.to as Record<string, unknown>).current_step
            : null;
        const enteredIntake =
          payloadStep === "intake" ||
          toStep === "intake" ||
          payload?.kind === "case_created";
        if (!enteredIntake) return latest;
        if (!latest || event.created_at > latest) return event.created_at;
        return latest;
      }, null);
      const hasHumanDecisionAfterIntake = recentEvents.some((event) => {
        if (event.event_type !== "human_decision") return false;
        if (!lastIntakeTimestamp) return true;
        return event.created_at > lastIntakeTimestamp;
      });
      const canReopenIntake =
        documents.length === 0 && !hasHumanDecisionAfterIntake;
      if (canReopenIntake) {
        const fromStepBeforeReopen = conversationalCase.current_step;
        const reopenedCase = await updateOperationalCase(
          db,
          conversationalCase.id,
          conversationalCase.version,
          {
            status: "waiting_internal",
            currentStep: "intake",
            nextActionAt: null,
          }
        );
        if (reopenedCase) {
          conversationalCase = reopenedCase;
          await insertOperationalCaseEvent(db, {
            caseId: reopenedCase.id,
            eventType: "state_changed",
            actor: "system",
            payload: {
              kind: "conversational_intake_reopened",
              source: "telegram_webhook_desync_recovery",
              from_step: fromStepBeforeReopen,
              to_step: "intake",
              reason: "intake_incomplete_desync",
            },
          });
        }
      } else {
        await insertOperationalCaseEvent(db, {
          caseId: conversationalCase.id,
          eventType: "error",
          actor: "system",
          payload: {
            kind: "conversational_intake_reopen_blocked",
            source: "telegram_webhook_desync_recovery",
            current_step: conversationalCase.current_step,
            intake_status: conversationalCase.context_jsonb?.intake_status ?? null,
            documents_received: documents.length,
            has_human_decision_after_intake: hasHumanDecisionAfterIntake,
          },
        });
        await sendTelegramMessage(
          chatId,
          "Detecté datos de intake, pero este caso ya avanzó a una etapa operativa con actividad registrada. Para evitar inconsistencias, continuaré con el paso actual. Si deseas reiniciar el registro del caso, indícalo explícitamente."
        );
        return NextResponse.json({
          ok: true,
          routed: "operational_case_intake_reopen_blocked",
          case_id: conversationalCase.id,
        });
      }
    }
  }

  if (
    text &&
    conversationalCase &&
    conversationalCase.current_step === "intake" &&
    conversationalCase.context_jsonb?.intake_status !== "complete"
  ) {
    const caseType = await getOperationalCaseTypeForUser(
      db,
      conversationalCase.user_id,
      conversationalCase.case_type
    );
    if (caseType) {
      const deterministicPatch = normalizeIntakePatchValues(
        extractConservativeIntakePatch(text)
      );
      const intakeClassification = await classifyOperationalConversationMessage({
        message: text,
        stage: "intake",
        caseSummary: [
          conversationalCase.context_jsonb?.property_title,
          conversationalCase.context_jsonb?.property_zone,
          conversationalCase.context_jsonb?.operation_type,
          conversationalCase.context_jsonb?.property_type,
          `missing_required=${JSON.stringify(
            conversationalCase.context_jsonb?.missing_required ?? []
          )}`,
        ]
          .filter((value) => typeof value === "string" && value.trim())
          .join(" · "),
      });
      const llmPatch =
        intakeClassification &&
        (intakeClassification.intent === "provide_intake" ||
          intakeClassification.intent === "start_case")
          ? normalizeIntakePatchValues(intakeClassification.patch ?? {})
          : {};
      const intakePatch = mergeIntakePatches(llmPatch, deterministicPatch);
      if (Object.keys(intakePatch).length === 0) {
        await sendTelegramMessage(
          chatId,
          buildIntakeProgressPrompt({
            context: conversationalCase.context_jsonb,
            missingFields:
              (conversationalCase.context_jsonb?.missing_required as unknown[]) ?? [],
          })
        );
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
          metadata: { source: "telegram_webhook_intake_still_missing" },
        });
        return NextResponse.json({
          ok: true,
          routed: "operational_case_intake_still_missing",
          case_id: conversationalCase.id,
        });
      }
      const beforeUpdate = conversationalCase;
      const intakeSchema =
        (caseType.intake_schema_jsonb as Parameters<
          typeof buildOperationalCaseIntakeUpdateContext
        >[0]["intakeSchema"]) ?? [];
      const buildIntakeUpdate = (existingContext: Record<string, unknown>) =>
        buildOperationalCaseIntakeUpdateContext({
          existingContext,
          intakePatch,
          intakeSchema,
          e2eControlled: existingContext.e2e_controlled === true,
          channel: "telegram",
        });
      let intakeUpdate = buildIntakeUpdate(
        (conversationalCase.context_jsonb as Record<string, unknown>) ?? {}
      );
      const nextStep = intakeUpdate.complete
        ? firstOperationalStepAfterIntake(caseType.operational_flow_jsonb)
        : "intake";
      let updatedCase = await updateOperationalCase(
        db,
        conversationalCase.id,
        conversationalCase.version,
        {
          status: intakeUpdate.complete ? "active" : "waiting_internal",
          currentStep: nextStep,
          nextActionAt:
            conversationalCase.context_jsonb?.e2e_controlled === true
              ? null
              : new Date().toISOString(),
          context: intakeUpdate.context,
        }
      );
      if (!updatedCase) {
        console.warn("[telegram-webhook] intake update conflict; retrying with fresh version", {
          case_id: conversationalCase.id,
        });
        const refreshedCase = await getOperationalCase(db, conversationalCase.id);
        if (refreshedCase) {
          intakeUpdate = buildIntakeUpdate(
            (refreshedCase.context_jsonb as Record<string, unknown>) ?? {}
          );
          const retryNextStep = intakeUpdate.complete
            ? firstOperationalStepAfterIntake(caseType.operational_flow_jsonb)
            : "intake";
          updatedCase = await updateOperationalCase(
            db,
            refreshedCase.id,
            refreshedCase.version,
            {
              status: intakeUpdate.complete ? "active" : "waiting_internal",
              currentStep: retryNextStep,
              nextActionAt:
                refreshedCase.context_jsonb?.e2e_controlled === true
                  ? null
                  : new Date().toISOString(),
              context: intakeUpdate.context,
            }
          );
          if (!updatedCase) {
            updatedCase = refreshedCase;
          }
        }
      }
      updatedCase = updatedCase ?? conversationalCase;
      const persistedMissing =
        ((updatedCase.context_jsonb?.missing_required as unknown[]) ?? intakeUpdate.missing) || [];
      const intakeCompletedNow = !isIntakeInProgress(updatedCase);
      await insertOperationalCaseEvent(db, {
        caseId: updatedCase.id,
        eventType: intakeCompletedNow ? "step_completed" : "state_changed",
        actor: "system",
        payload: {
          source: "telegram_webhook_deterministic_intake_update",
          current_step: updatedCase.current_step,
          intake_status: intakeCompletedNow ? "complete" : "incomplete",
          intake_patch: intakeUpdate.intakePatch,
          missing_required: persistedMissing,
        },
      });
      await upsertConversationBinding(db, {
        userId,
        caseId: updatedCase.id,
        caseType: updatedCase.case_type,
        channel: "telegram",
        chatId,
        sessionId: session.id,
        status: "awaiting_user",
        awaitingFields: persistedMissing,
        metadata: { source: "telegram_webhook_deterministic_intake_update" },
      });

      if (intakeCompletedNow) {
        await sendTelegramMessage(
          chatId,
          buildTelegramIntakeCompletionMessage(updatedCase)
        );
        if (updatedCase.context_jsonb?.e2e_controlled === true) {
          try {
            await maybeRunPostIntakeConversationalE2ETick({
              db,
              opCase: updatedCase,
              userId,
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
          routed: "operational_case_intake_completed",
          case_id: updatedCase.id,
        });
      }
      await sendTelegramMessage(
        chatId,
        buildIntakeProgressPrompt({
          context:
            (updatedCase.context_jsonb as Record<string, unknown> | null | undefined) ??
            intakeUpdate.context,
          missingFields: persistedMissing,
        })
      );
      if (beforeUpdate.version === updatedCase.version) {
        console.warn("[telegram-webhook] intake update returned unchanged case", {
          case_id: updatedCase.id,
        });
      }
      return NextResponse.json({
        ok: true,
        routed: "operational_case_intake_updated_incomplete",
        case_id: updatedCase.id,
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
