/**
 * notify(userId, payload, urgency)
 *
 * Capa unificada para mandar al humano interno (el inmobiliario) avisos
 * proactivos del agente: recordatorios, aprobaciones pendientes, escalaciones.
 *
 * Lee `user_notification_preferences.channels_priority_jsonb` (default
 * `["web", "telegram"]`) y registra siempre una notificación web persistente:
 *
 *   - `web`: se almacena en `internal_user_notifications` como inbox/action item.
 *   - `telegram`: usa `getTelegramChatId(db, userId)` y manda con
 *     `sendTelegramMessage`.
 *
 * Urgencia:
 *   - `low` / `normal`: registra web y manda por un canal push habilitado.
 *   - `high`: registra web y manda por todos los canales habilitados.
 *
 * Devuelve un resumen de qué canales se intentaron y el resultado de cada
 * uno, para que el caller persista el evento `reminder_sent` o `escalated`
 * en `operational_case_events`.
 */
import {
  createInternalUserNotification,
  createServerClient,
  getInternalUserNotification,
  getOperationalCase,
  getPendingToolCall,
  getTelegramChatId,
  setInternalUserNotificationStatus,
  updateInternalUserNotificationChannels,
  upsertActiveInternalUserNotification,
} from "@agents/db";
import {
  sendTelegramMessage,
  truncateTelegramText,
} from "@/lib/telegram/send-message";
import {
  autoStatusOnCreateForNotificationKind,
  defaultDueAtForNotificationKind,
  internalNotificationKindConfig,
} from "@/lib/internal-notifications/registry";
import { defaultDueAtForEngagement } from "@/lib/engagement-policies/registry";
import type { NotificationChannel } from "@agents/types";
import {
  buildCaseDocumentDownloadUrl,
  caseDocumentDownloadPath,
  defaultDownloadLabel,
  generatedCaseDocumentBindingForNotifyKind,
  normalizeNotifyTextReplacingSignedUrls,
  parseGeneratedDocumentFromContext,
  resolveGeneratedDocumentOutputPathFromCase,
  resolveGeneratedDocumentDeliveryUrl,
  dedupeConcatenatedSiteOriginInUrl,
  replaceCaseDocumentDownloadUrlsForExternalAudience,
  rewriteCaseDocumentDownloadLinksInText,
} from "@/lib/operational-cases/generated-case-document";
import { buildExternalCaseDocumentDownloadUrl } from "@/lib/operational-cases/case-document-download-token";
import { resolvePendingToolCallId } from "@/lib/notify/pending-tool-call-id";

export type NotifyUrgency = "low" | "normal" | "high";

const DEFAULT_PRIORITY: NotificationChannel[] = ["web", "telegram"];

/** Botones HITL de contrato solo cuando hay borrador real para revisar. */
function contractReviewOffersHitlActions(payload: NotifyPayload): boolean {
  if (payload.kind === "contract_template_missing") return false;
  const text = (payload.text ?? "").toLowerCase();
  if (
    /falta la plantilla|plantilla docx|no está configurada|sin plantilla|not_configured/i.test(
      text
    )
  ) {
    return false;
  }
  if (
    /\/documents\/contract_draft\/download|\/api\/public\/operational-cases\/documents\/download|descargar borrador del contrato/i.test(
      payload.text ?? ""
    )
  ) {
    return true;
  }
  return payload.data?.contract_draft_ready === true;
}

export interface NotifyPayload {
  text: string;
  /** Etiqueta corta para logs y UI futura (ej. "case_reminder"). */
  kind?: string;
  /** Datos estructurados adicionales (ej. case_id) para auditoría / UI. */
  data?: Record<string, unknown>;
}

export interface NotifyChannelResult {
  channel: NotificationChannel;
  ok: boolean;
  status?: "stored" | "delivered" | "not_configured" | "failed";
  reason?: string;
}

export interface NotifyResult {
  attempted: NotifyChannelResult[];
  delivered: NotifyChannelResult[];
}

export interface NotifyOptions {
  pushChannels?: NotificationChannel[];
}

async function loadPriority(
  db: ReturnType<typeof createServerClient>,
  userId: string
): Promise<{
  channels: NotificationChannel[];
  engagementOverrides: Record<string, unknown> | null;
}> {
  const { data, error } = await db
    .from("user_notification_preferences")
    .select("channels_priority_jsonb, engagement_policy_overrides_jsonb")
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data) {
    return { channels: DEFAULT_PRIORITY, engagementOverrides: null };
  }
  const raw = (data as { channels_priority_jsonb?: unknown })
    .channels_priority_jsonb;
  if (!Array.isArray(raw)) {
    return { channels: DEFAULT_PRIORITY, engagementOverrides: null };
  }
  const cleaned = raw
    .filter((v): v is string => typeof v === "string")
    .filter((v): v is NotificationChannel =>
      ["web", "telegram", "email", "whatsapp"].includes(v)
    );
  const engagementOverrides =
    (data as { engagement_policy_overrides_jsonb?: unknown })
      .engagement_policy_overrides_jsonb &&
    typeof (data as { engagement_policy_overrides_jsonb?: unknown })
      .engagement_policy_overrides_jsonb === "object"
      ? ((data as { engagement_policy_overrides_jsonb?: unknown })
          .engagement_policy_overrides_jsonb as Record<string, unknown>)
      : null;
  return {
    channels: cleaned.length > 0 ? cleaned : DEFAULT_PRIORITY,
    engagementOverrides,
  };
}

async function deliverTelegram(
  db: ReturnType<typeof createServerClient>,
  userId: string,
  payload: NotifyPayload
): Promise<NotifyChannelResult> {
  const chatId = await getTelegramChatId(db, userId);
  if (!chatId) {
    return {
      channel: "telegram",
      ok: false,
      status: "not_configured",
      reason: "no_telegram_account_linked",
    };
  }
  const notificationId =
    typeof payload.data?.notification_id === "string"
      ? payload.data.notification_id
      : "";
  const reminderSourceNotificationId =
    typeof payload.data?.source_notification_id === "string"
      ? payload.data.source_notification_id
      : "";
  let actionKind = payload.kind;
  let actionNotificationId = notificationId;
  // Reminders and escalations carry a `source_notification_id` pointing at the
  // original actionable notification. Resolve the original kind so the reminder
  // keeps the SAME primary action (e.g. a HITL reminder must still let the user
  // approve/reject), instead of degrading into a passive text-only nudge.
  let sourceNotificationMetadata: Record<string, unknown> | null = null;
  if (reminderSourceNotificationId) {
    actionNotificationId = reminderSourceNotificationId;
    const sourceNotification = await getInternalUserNotification(
      db,
      reminderSourceNotificationId
    );
    if (sourceNotification?.user_id === userId) {
      actionKind = sourceNotification.kind;
      sourceNotificationMetadata =
        sourceNotification.metadata_jsonb &&
        typeof sourceNotification.metadata_jsonb === "object"
          ? (sourceNotification.metadata_jsonb as Record<string, unknown>)
          : null;
    }
  }
  let replyMarkup:
    | { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }
    | undefined;
  if (actionKind === "tool_confirmation_pending") {
    // Resolve the underlying tool_call id from the payload (direct path) or the
    // source notification metadata (reminder/escalation path).
    const pendingToolCallId = resolvePendingToolCallId(
      payload.data,
      sourceNotificationMetadata
    );
    // Only attach approve/reject buttons if the tool call is STILL awaiting
    // confirmation. `getPendingToolCall` returns null once it has been
    // executed/rejected, which prevents stale actions on an already-resolved
    // approval.
    if (pendingToolCallId) {
      const stillPending = await getPendingToolCall(db, pendingToolCallId);
      if (stillPending) {
        replyMarkup = {
          inline_keyboard: [
            [
              { text: "✅ Aprobar", callback_data: `approve:${pendingToolCallId}` },
              { text: "❌ Cancelar", callback_data: `reject:${pendingToolCallId}` },
            ],
          ],
        };
      }
    }
  } else if (actionKind === "price_approval" && actionNotificationId) {
    replyMarkup = {
      inline_keyboard: [
        [
          {
            text: "Aprobar precio",
            callback_data: `price_approve:${actionNotificationId}`,
          },
        ],
        [
          {
            text: "Ajustar y aprobar",
            callback_data: `price_adjust:${actionNotificationId}`,
          },
        ],
      ],
    };
  } else if (
    actionKind === "contract_review" &&
    actionNotificationId &&
    contractReviewOffersHitlActions(payload)
  ) {
    replyMarkup = {
      inline_keyboard: [
        [
          {
            text: "Mandar al dueño",
            callback_data: `contract_approve_send:${actionNotificationId}`,
          },
        ],
        [
          {
            text: "Pedir cambios",
            callback_data: `contract_request_changes:${actionNotificationId}`,
          },
        ],
      ],
    };
  } else if (actionKind === "property_data_review" && actionNotificationId) {
    replyMarkup = {
      inline_keyboard: [
        [
          {
            text: "Confirmar datos",
            callback_data: `property_data_confirm:${actionNotificationId}`,
          },
        ],
        [
          {
            text: "Enviar corrección",
            callback_data: `property_data_correct:${actionNotificationId}`,
          },
        ],
      ],
    };
  }
  const text = truncateTelegramText(payload.text);
  let lastError: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await sendTelegramMessage(chatId, text, replyMarkup, {
        throwOnError: true,
      });
      return { channel: "telegram", ok: true, status: "delivered" };
    } catch (e) {
      lastError = (e as Error).message ?? String(e);
    }
  }
  return {
    channel: "telegram",
    ok: false,
    status: "failed",
    reason: lastError ?? "send_failed",
  };
}

const DELIVERERS: Record<
  NotificationChannel,
  (
    db: ReturnType<typeof createServerClient>,
    userId: string,
    payload: NotifyPayload
  ) => Promise<NotifyChannelResult>
> = {
  web: async () => ({ channel: "web", ok: true, status: "stored" }),
  telegram: deliverTelegram,
  // Stubs para canales futuros. Cuando se implementen, swap.
  email: async () => ({
    channel: "email",
    ok: false,
    status: "not_configured",
    reason: "not_implemented",
  }),
  whatsapp: async () => ({
    channel: "whatsapp",
    ok: false,
    status: "not_configured",
    reason: "not_implemented",
  }),
};

function notificationTitle(payload: NotifyPayload) {
  if (typeof payload.data?.title === "string" && payload.data.title.trim()) {
    return payload.data.title.trim();
  }
  if (payload.kind) return internalNotificationKindConfig(payload.kind).label;
  return "Notificacion de Gu";
}

function notificationActionUrl(payload: NotifyPayload) {
  const explicitActionUrl = payload.data?.action_url;
  if (typeof explicitActionUrl === "string" && explicitActionUrl.trim()) {
    return explicitActionUrl.trim();
  }
  if (payload.kind === "integration_reconnect") {
    return "/settings?view=integrations&section=credentials";
  }
  const caseId = payload.data?.case_id;
  if (typeof caseId !== "string" || !caseId.trim()) return null;
  const binding = generatedCaseDocumentBindingForNotifyKind(payload.kind);
  if (binding) {
    return caseDocumentDownloadPath(caseId.trim(), binding.documentKey);
  }
  return `/operational-cases?case=${encodeURIComponent(caseId.trim())}`;
}

async function enrichGeneratedDocumentNotifyPayload(
  db: ReturnType<typeof createServerClient>,
  userId: string,
  payload: NotifyPayload
): Promise<NotifyPayload> {
  const binding = generatedCaseDocumentBindingForNotifyKind(payload.kind);
  if (!binding) return payload;

  const caseId =
    typeof payload.data?.case_id === "string" ? payload.data.case_id.trim() : "";
  if (!caseId) return payload;

  const opCase = await getOperationalCase(db, caseId);
  const draft =
    opCase && opCase.user_id === userId
      ? ((await resolveGeneratedDocumentOutputPathFromCase(db, {
          caseId,
          context: (opCase.context_jsonb ?? {}) as Record<string, unknown>,
          binding,
        })) ??
        parseGeneratedDocumentFromContext(opCase.context_jsonb, binding))
      : null;

  let text = normalizeNotifyTextReplacingSignedUrls({
    text: payload.text,
    caseId,
    storagePath: draft?.output_path ?? null,
    binding,
  });

  const downloadPathSegment = `/documents/${binding.documentKey}/download`;
  text = dedupeConcatenatedSiteOriginInUrl(
    rewriteCaseDocumentDownloadLinksInText({ text, caseId, binding })
  );

  const externalUrl =
    draft?.output_path && opCase
      ? buildExternalCaseDocumentDownloadUrl({
          caseId,
          userId: opCase.user_id,
          documentKey: binding.documentKey,
          outputPath: draft.output_path,
        })
      : null;
  if (externalUrl) {
    text = replaceCaseDocumentDownloadUrlsForExternalAudience({
      text,
      caseId,
      binding,
      externalUrl,
    });
  }

  const deliveryUrl =
    externalUrl ??
    (await resolveGeneratedDocumentDeliveryUrl(db, {
      caseId,
      context: (opCase?.context_jsonb ?? {}) as Record<string, unknown>,
      binding,
      forExternalAudience: true,
    })) ??
    buildCaseDocumentDownloadUrl(caseId, binding);

  if (draft?.output_path && !text.includes(downloadPathSegment) && !text.includes("/api/public/operational-cases/documents/download")) {
    const label = defaultDownloadLabel(
      draft.output_path,
      binding.defaultDownloadLabel
    );
    const link =
      deliveryUrl.startsWith("http") || deliveryUrl.startsWith("/api/public/")
        ? deliveryUrl
        : await resolveGeneratedDocumentDeliveryUrl(db, {
            caseId,
            context: opCase!.context_jsonb as Record<string, unknown>,
            binding,
            forExternalAudience: true,
          }) ?? deliveryUrl;
    text = `${text.trim()}\n\n${label}: ${link}`;
  }

  return { ...payload, text, data: { ...payload.data, contract_draft_ready: Boolean(draft?.output_path) } };
}

function notificationDueAt(
  payload: NotifyPayload,
  engagementOverrides?: Record<string, unknown> | null
) {
  const dueAt = payload.data?.due_at;
  if (typeof dueAt === "string" && dueAt.trim()) return dueAt;
  const config = internalNotificationKindConfig(payload.kind);
  return (
    defaultDueAtForEngagement(
      {
        audience: "internal_user",
        intent: config.intent ?? "reminder",
        kind: config.kind,
      },
      Date.now(),
      engagementOverrides
    ) ?? defaultDueAtForNotificationKind(payload.kind)
  );
}

function shouldReuseActiveNotification(payload: NotifyPayload, caseId: string | null) {
  if (!caseId || !payload.kind) return false;
  return [
    "contract_pending",
    "contract_review",
    "missing_requirements",
    "price_approval",
    "property_data_review",
    "tool_confirmation_pending",
  ].includes(payload.kind);
}

function channelMap(results: NotifyChannelResult[]) {
  return Object.fromEntries(
    results.map((result) => [
      result.channel,
      {
        ok: result.ok,
        status: result.status ?? (result.ok ? "delivered" : "failed"),
        ...(result.reason ? { reason: result.reason } : {}),
      },
    ])
  );
}

export async function notify(
  db: ReturnType<typeof createServerClient>,
  userId: string,
  payload: NotifyPayload,
  urgency: NotifyUrgency = "normal",
  options: NotifyOptions = {}
): Promise<NotifyResult> {
  const effectivePayload = await enrichGeneratedDocumentNotifyPayload(
    db,
    userId,
    payload
  );
  const preference = await loadPriority(db, userId);
  const priority = preference.channels;

  const attempted: NotifyChannelResult[] = [];
  const delivered: NotifyChannelResult[] = [];
  const webResult: NotifyChannelResult = {
    channel: "web",
    ok: true,
    status: "stored",
  };
  attempted.push(webResult);
  delivered.push(webResult);
  const caseId =
    typeof effectivePayload.data?.case_id === "string"
      ? effectivePayload.data.case_id
      : null;
  const notificationInput = {
    userId,
    caseId,
    kind: effectivePayload.kind ?? "general",
    title: notificationTitle(effectivePayload),
    body: effectivePayload.text,
    priority: urgency,
    actionUrl: notificationActionUrl(effectivePayload),
    dueAt: notificationDueAt(effectivePayload, preference.engagementOverrides),
    deliveredChannels: channelMap([webResult]),
    metadata: effectivePayload.data ?? {},
  };
  const notification = shouldReuseActiveNotification(effectivePayload, caseId)
    ? await upsertActiveInternalUserNotification(db, notificationInput)
    : await createInternalUserNotification(db, notificationInput);

  for (const channel of priority) {
    if (channel === "web") continue;
    if (
      Array.isArray(options.pushChannels) &&
      !options.pushChannels.includes(channel)
    ) {
      continue;
    }
    const result = await DELIVERERS[channel](db, userId, {
      ...effectivePayload,
      data: {
        ...(effectivePayload.data ?? {}),
        notification_id: notification.id,
      },
    });
    attempted.push(result);
    if (result.ok) {
      delivered.push(result);
      if (urgency !== "high") break;
    }
  }

  await updateInternalUserNotificationChannels(
    db,
    notification.id,
    channelMap(attempted)
  );

  const autoStatus = autoStatusOnCreateForNotificationKind(effectivePayload.kind);
  if (autoStatus) {
    await setInternalUserNotificationStatus(db, {
      id: notification.id,
      userId,
      status: autoStatus,
    });
  }

  return { attempted, delivered };
}
