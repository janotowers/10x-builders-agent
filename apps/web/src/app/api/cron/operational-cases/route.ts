/**
 * POST /api/cron/operational-cases
 *
 * Procesa casos operacionales vencidos. Llamado periódicamente (Supabase Cron
 * vía pg_cron + pg_net, o un scheduler externo).
 *
 * Pasos por tick:
 *   1. Lee casos donde next_action_at <= now() y status in (active,
 *      waiting_internal, waiting_external) — `getDueOperationalCases`.
 *   2. Para cada caso, intenta tomar el lock optimista (`markCaseProcessing`).
 *      Si otro worker se adelantó, lo salta.
 *   3. Crea/recupera una sesión persistente para el caso (canal `case_runner`).
 *   4. Invoca `runAgent` con `caseId`. El runtime hace binding directo a la
 *      skill del case_type y le inyecta el bloque [Caso operacional].
 *   5. Loguea resultado. El agente es responsable de actualizar el estado del
 *      caso e insertar eventos via tools.
 *
 * Auth: Bearer token en Authorization que coincide con `CRON_SECRET`. La
 * ruta está excluida del middleware de sesión Supabase (igual que otras
 * rutas de cron).
 *
 * Concurrencia: limitada por OPERATIONAL_CASES_CONCURRENCY (default 5) para
 * evitar quemar tokens / throttle del LLM si hay muchos casos vencidos.
 */
import { NextResponse } from "next/server";
import {
  createServerClient,
  decryptToken,
  getProfile,
  getUserToolSettings,
  getUserSkillSettings,
  getUserIntegrations,
  getGoogleCalendarAccessToken,
  getDueOperationalCases,
  getInternalUserNotification,
  getOperationalCase,
  getRecentOperationalCaseEvents,
  getTelegramChatId,
  getUserNotificationPreferences,
  listDueExternalContactNotifications,
  listDueInternalUserNotifications,
  insertOperationalCaseEvent,
  markExternalContactNotificationFailed,
  markExternalContactNotificationSent,
  markInternalNotificationEscalated,
  markInternalNotificationReminderSent,
  expireExternalContactNotification,
  expireExternalContactNotificationsForCase,
  markCaseProcessing,
  resolveUnreadInternalNotificationsByKindForCaseWithReminders,
  refreshInternalUserNotificationContent,
  updateOperationalCase,
  getOrCreateSession,
  countPendingToolCallsForCase,
  getPendingToolCall,
  setInternalUserNotificationStatus,
} from "@agents/db";
import { runAgent } from "@agents/agent";
import type {
  ExternalContactNotification,
  InternalUserNotification,
  OperationalCase,
} from "@agents/types";
import {
  isControlledE2EOperationalCase,
  isCronSuppressedOperationalCase,
  isSettingsOperationalTestCase,
  resolveOperationalCaseDocumentRequestTarget,
} from "@agents/types";
import { ensureAgentToolDepsWired } from "@/lib/agent/wire-tool-deps";
import { notify } from "@/lib/notify";
import { buildHitlApprovalTelegramMarkup } from "@/lib/notify/hitl-telegram-markup";
import { notifyUserRespectingActiveInternalChannel } from "@/lib/operational-cases/deliver-internal-case-follow-up";
import { getActiveCaseInternalChannel } from "@/lib/operational-cases/mirror-case-message-to-web-chat";
import { isInternalCaseNotificationObsolete } from "@/lib/operational-cases/obsolete-case-notification";
import { ensurePhotosUploadRequestForCase } from "@/lib/operational-cases/ensure-photos-upload-request";
import { buildOperationalCaseCronToolApprovalPolicy } from "@/lib/operational-cases/operational-case-cron-tool-policy";
import {
  isInternalDocumentEventDrivenWait,
  stabilizeInternalDocumentWait,
} from "@/lib/operational-cases/internal-document-wait-invariant";
import {
  sendTelegramMessage,
  truncateTelegramText,
} from "@/lib/telegram/send-message";
import {
  internalNotificationKindConfig,
  escalationPolicyForNotificationKind,
  maxReminderAttemptsForNotificationKind,
} from "@/lib/internal-notifications/registry";
import { syncContractDraftFromToolCalls } from "@/lib/operational-cases/contract-draft-document";
import {
  nextAllowedDeliveryAt,
  reminderCooldownHoursForEngagement,
  resolveEngagementPolicy,
} from "@/lib/engagement-policies/registry";
import { applyPropertyOptioningPostAgentInvariants } from "@/lib/operational-cases/property-optioning-post-agent-invariants";
import { buildMediaGroupReceivedAck } from "@/lib/operational-cases/case-document-collection";
import { requestPublicationProgress } from "@/lib/operational-cases/publication-runner";
import {
  applyPostAgentContractHandling,
  createPublicationRunnerOwnedAgentTick,
  listingDescriptionReviewNeedsRegeneration,
  runSettingsTestCaseAgentTick,
  type TurnToolCallRow,
} from "@/lib/operational-cases/run-settings-test-case-tick";
import { flushMediaGroupAcksForCase } from "@/lib/operational-cases/telegram-media-group-ack-store";
import {
  countCaseUploadFiles,
  formatUploadBatchConfirmationReminderText,
  isUploadBatchNotificationKind,
  resolveUploadBatchKind,
  UPLOAD_BATCH_CONFIRMATION_PURPOSE,
  uploadBatchKindFromNotificationKind,
} from "@/lib/operational-cases/upload-batch-completion";
import {
  buildToolConfirmationEscalationText,
  notificationMetadataPendingToolCallId,
  shouldRefreshToolConfirmationNotification,
} from "@/lib/operational-cases/hitl-reminder-selfheal";
import {
  OperationalStepLabelResolver,
  humanizeOperationalStepKey,
} from "@/lib/operational-cases/operational-step-labels";
import {
  runWorkPlaneCronPass,
  type WorkPlaneCronSummary,
} from "@/lib/operational-cases/work-plane-tick";

const CRON_SECRET = process.env.CRON_SECRET ?? "";
const TOOL_CONFIRMATION_PENDING_KIND = "tool_confirmation_pending";
const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL ??
  process.env.NEXT_PUBLIC_SITE_URL ??
  process.env.SITE_URL ??
  "";

const DEFAULT_CONCURRENCY = 5;

function isAuthorized(request: Request): boolean {
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return CRON_SECRET.length > 0 && token === CRON_SECRET;
}

interface CaseProcessResult {
  case_id: string;
  status: "ok" | "skipped" | "error";
  error?: string;
}

/**
 * Construye el "mensaje" sintético que se le pasa al agente cuando lo invoca
 * el cron. No es un mensaje del usuario; es un disparador. La instrucción
 * se mantiene corta porque el bloque [Caso operacional] (que se inyecta en
 * el system prompt) ya tiene todo el contexto.
 */
function buildCaseTickMessage(opCase: OperationalCase): string {
  return [
    `Tick de procesamiento del caso operacional ${opCase.id} (case_type=${opCase.case_type}, status=${opCase.status}, current_step=${opCase.current_step ?? "(none)"}).`,
    "Lee el bloque [Caso operacional activo] del system prompt y decide la siguiente acción siguiendo la skill activa. Si necesitas comunicarte con el humano externo o interno, usa las tools correspondientes. Cuando avances un paso, actualiza el caso con la tool de update y registra el evento.",
  ].join(" ");
}

type PendingCaseToolCall = {
  id: string;
  tool_name: string;
  arguments_json: Record<string, unknown> | null;
  created_at: string;
};

const PENDING_TOOL_LABELS: Record<string, string> = {
  telegram_send_message_to_contact: "Enviar mensaje por Telegram",
};

function formatPendingToolForReminder(toolName: string): string {
  const trimmed = toolName.trim();
  const friendly = PENDING_TOOL_LABELS[trimmed] ?? humanizeOperationalStepKey(trimmed);
  return `${friendly} (${trimmed})`;
}

function buildPendingCaseUrl(caseId: string): string | null {
  if (!APP_URL || !/^https?:\/\//i.test(APP_URL)) return null;
  return `${APP_URL.replace(/\/$/, "")}/chat/pending?case=${encodeURIComponent(caseId)}`;
}

/**
 * Lista los `tool_calls` en `pending_confirmation` que pertenecen a un caso,
 * abarcando **todas** las sesiones del usuario (no solo `case_runner`).
 *
 * Una aprobación HITL puede originarse en cualquier canal: el agente puede
 * pausar pidiendo confirmación dentro de un chat de Telegram o web, no solo en
 * el `case_runner` del cron. Si filtráramos por `channel='case_runner'`, el
 * pendiente real (creado en la sesión de chat) quedaría invisible aquí mientras
 * `countPendingToolCallsForCase` sí lo cuenta. Esa discrepancia hacía que el
 * recordatorio cayera al texto genérico sin identificar el caso y sin
 * `pending_tool_call_id`, lo que impedía reconstruir los botones Aprobar/Cancelar.
 * El webhook de Telegram resuelve `approve:`/`reject:` por `session_id` del
 * propio `tool_call`, así que adjuntar botones es válido sin importar el canal.
 */
async function listPendingCaseToolCalls(
  db: ReturnType<typeof createServerClient>,
  userId: string,
  caseId: string
): Promise<PendingCaseToolCall[]> {
  const { data: sessions, error: sessionsError } = await db
    .from("agent_sessions")
    .select("id")
    .eq("user_id", userId);
  if (sessionsError) throw sessionsError;
  const sessionIds = (sessions ?? [])
    .map((session: { id?: unknown }) => session.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  if (sessionIds.length === 0) return [];

  const [argsResult, metaResult] = await Promise.all([
    db
      .from("tool_calls")
      .select("id, tool_name, arguments_json, created_at")
      .in("session_id", sessionIds)
      .eq("status", "pending_confirmation")
      .eq("arguments_json->>case_id", caseId)
      .order("created_at", { ascending: false })
      .limit(20),
    db
      .from("tool_calls")
      .select("id, tool_name, arguments_json, created_at")
      .in("session_id", sessionIds)
      .eq("status", "pending_confirmation")
      .eq("metadata_jsonb->>case_id", caseId)
      .order("created_at", { ascending: false })
      .limit(20),
  ]);
  if (argsResult.error) throw argsResult.error;
  if (metaResult.error) throw metaResult.error;

  const byId = new Map<string, PendingCaseToolCall>();
  for (const row of [...(argsResult.data ?? []), ...(metaResult.data ?? [])]) {
    const id = typeof row.id === "string" ? row.id : "";
    if (!id || byId.has(id)) continue;
    byId.set(id, {
      id,
      tool_name: typeof row.tool_name === "string" ? row.tool_name : "tool",
      arguments_json:
        row.arguments_json && typeof row.arguments_json === "object"
          ? (row.arguments_json as Record<string, unknown>)
          : null,
      created_at:
        typeof row.created_at === "string" ? row.created_at : new Date().toISOString(),
    });
  }
  return [...byId.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
}

async function buildPendingToolDescription(
  stepLabelResolver: OperationalStepLabelResolver,
  opCase: OperationalCase,
  call: PendingCaseToolCall,
  pendingCount: number
) {
  const title =
    typeof opCase.context_jsonb?.property_title === "string"
      ? opCase.context_jsonb.property_title.trim()
      : "";
  const zone =
    typeof opCase.context_jsonb?.property_zone === "string"
      ? opCase.context_jsonb.property_zone.trim()
      : "";
  const link = buildPendingCaseUrl(opCase.id);
  const stepLabel = await stepLabelResolver.formatForCase(
    opCase,
    opCase.current_step
  );
  const baseLines = [
    pendingCount === 1
      ? "Tienes 1 aprobación del agente pendiente para continuar este caso."
      : `Tienes ${pendingCount} aprobaciones del agente pendientes para continuar este caso.`,
    `Caso: ${title || opCase.case_type}${zone ? ` (${zone})` : ""}`,
    `Paso: ${stepLabel}`,
    `Ejecución pendiente: ${formatPendingToolForReminder(call.tool_name)}`,
  ];
  if (call.tool_name === "telegram_send_message_to_contact") {
    const preview =
      typeof call.arguments_json?.message === "string"
        ? call.arguments_json.message.trim()
        : "";
    if (preview) {
      baseLines.push(`Mensaje propuesto: ${truncateTelegramText(preview)}`);
    }
  }
  baseLines.push("Usa los botones para decidir o abre «Ver detalle».");
  return { text: baseLines.join("\n"), link };
}

async function maybeSendPendingToolButtonsToAdvisor(
  db: ReturnType<typeof createServerClient>,
  stepLabelResolver: OperationalStepLabelResolver,
  opCase: OperationalCase,
  pendingCalls: PendingCaseToolCall[]
) {
  const firstPending = pendingCalls[0];
  if (!firstPending) return;
  // Paridad de canal: si el asesor opera el caso en Web, no empujar Telegram.
  const activeChannel = await getActiveCaseInternalChannel({
    db,
    caseId: opCase.id,
  }).catch(() => null);
  if (activeChannel === "web") return;
  const chatId = await getTelegramChatId(db, opCase.user_id);
  if (!chatId) return;
  const recentEvents = await getRecentOperationalCaseEvents(db, opCase.id, 30);
  const alreadySent = recentEvents.some((event) => {
    if (event.event_type !== "reminder_sent") return false;
    const payload =
      event.payload_jsonb && typeof event.payload_jsonb === "object"
        ? (event.payload_jsonb as Record<string, unknown>)
        : null;
    return (
      payload?.source === "cron_hitl_telegram_buttons" &&
      payload?.tool_call_id === firstPending.id
    );
  });
  if (alreadySent) return;

  const { text, link } = await buildPendingToolDescription(
    stepLabelResolver,
    opCase,
    firstPending,
    pendingCalls.length
  );
  // Single Telegram message: body + approve/reject (+ optional Ver detalle URL
  // button). A second plain "Ver detalle:" message used to duplicate the same
  // notice and looked like a bug (one with buttons, one without).
  await sendTelegramMessage(
    chatId,
    truncateTelegramText(text),
    buildHitlApprovalTelegramMarkup({
      toolCallId: firstPending.id,
      detailUrl: link,
    }),
    { throwOnError: true }
  );
  await insertOperationalCaseEvent(db, {
    caseId: opCase.id,
    eventType: "reminder_sent",
    actor: "system",
    payload: {
      source: "cron_hitl_telegram_buttons",
      tool_call_id: firstPending.id,
      tool_name: firstPending.tool_name,
      pending_count: pendingCalls.length,
    },
  });
}

/**
 * Persist the web HITL card (upsert) and deliver Telegram buttons once per
 * pending tool_call. Shared by the cron "already pending" skip path and the
 * path right after an agent tick creates a new pending confirmation.
 */
async function ensurePendingHitlAdvisorNotice(
  db: ReturnType<typeof createServerClient>,
  stepLabelResolver: OperationalStepLabelResolver,
  opCase: OperationalCase
) {
  const pendingCalls = await listPendingCaseToolCalls(
    db,
    opCase.user_id,
    opCase.id
  );
  if (pendingCalls.length === 0) return;
  const pendingReference = pendingCalls[0]!;
  const pendingReferenceText = (
    await buildPendingToolDescription(
      stepLabelResolver,
      opCase,
      pendingReference,
      pendingCalls.length
    )
  ).text;
  await notify(
    db,
    opCase.user_id,
    {
      text: pendingReferenceText,
      kind: TOOL_CONFIRMATION_PENDING_KIND,
      data: {
        case_id: opCase.id,
        title: "Aprobación del agente pendiente",
        action_url: `/chat/pending?case=${encodeURIComponent(opCase.id)}`,
        pending_tool_confirmations: pendingCalls.length,
        pending_tool_name: pendingReference.tool_name,
        pending_tool_call_id: pendingReference.id,
      },
    },
    "normal",
    // Telegram is delivered once by maybeSendPendingToolButtonsToAdvisor so the
    // web card and the Telegram notice stay on a single deduped path.
    { pushChannels: [] }
  );
  await maybeSendPendingToolButtonsToAdvisor(
    db,
    stepLabelResolver,
    opCase,
    pendingCalls
  );
}

function hoursFromNow(hours: number) {
  return new Date(Date.now() + hours * 60 * 60_000).toISOString();
}

type ReminderDeliveryContext = {
  timezone: string;
  engagementOverrides: Record<string, unknown> | null;
};

async function loadReminderDeliveryContext(
  db: ReturnType<typeof createServerClient>,
  userId: string,
  cache: Map<string, ReminderDeliveryContext>
): Promise<ReminderDeliveryContext> {
  const cached = cache.get(userId);
  if (cached) return cached;
  const [profile, prefs] = await Promise.all([
    getProfile(db, userId).catch(() => null),
    getUserNotificationPreferences(db, userId).catch(() => null),
  ]);
  const context: ReminderDeliveryContext = {
    timezone:
      typeof profile?.timezone === "string" && profile.timezone.trim()
        ? profile.timezone.trim()
        : "UTC",
    engagementOverrides:
      prefs?.engagement_policy_overrides_jsonb &&
      typeof prefs.engagement_policy_overrides_jsonb === "object"
        ? (prefs.engagement_policy_overrides_jsonb as Record<string, unknown>)
        : null,
  };
  cache.set(userId, context);
  return context;
}

async function deferInternalNotificationReminder(
  db: ReturnType<typeof createServerClient>,
  notification: InternalUserNotification,
  dueAt: Date
) {
  await db
    .from("internal_user_notifications")
    .update({
      due_at: dueAt.toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", notification.id)
    .eq("status", "unread");
}

async function deferExternalContactReminder(
  db: ReturnType<typeof createServerClient>,
  notification: ExternalContactNotification,
  nextReminderAt: Date
) {
  await db
    .from("external_contact_notifications")
    .update({
      next_reminder_at: nextReminderAt.toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", notification.id)
    .in("status", ["pending", "sent"]);
}

function shouldSendInternalReminder(
  notification: InternalUserNotification,
  engagementOverrides?: Record<string, unknown> | null
) {
  const lastReminder = notification.metadata_jsonb?.last_reminder_at;
  if (typeof lastReminder !== "string") return true;
  const kindConfig = internalNotificationKindConfig(notification.kind);
  const cooldownHours = reminderCooldownHoursForEngagement(
    {
      audience: "internal_user",
      intent: kindConfig.intent ?? "reminder",
      kind: kindConfig.kind,
    },
    engagementOverrides
  );
  // TODO: make reminder cadence configurable by user, notification kind,
  // priority, working hours, and the user's timezone.
  return (
    Date.now() - new Date(lastReminder).getTime() >
    cooldownHours * 60 * 60_000
  );
}

function reminderCount(notification: InternalUserNotification): number {
  const count = notification.metadata_jsonb?.reminder_count;
  return typeof count === "number" && Number.isFinite(count) ? count : 0;
}

function shouldEscalateInternalReminder(
  notification: InternalUserNotification,
  engagementOverrides?: Record<string, unknown> | null
) {
  const kindConfig = internalNotificationKindConfig(notification.kind);
  const policy = resolveEngagementPolicy(
    {
      audience: "internal_user",
      intent: kindConfig.intent ?? "reminder",
      kind: kindConfig.kind,
    },
    engagementOverrides
  );
  const reminderAttemptsCap =
    policy.maxReminderAttempts ?? maxReminderAttemptsForNotificationKind(notification.kind);
  const escalateAfterHours =
    policy.escalateAfterHours ??
    escalationPolicyForNotificationKind(notification.kind).escalateAfterHours;
  const escalationPriority =
    policy.escalationPriority ??
    escalationPolicyForNotificationKind(notification.kind).escalationPriority;
  if (!reminderAttemptsCap && !escalateAfterHours) return null;
  if (typeof notification.metadata_jsonb?.escalated_at === "string") return null;

  const reasons: string[] = [];
  if (reminderAttemptsCap && reminderCount(notification) >= reminderAttemptsCap) {
    reasons.push("max_reminder_attempts_reached");
  }
  if (escalateAfterHours) {
    const createdAt = new Date(notification.created_at).getTime();
    if (
      Number.isFinite(createdAt) &&
      Date.now() - createdAt >= escalateAfterHours * 60 * 60_000
    ) {
      reasons.push("escalation_window_reached");
    }
  }
  if (reasons.length === 0) return null;
  return {
    reason: reasons.join(","),
    escalationPriority: escalationPriority ?? "high",
  };
}

/**
 * For HITL approval notifications, the reminder/escalation only makes sense
 * while the underlying tool call is still awaiting confirmation. If it has
 * already been approved/rejected, we resolve the notification instead of
 * sending a stale "still pending" nudge.
 */
async function resolveStaleToolConfirmationNotification(
  db: ReturnType<typeof createServerClient>,
  notification: InternalUserNotification
): Promise<boolean> {
  if (notification.kind !== TOOL_CONFIRMATION_PENDING_KIND) return false;
  const pendingToolCallId = notificationMetadataPendingToolCallId(
    notification.metadata_jsonb
  );
  if (pendingToolCallId) {
    const stillPending = await getPendingToolCall(db, pendingToolCallId);
    if (stillPending) return false;
  } else if (notification.case_id) {
    const pendingForCase = await countPendingToolCallsForCase(db, notification.case_id);
    if (pendingForCase > 0) return false;
  } else {
    return false;
  }
  await setInternalUserNotificationStatus(db, {
    id: notification.id,
    userId: notification.user_id,
    status: "actioned",
  });
  if (notification.case_id) {
    await insertOperationalCaseEvent(db, {
      caseId: notification.case_id,
      eventType: "state_changed",
      actor: "system",
      payload: {
        source: "internal_user_notifications",
        kind: "tool_confirmation_reminder_resolved_stale",
        notification_id: notification.id,
        pending_tool_call_id: pendingToolCallId ?? null,
      },
    });
  }
  return true;
}

async function maybeSelfHealToolConfirmationNotification(
  db: ReturnType<typeof createServerClient>,
  stepLabelResolver: OperationalStepLabelResolver,
  notification: InternalUserNotification
): Promise<InternalUserNotification> {
  if (
    notification.kind !== TOOL_CONFIRMATION_PENDING_KIND ||
    !notification.case_id
  ) {
    return notification;
  }
  const pendingCalls = await listPendingCaseToolCalls(
    db,
    notification.user_id,
    notification.case_id
  );
  const pendingReference = pendingCalls[0];
  if (!pendingReference) return notification;

  const shouldRefresh = shouldRefreshToolConfirmationNotification({
    kind: notification.kind,
    body: notification.body,
    metadata: notification.metadata_jsonb,
    pendingToolCallId: pendingReference.id,
  });
  if (!shouldRefresh) return notification;

  const opCase = await getOperationalCase(db, notification.case_id);
  if (!opCase || opCase.user_id !== notification.user_id) return notification;

  const refreshedBody = (
    await buildPendingToolDescription(
      stepLabelResolver,
      opCase,
      pendingReference,
      pendingCalls.length
    )
  ).text;
  const refreshed = await refreshInternalUserNotificationContent(
    db,
    notification,
    {
      body: refreshedBody,
      metadata: {
        pending_tool_call_id: pendingReference.id,
        pending_tool_name: pendingReference.tool_name,
      },
    }
  );
  return refreshed ?? notification;
}

async function getInternalUserNotificationStillUnread(
  db: ReturnType<typeof createServerClient>,
  notificationId: string,
  userId: string
): Promise<boolean> {
  const fresh = await getInternalUserNotification(db, notificationId);
  return Boolean(fresh && fresh.user_id === userId && fresh.status === "unread");
}

async function processInternalNotificationReminder(
  db: ReturnType<typeof createServerClient>,
  stepLabelResolver: OperationalStepLabelResolver,
  notification: InternalUserNotification,
  deliveryContextCache: Map<string, ReminderDeliveryContext>
) {
  let currentNotification = notification;
  if (currentNotification.case_id) {
    const notificationCase = await getOperationalCase(
      db,
      currentNotification.case_id
    );
    if (
      notificationCase &&
      isInternalCaseNotificationObsolete({
        notification: currentNotification,
        opCase: notificationCase,
      })
    ) {
      await setInternalUserNotificationStatus(db, {
        id: currentNotification.id,
        userId: currentNotification.user_id,
        status: "actioned",
      });
      return "resolved_obsolete_stage";
    }
  }
  if (await resolveStaleToolConfirmationNotification(db, currentNotification)) {
    return "resolved_stale";
  }
  currentNotification = await maybeSelfHealToolConfirmationNotification(
    db,
    stepLabelResolver,
    currentNotification
  );
  const deliveryContext = await loadReminderDeliveryContext(
    db,
    currentNotification.user_id,
    deliveryContextCache
  );
  const kindConfig = internalNotificationKindConfig(currentNotification.kind);
  const activeChannelForPolicy = currentNotification.case_id
    ? await getActiveCaseInternalChannel({
        db,
        caseId: currentNotification.case_id,
      }).catch(() => null)
    : null;
  const policy = resolveEngagementPolicy(
    {
      audience: "internal_user",
      intent: kindConfig.intent ?? "reminder",
      kind: kindConfig.kind,
      priority: currentNotification.priority,
      channel: activeChannelForPolicy === "web" ? "web" : "telegram",
    },
    deliveryContext.engagementOverrides
  );
  if (policy.respectWorkingHours) {
    const nextAllowed = nextAllowedDeliveryAt({
      now: new Date(),
      timezone:
        policy.deliveryWindow?.timezone?.trim() || deliveryContext.timezone || "UTC",
      window: policy.deliveryWindow,
    });
    if (nextAllowed.getTime() > Date.now() + 1000) {
      await deferInternalNotificationReminder(db, currentNotification, nextAllowed);
      return "deferred_window";
    }
  }
  const escalation = shouldEscalateInternalReminder(
    currentNotification,
    deliveryContext.engagementOverrides
  );
  if (escalation) {
    const escalated = await markInternalNotificationEscalated(db, currentNotification, {
      priority: escalation.escalationPriority,
      reason: escalation.reason,
    });
    const pendingToolCallId = notificationMetadataPendingToolCallId(
      currentNotification.metadata_jsonb
    );
    // Re-check: el usuario pudo cancelar/descartar mientras corría el cron.
    const stillUnreadEscalation = await getInternalUserNotificationStillUnread(
      db,
      currentNotification.id,
      currentNotification.user_id
    );
    if (!stillUnreadEscalation) return "resolved_before_send";
    await notifyUserRespectingActiveInternalChannel(
      db,
      currentNotification.user_id,
      {
        text:
          currentNotification.kind === TOOL_CONFIRMATION_PENDING_KIND
            ? buildToolConfirmationEscalationText({
                title: currentNotification.title,
                body: currentNotification.body,
              })
            : `Escalación: sigue pendiente «${currentNotification.title}». ` +
              "Revísalo cuanto antes en Pendientes o en el flujo del caso.",
        kind: "internal_notification_escalation",
        data: {
          case_id: currentNotification.case_id ?? undefined,
          title: `Escalación: ${currentNotification.title}`,
          source_notification_id: currentNotification.id,
          escalation_reason: escalation.reason,
          pending_tool_call_id: pendingToolCallId,
        },
      },
      "high"
    );
    if (currentNotification.case_id) {
      await insertOperationalCaseEvent(db, {
        caseId: currentNotification.case_id,
        eventType: "escalated",
        actor: "system",
        payload: {
          source: "internal_user_notifications",
          notification_id: currentNotification.id,
          reason: escalation.reason,
          priority: escalated?.priority ?? "high",
          pending_tool_call_id: pendingToolCallId,
        },
      });
    }
    return "escalated";
  }
  if (
    !shouldSendInternalReminder(currentNotification, deliveryContext.engagementOverrides)
  ) {
    return "cooldown";
  }
  const pendingToolCallId = notificationMetadataPendingToolCallId(
    currentNotification.metadata_jsonb
  );

  let reminderText = `Recordatorio: ${currentNotification.title}\n\n${currentNotification.body}`;
  let uploadBatchPurpose: string | null = null;
  if (
    isUploadBatchNotificationKind(currentNotification.kind) &&
    currentNotification.case_id
  ) {
    const opCase = await getOperationalCase(db, currentNotification.case_id);
    const expectedKind = uploadBatchKindFromNotificationKind(currentNotification.kind);
    const liveKind = opCase ? resolveUploadBatchKind(opCase) : null;
    if (!opCase || !expectedKind || liveKind !== expectedKind) {
      // Caso ya avanzó o ya no espera esta carga: cierra el pendiente.
      await setInternalUserNotificationStatus(db, {
        id: currentNotification.id,
        userId: currentNotification.user_id,
        status: "actioned",
      });
      return "resolved_stale_upload_batch";
    }
    const fileCount = await countCaseUploadFiles({
      db,
      opCase,
      batchKind: expectedKind,
    });
    if (fileCount > 0) {
      reminderText = formatUploadBatchConfirmationReminderText({
        batchKind: expectedKind,
        fileCount,
        context: opCase.context_jsonb,
      });
      uploadBatchPurpose = UPLOAD_BATCH_CONFIRMATION_PURPOSE;
    }
    // fileCount === 0: keep the original request nudge (still waiting for uploads).
  }

  const stillUnreadReminder = await getInternalUserNotificationStillUnread(
    db,
    currentNotification.id,
    currentNotification.user_id
  );
  if (!stillUnreadReminder) return "resolved_before_send";
  await notifyUserRespectingActiveInternalChannel(
    db,
    currentNotification.user_id,
    {
      text: reminderText,
      kind: "internal_notification_reminder",
      data: {
        case_id: currentNotification.case_id ?? undefined,
        title: `Recordatorio: ${currentNotification.title}`,
        source_notification_id: currentNotification.id,
        pending_tool_call_id: pendingToolCallId,
        ...(uploadBatchPurpose ? { purpose: uploadBatchPurpose } : {}),
      },
    },
    currentNotification.priority === "high" ? "high" : "normal"
  );
  await markInternalNotificationReminderSent(db, currentNotification);
  if (currentNotification.case_id) {
    await insertOperationalCaseEvent(db, {
      caseId: currentNotification.case_id,
      eventType: "reminder_sent",
      actor: "system",
      payload: {
        source: "internal_user_notifications",
        notification_id: currentNotification.id,
        pending_tool_call_id: pendingToolCallId,
        ...(uploadBatchPurpose ? { purpose: uploadBatchPurpose } : {}),
      },
    });
  }
  return "reminded";
}

async function processExternalContactReminder(
  db: ReturnType<typeof createServerClient>,
  notification: ExternalContactNotification,
  deliveryContextCache: Map<string, ReminderDeliveryContext>
) {
  if (notification.case_id) {
    const opCase = await getOperationalCase(db, notification.case_id);
    if (opCase && isCronSuppressedOperationalCase(opCase)) {
      await expireExternalContactNotification(db, notification.id);
      return isControlledE2EOperationalCase(opCase)
        ? "skipped_controlled_e2e"
        : "skipped_settings_test";
    }
  }

  if (notification.attempt_count >= notification.max_attempts) {
    await expireExternalContactNotification(db, notification.id);
    await notify(
      db,
      notification.user_id,
      {
        text:
          "Un contacto externo no respondio despues del maximo de recordatorios. " +
          `Caso: ${notification.case_id}. Canal: ${notification.channel}.`,
        kind: "external_contact_escalation",
        data: {
          case_id: notification.case_id,
          title: "Contacto externo sin respuesta",
          external_notification_id: notification.id,
        },
      },
      "high"
    );
    await insertOperationalCaseEvent(db, {
      caseId: notification.case_id,
      eventType: "escalated",
      actor: "system",
      payload: {
        source: "external_contact_notifications",
        notification_id: notification.id,
        reason: "max_attempts_reached",
      },
    });
    return "expired_escalated";
  }

  if (notification.channel !== "telegram") return "unsupported_channel";
  const deliveryContext = await loadReminderDeliveryContext(
    db,
    notification.user_id,
    deliveryContextCache
  );
  const kind =
    typeof notification.metadata_jsonb?.kind === "string"
      ? notification.metadata_jsonb.kind
      : "external_contact_reminder";
  const policy = resolveEngagementPolicy(
    {
      audience: "external_contact",
      intent: "reminder",
      channel: "telegram",
      kind,
    },
    deliveryContext.engagementOverrides
  );
  if (policy.respectWorkingHours) {
    const nextAllowed = nextAllowedDeliveryAt({
      now: new Date(),
      timezone:
        policy.deliveryWindow?.timezone?.trim() || deliveryContext.timezone || "UTC",
      window: policy.deliveryWindow,
    });
    if (nextAllowed.getTime() > Date.now() + 1000) {
      await deferExternalContactReminder(db, notification, nextAllowed);
      return "deferred_window";
    }
  }
  try {
    await sendTelegramMessage(
      Number(notification.recipient_identifier),
      truncateTelegramText(notification.message_body),
      undefined,
      { throwOnError: true }
    );
    await markExternalContactNotificationSent(
      db,
      notification,
      hoursFromNow(
        reminderCooldownHoursForEngagement(
          {
            audience: "external_contact",
            intent: "reminder",
            channel: notification.channel,
            kind,
          },
          deliveryContext.engagementOverrides
        )
      )
    );
    await insertOperationalCaseEvent(db, {
      caseId: notification.case_id,
      eventType: "reminder_sent",
      actor: "system",
      payload: {
        source: "external_contact_notifications",
        notification_id: notification.id,
        channel: notification.channel,
        attempt: notification.attempt_count + 1,
      },
    });
    return "sent";
  } catch (error) {
    await markExternalContactNotificationFailed(
      db,
      notification.id,
      error instanceof Error ? error.message : String(error)
    );
    return "failed";
  }
}

async function processNotificationReminders(
  db: ReturnType<typeof createServerClient>,
  stepLabelResolver: OperationalStepLabelResolver
) {
  const deliveryContextCache = new Map<string, ReminderDeliveryContext>();
  const [internalDue, externalDue] = await Promise.all([
    listDueInternalUserNotifications(db, { limit: 50 }),
    listDueExternalContactNotifications(db, { limit: 50 }),
  ]);
  const internalResults = [];
  for (const notification of internalDue) {
    internalResults.push(
      await processInternalNotificationReminder(
        db,
        stepLabelResolver,
        notification,
        deliveryContextCache
      )
    );
  }
  const externalResults = [];
  for (const notification of externalDue) {
    externalResults.push(
      await processExternalContactReminder(
        db,
        notification,
        deliveryContextCache
      )
    );
  }
  return { internal: internalResults, external: externalResults };
}

async function processCase(
  db: ReturnType<typeof createServerClient>,
  stepLabelResolver: OperationalStepLabelResolver,
  opCase: OperationalCase
): Promise<CaseProcessResult> {
  if (isCronSuppressedOperationalCase(opCase)) {
    return { case_id: opCase.id, status: "skipped" };
  }
  if (
    opCase.context_jsonb?.created_from === "agent_conversation" &&
    opCase.current_step === "intake" &&
    opCase.context_jsonb?.intake_status !== "complete"
  ) {
    if (opCase.next_action_at) {
      await updateOperationalCase(db, opCase.id, opCase.version, {
        nextActionAt: null,
      });
    }
    await insertOperationalCaseEvent(db, {
      caseId: opCase.id,
      eventType: "step_completed",
      actor: "system",
      payload: {
        kind: "cron_skipped_incomplete_conversational_intake",
        source: "cron",
        current_step: opCase.current_step,
        status: opCase.status,
      },
    });
    return { case_id: opCase.id, status: "skipped" };
  }
  if (opCase.current_step === "package_ready") {
    const packageContext =
      opCase.context_jsonb &&
      typeof opCase.context_jsonb === "object" &&
      !Array.isArray(opCase.context_jsonb)
        ? (opCase.context_jsonb as Record<string, unknown>)
        : {};
    const listingApproved = Boolean(packageContext.listing_description_approved);
    if (
      !listingApproved ||
      listingDescriptionReviewNeedsRegeneration(packageContext)
    ) {
      await runSettingsTestCaseAgentTick(
        db,
        opCase,
        opCase.user_id,
        { source: "cron_package_ready_listing_review" }
      );
      return {
        case_id: opCase.id,
        status: "ok",
      };
    }
    const progress = await requestPublicationProgress(
      db,
      opCase.id,
      "cron_publication",
      {
        runAgentTick: createPublicationRunnerOwnedAgentTick(
          db,
          opCase.user_id,
          "cron_publication"
        ),
      }
    );
    return {
      case_id: opCase.id,
      status: progress.ok ? "ok" : "error",
      ...(progress.message ? { error: progress.message } : {}),
    };
  }

  const locked = await markCaseProcessing(db, opCase.id, opCase.version);
  if (!locked) {
    return { case_id: opCase.id, status: "skipped" };
  }
  const lockedCase = { ...opCase, version: opCase.version + 1 };

  try {
    if (
      lockedCase.current_step === "awaiting_documents" ||
      lockedCase.current_step === "photos_requested"
    ) {
      const requestTarget = resolveOperationalCaseDocumentRequestTarget({
        externalContact: lockedCase.external_contact_jsonb,
        context: lockedCase.context_jsonb,
      });
      const externalChatId =
        lockedCase.external_contact_jsonb?.channel === "telegram" &&
        typeof lockedCase.external_contact_jsonb.chat_id === "number"
          ? lockedCase.external_contact_jsonb.chat_id
          : null;
      // Photos are always internal-advisor uploads; documents may be internal or external.
      const targetChatId =
        lockedCase.current_step === "photos_requested" ||
        requestTarget === "internal_user"
          ? await getTelegramChatId(db, opCase.user_id)
          : externalChatId;
      if (targetChatId) {
        const flush = await flushMediaGroupAcksForCase({
          db,
          opCase: lockedCase,
          chatId: targetChatId,
          sendAck: async (files) => {
            await sendTelegramMessage(
              targetChatId,
              buildMediaGroupReceivedAck(files)
            );
          },
        });
        if (flush.flushed > 0) {
          await updateOperationalCase(db, opCase.id, flush.opCase.version, {
            nextActionAt: new Date(Date.now() + 15_000).toISOString(),
          });
          return { case_id: opCase.id, status: "ok" };
        }
      }
    }

    const pendingHitlCount = await countPendingToolCallsForCase(db, opCase.id);
    if (pendingHitlCount > 0) {
      await ensurePendingHitlAdvisorNotice(db, stepLabelResolver, opCase);
      const fresh = await getOperationalCase(db, opCase.id);
      if (fresh) {
        await updateOperationalCase(db, fresh.id, fresh.version, {
          nextActionAt: null,
        });
      }
      console.log(
        `[ops-case-cron] case ${opCase.id} skipped: ${pendingHitlCount} pending HITL tool call(s) awaiting human approval`
      );
      return { case_id: opCase.id, status: "skipped" };
    }

    await resolveUnreadInternalNotificationsByKindForCaseWithReminders(db, {
      userId: opCase.user_id,
      caseId: opCase.id,
      kind: TOOL_CONFIRMATION_PENDING_KIND,
      status: "actioned",
    });

    const profile = await getProfile(db, opCase.user_id);
    const toolSettings = await getUserToolSettings(db, opCase.user_id);
    const skillSettings = await getUserSkillSettings(db, opCase.user_id);
    const integrations = await getUserIntegrations(db, opCase.user_id);

    const githubIntegration = integrations.find(
      (i) => i.provider === "github"
    );
    let githubToken: string | undefined;
    if (githubIntegration) {
      const raw = (githubIntegration as unknown as {
        encrypted_tokens?: string;
      }).encrypted_tokens;
      if (raw) {
        try {
          githubToken = decryptToken(raw);
        } catch {
          // No GitHub token available
        }
      }
    }

    const googleCalendarAccessToken =
      (await getGoogleCalendarAccessToken(db, opCase.user_id)) ?? undefined;

    // Una sesión persistente por caso (canal case_runner). Como
    // getOrCreateSession busca por (user_id, channel) y devuelve la activa,
    // si quisiéramos una sesión por caso necesitaríamos cambiar la query.
    // Por ahora compartimos sesión `case_runner` por usuario y diferenciamos
    // por turn_id; basta para auditoría inicial. Cuando haya volumen, se
    // particiona por case_id (ver TODO en architecture.md sección 10).
    const session = await getOrCreateSession(db, opCase.user_id, "case_runner");

    const result = await runAgent({
      message: buildCaseTickMessage(opCase),
      userId: opCase.user_id,
      sessionId: session.id,
      systemPrompt: profile.agent_system_prompt,
      db,
      enabledTools: toolSettings,
      enabledSkills: skillSettings,
      integrations,
      githubToken,
      userTimezone: profile.timezone,
      userName: profile.name,
      userEmail: profile.email,
      userPhone: profile.phone,
      businessBrain: profile.business_brain ?? {},
      isUnggaAdmin: profile.is_ungga_admin ?? false,
      channel: "case_runner",
      googleCalendarAccessToken,
      // No autoApproveTools por defecto: las decisiones de juicio comercial
      // (precio, contrato, publicación) deben pasar por HITL aunque las
      // dispare el cron. Si el agente llega a un tool con `risk: high` que
      // requiere confirmación, el HITL queda pendiente y se notifica al
      // usuario; la próxima interacción humana lo resuelve.
      autoApproveTools: false,
      // Bookkeeping interno del caso no es una decisión humana. Las acciones
      // externas/comerciales de riesgo conservan su HITL normal.
      toolApprovalPolicy: buildOperationalCaseCronToolApprovalPolicy(opCase),
      caseId: opCase.id,
    });

    console.log(
      `[ops-case-cron] case ${opCase.id} processed: response_len=${result.response?.length ?? 0} pending_confirmation=${result.pendingConfirmation ? "yes" : "no"}`
    );

    let turnToolCalls: TurnToolCallRow[] = [];
    if (result.turnId) {
      const { data: toolCallRows } = await db
        .from("tool_calls")
        .select("tool_name, status, result_json")
        .eq("turn_id", result.turnId)
        .order("created_at", { ascending: true });
      turnToolCalls = (toolCallRows ?? []) as TurnToolCallRow[];
      const freshCase = (await getOperationalCase(db, opCase.id)) ?? opCase;
      await syncContractDraftFromToolCalls(
        db,
        freshCase,
        turnToolCalls as Array<{
          tool_name: string;
          status: string;
          result_json?: unknown;
        }>
      );
    }

    // Si el agente dejó un caso property_optioning en un punto operacional
    // incompleto, aplicamos las mismas invariantes que usa el E2E.
    const fresh = await getOperationalCase(db, opCase.id);
    const invariantResult = await applyPropertyOptioningPostAgentInvariants({
      db,
      opCase: fresh,
      source: "post_agent_invariant_cron",
    });
    let caseAfterInvariants = await stabilizeInternalDocumentWait(
      db,
      invariantResult.case ?? fresh
    );
    if (
      !result.pendingConfirmation &&
      caseAfterInvariants?.current_step === "photos_requested"
    ) {
      const photosRequest = await ensurePhotosUploadRequestForCase({
        db,
        opCase: caseAfterInvariants,
        source: "operational_cases_cron",
      });
      caseAfterInvariants = photosRequest.case;
    }

    if (result.pendingConfirmation) {
      // Notify in the same tick that created HITL — don't wait for the next
      // cron pass to surface approve/reject to the advisor.
      const caseForHitl = caseAfterInvariants ?? opCase;
      await ensurePendingHitlAdvisorNotice(db, stepLabelResolver, caseForHitl);
      const freshForHitl = await getOperationalCase(db, opCase.id);
      if (freshForHitl) {
        await updateOperationalCase(db, freshForHitl.id, freshForHitl.version, {
          nextActionAt: null,
        });
      }
      return { case_id: opCase.id, status: "ok" };
    }

    // Manejo determinista compartido del paso de contrato (misma ruta que el
    // tick E2E): asegura contract_review / contract_data_review y, si el agente
    // no generó el DOCX pese a tener precio + datos, renderiza el contrato.
    let contractHumanWait = false;
    if (caseAfterInvariants) {
      const contractHandling = await applyPostAgentContractHandling({
        db,
        userId: opCase.user_id,
        opCase: caseAfterInvariants,
        toolCalls: turnToolCalls,
        pendingConfirmation: false,
        source: "operational_cases_cron",
        toolContext: {
          sessionId: session.id,
          enabledTools: toolSettings,
          integrations,
          userTimezone: profile.timezone,
        },
      });
      contractHumanWait = contractHandling.handled && contractHandling.humanWait;
    }

    // Si el manejo de contrato dejó el caso esperando una acción/decisión
    // humana (revisión, datos faltantes, titularidad, plantilla), no re-armamos
    // el cron: se comporta como un HITL.
    if (contractHumanWait) {
      const freshForWait = await getOperationalCase(db, opCase.id);
      if (freshForWait && freshForWait.next_action_at) {
        await updateOperationalCase(db, freshForWait.id, freshForWait.version, {
          nextActionAt: null,
        });
      }
      return { case_id: opCase.id, status: "ok" };
    }

    // Si el agente NO actualizó next_action_at (no movió el caso), lo
    // empujamos a +5min para que no martillemos esto cada minuto. El agente
    // bien escrito lo hace solo, pero esto es defensivo.
    // Exception: internal document waits are event-driven (upload / «listo»).
    // Re-arming +5min here undoes stabilizeInternalDocumentWait and re-sends
    // the same document request on every cron pass.
    if (caseAfterInvariants) {
      const isStillStuckAtLease =
        caseAfterInvariants.status === opCase.status &&
        caseAfterInvariants.current_step === opCase.current_step;
      if (
        isStillStuckAtLease &&
        !isInternalDocumentEventDrivenWait(caseAfterInvariants)
      ) {
        await updateOperationalCase(db, caseAfterInvariants.id, caseAfterInvariants.version, {
          nextActionAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        });
      }
    }

    return { case_id: opCase.id, status: "ok" };
  } catch (e) {
    const errMsg = (e as Error)?.message ?? "Unknown error";
    console.error(`[ops-case-cron] case ${opCase.id} failed:`, errMsg);
    try {
      await insertOperationalCaseEvent(db, {
        caseId: opCase.id,
        eventType: "error",
        actor: "system",
        payload: { error: errMsg.slice(0, 2000), source: "cron" },
      });
      // Defensivo: pateamos next_action_at +10 min para no martillear con
      // un caso que falla en cada tick.
      const fresh = await getOperationalCase(db, opCase.id);
      if (fresh) {
        await updateOperationalCase(db, fresh.id, fresh.version, {
          nextActionAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        });
      }
    } catch (logErr) {
      console.error("[ops-case-cron] failed to record error event:", logErr);
    }
    return { case_id: opCase.id, status: "error", error: errMsg };
  }
}

async function processWithConcurrency(
  db: ReturnType<typeof createServerClient>,
  stepLabelResolver: OperationalStepLabelResolver,
  cases: OperationalCase[],
  concurrency: number
): Promise<CaseProcessResult[]> {
  const results: CaseProcessResult[] = [];
  const queue = [...cases];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const next = queue.shift();
      if (!next) break;
      const r = await processCase(db, stepLabelResolver, next);
      results.push(r);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!APP_URL || !/^https?:\/\//i.test(APP_URL)) {
    console.warn(
      "[ops-case-cron] APP_URL missing or invalid; pending HITL Telegram messages will not include an absolute web link."
    );
  }

  ensureAgentToolDepsWired();
  const db = createServerClient();
  const stepLabelResolver = new OperationalStepLabelResolver(db);

  let notificationReminderResults: Awaited<
    ReturnType<typeof processNotificationReminders>
  > = { internal: [], external: [] };
  try {
    notificationReminderResults = await processNotificationReminders(
      db,
      stepLabelResolver
    );
  } catch (e) {
    console.error("[ops-case-cron] notification reminders failed:", e);
  }

  let dueCases: OperationalCase[] = [];
  try {
    dueCases = await getDueOperationalCases(db, { limit: 100 });
  } catch (e) {
    console.error("[ops-case-cron] getDueOperationalCases failed:", e);
    return NextResponse.json(
      { error: "Failed to read operational cases" },
      { status: 500 }
    );
  }

  const cronSuppressedCases = dueCases.filter(isCronSuppressedOperationalCase);
  if (cronSuppressedCases.length > 0) {
    for (const opCase of cronSuppressedCases) {
      try {
        await expireExternalContactNotificationsForCase(db, opCase.id);
        const controlledE2E = isControlledE2EOperationalCase(opCase);
        await updateOperationalCase(db, opCase.id, opCase.version, {
          status: controlledE2E ? opCase.status : "paused",
          nextActionAt: null,
          context: {
            ...(opCase.context_jsonb ?? {}),
            ...(controlledE2E
              ? {
                  e2e_control_status: "cron_suppressed",
                  e2e_control_note:
                    "El cron no continua casos E2E controlados; usa Prueba con agente.",
                }
              : {
                  controlled_test_status: "paused_by_cron_guard",
                  controlled_test_note:
                    "El cron no continua casos de prueba creados desde Settings.",
                }),
          },
        });
      } catch (error) {
        console.warn(
          `[ops-case-cron] failed to pause cron-suppressed case ${opCase.id}:`,
          error
        );
      }
    }
  }

  dueCases = dueCases.filter((opCase) => !isCronSuppressedOperationalCase(opCase));
  const skippedSettingsTestCases = cronSuppressedCases.filter(
    isSettingsOperationalTestCase
  ).length;
  const skippedControlledE2ECases = cronSuppressedCases.filter(
    isControlledE2EOperationalCase
  ).length;

  if (dueCases.length === 0) {
    const workPlane = await runWorkPlanePassSafely(db);
    return NextResponse.json({
      processed: 0,
      results: [],
      skipped_settings_test_cases: skippedSettingsTestCases,
      skipped_controlled_e2e_cases: skippedControlledE2ECases,
      notification_reminders: notificationReminderResults,
      work_plane: workPlane,
    });
  }

  const concurrencyEnv = process.env.OPERATIONAL_CASES_CONCURRENCY?.trim();
  const concurrency =
    concurrencyEnv && Number.isFinite(Number(concurrencyEnv))
      ? Math.max(1, Math.min(20, Math.floor(Number(concurrencyEnv))))
      : DEFAULT_CONCURRENCY;

  const results = await processWithConcurrency(
    db,
    stepLabelResolver,
    dueCases,
    concurrency
  );

  console.log(
    `[ops-case-cron] processed ${results.length}/${dueCases.length} cases (concurrency=${concurrency}):`,
    results.map((r) => `${r.case_id}=${r.status}`).join(", ")
  );

  // Pass v2 (work plane, Slice 2.3): corre después del loop v1, solo para
  // tenants con el flag `work_plane_v2`. Sin estado mutable compartido con v1.
  const workPlane = await runWorkPlanePassSafely(db);

  return NextResponse.json({
    processed: results.length,
    results,
    skipped_settings_test_cases: skippedSettingsTestCases,
    skipped_controlled_e2e_cases: skippedControlledE2ECases,
    notification_reminders: notificationReminderResults,
    work_plane: workPlane,
  });
}

/** El pass v2 nunca rompe el response del cron v1. */
async function runWorkPlanePassSafely(
  db: ReturnType<typeof createServerClient>
): Promise<WorkPlaneCronSummary | { error: string }> {
  try {
    const summary = await runWorkPlaneCronPass(db);
    if (summary.enabledTenants > 0) {
      console.log(
        `[ops-case-cron] work-plane pass: ${summary.tenants.length}/${summary.enabledTenants} tenants,`,
        summary.tenants
          .map(
            (t) =>
              `${t.userId}={items:${t.tick.processed.length},advanced:${t.tick.advanced.length},recovered:${t.tick.recovered}}`
          )
          .join(", "),
        summary.errors.length > 0 ? summary.errors : ""
      );
    }
    return summary;
  } catch (e) {
    const message = (e as Error)?.message ?? "work plane pass failed";
    console.error("[ops-case-cron] work-plane pass failed:", message);
    return { error: message };
  }
}
