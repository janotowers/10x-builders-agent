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
  getTelegramChatId,
  updateInternalUserNotificationChannels,
} from "@agents/db";
import {
  sendTelegramMessage,
  truncateTelegramText,
} from "@/lib/telegram/send-message";
import type { NotificationChannel } from "@agents/types";

export type NotifyUrgency = "low" | "normal" | "high";

const DEFAULT_PRIORITY: NotificationChannel[] = ["web", "telegram"];
const PRICE_APPROVAL_DUE_HOURS = 4;

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

async function loadPriority(
  db: ReturnType<typeof createServerClient>,
  userId: string
): Promise<NotificationChannel[]> {
  const { data, error } = await db
    .from("user_notification_preferences")
    .select("channels_priority_jsonb")
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data) return DEFAULT_PRIORITY;
  const raw = (data as { channels_priority_jsonb?: unknown })
    .channels_priority_jsonb;
  if (!Array.isArray(raw)) return DEFAULT_PRIORITY;
  const cleaned = raw
    .filter((v): v is string => typeof v === "string")
    .filter((v): v is NotificationChannel =>
      ["web", "telegram", "email", "whatsapp"].includes(v)
    );
  return cleaned.length > 0 ? cleaned : DEFAULT_PRIORITY;
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
  try {
    const notificationId =
      typeof payload.data?.notification_id === "string"
        ? payload.data.notification_id
        : "";
    const replyMarkup =
      payload.kind === "price_approval" && notificationId
        ? {
            inline_keyboard: [
              [
                {
                  text: "Aprobar precio",
                  callback_data: `price_approve:${notificationId}`,
                },
              ],
              [
                {
                  text: "Ajustar y aprobar",
                  callback_data: `price_adjust:${notificationId}`,
                },
              ],
            ],
          }
        : undefined;
    await sendTelegramMessage(
      chatId,
      truncateTelegramText(payload.text),
      replyMarkup,
      { throwOnError: true }
    );
    return { channel: "telegram", ok: true, status: "delivered" };
  } catch (e) {
    return {
      channel: "telegram",
      ok: false,
      status: "failed",
      reason: (e as Error).message ?? String(e),
    };
  }
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
  if (payload.kind) return payload.kind.replace(/[_-]+/g, " ");
  return "Notificacion de Gu";
}

function notificationActionUrl(payload: NotifyPayload) {
  const caseId = payload.data?.case_id;
  return typeof caseId === "string" && caseId.trim()
    ? `/operational-cases?case_id=${encodeURIComponent(caseId)}`
    : null;
}

function notificationDueAt(payload: NotifyPayload) {
  const dueAt = payload.data?.due_at;
  if (typeof dueAt === "string" && dueAt.trim()) return dueAt;
  if (payload.kind === "price_approval") {
    return new Date(
      Date.now() + PRICE_APPROVAL_DUE_HOURS * 60 * 60_000
    ).toISOString();
  }
  return null;
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
  urgency: NotifyUrgency = "normal"
): Promise<NotifyResult> {
  const priority = await loadPriority(db, userId);

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
    typeof payload.data?.case_id === "string" ? payload.data.case_id : null;
  const notification = await createInternalUserNotification(db, {
    userId,
    caseId,
    kind: payload.kind ?? "general",
    title: notificationTitle(payload),
    body: payload.text,
    priority: urgency,
    actionUrl: notificationActionUrl(payload),
    dueAt: notificationDueAt(payload),
    deliveredChannels: channelMap([webResult]),
    metadata: payload.data ?? {},
  });

  for (const channel of priority) {
    if (channel === "web") continue;
    const result = await DELIVERERS[channel](db, userId, {
      ...payload,
      data: {
        ...(payload.data ?? {}),
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

  return { attempted, delivered };
}
