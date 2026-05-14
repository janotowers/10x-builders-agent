/**
 * notify(userId, payload, urgency)
 *
 * Capa unificada para mandar al humano interno (el inmobiliario) avisos
 * proactivos del agente: recordatorios, aprobaciones pendientes, escalaciones.
 *
 * Lee `user_notification_preferences.channels_priority_jsonb` (default
 * `["web", "telegram"]`) y elige el primer canal disponible:
 *
 *   - `web`: hoy se considera "disponible" si la sesión del usuario en
 *     `agent_sessions(channel='web')` se actualizó dentro de los últimos
 *     `WEB_PRESENCE_WINDOW_MINUTES`. Cuando exista una capa real de
 *     notificaciones in-app (toast / inbox), se cambiará por una inserción
 *     ahí; por ahora, si está "presente", el agente devuelve la respuesta
 *     en el siguiente turno y no mandamos por Telegram.
 *   - `telegram`: usa `getTelegramChatId(db, userId)` y manda con
 *     `sendTelegramMessage`.
 *
 * Urgencia:
 *   - `low`: respeta presencia web; si no hay presencia, intenta el
 *     siguiente canal según la prioridad del usuario.
 *   - `normal`: igual que `low` por ahora.
 *   - `high`: ignora presencia y manda por todos los canales con preferencia
 *     ≤ web. Usar para escalaciones (ej. paquete listo, decisión bloqueante).
 *
 * Devuelve un resumen de qué canales se intentaron y el resultado de cada
 * uno, para que el caller persista el evento `reminder_sent` o `escalated`
 * en `operational_case_events`.
 */
import { createServerClient, getTelegramChatId } from "@agents/db";
import {
  sendTelegramMessage,
  truncateTelegramText,
} from "@/lib/telegram/send-message";
import type { NotificationChannel } from "@agents/types";

export type NotifyUrgency = "low" | "normal" | "high";

const WEB_PRESENCE_WINDOW_MINUTES = 5;
const DEFAULT_PRIORITY: NotificationChannel[] = ["web", "telegram"];

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

async function isWebPresent(
  db: ReturnType<typeof createServerClient>,
  userId: string
): Promise<boolean> {
  const cutoff = new Date(
    Date.now() - WEB_PRESENCE_WINDOW_MINUTES * 60_000
  ).toISOString();
  const { data, error } = await db
    .from("agent_sessions")
    .select("id")
    .eq("user_id", userId)
    .eq("channel", "web")
    .gte("updated_at", cutoff)
    .limit(1);
  if (error) return false;
  return Array.isArray(data) && data.length > 0;
}

async function deliverWeb(
  db: ReturnType<typeof createServerClient>,
  userId: string,
  payload: NotifyPayload
): Promise<NotifyChannelResult> {
  // Por ahora "entregar por web" solo significa que asumimos que la próxima
  // interacción del usuario en web verá esta nota. Cuando exista una tabla
  // `inbox_items` o equivalente, aquí se hace el INSERT correspondiente.
  // De momento dejamos un evento mínimo en logs para no perder visibilidad.
  console.log(
    `[notify] web channel queued user=${userId} kind=${payload.kind ?? "?"}: ${payload.text.slice(0, 200)}`
  );
  return { channel: "web", ok: true, reason: "queued (no inbox yet)" };
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
      reason: "no_telegram_account_linked",
    };
  }
  try {
    await sendTelegramMessage(
      chatId,
      truncateTelegramText(payload.text),
      undefined,
      { throwOnError: true }
    );
    return { channel: "telegram", ok: true };
  } catch (e) {
    return {
      channel: "telegram",
      ok: false,
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
  web: deliverWeb,
  telegram: deliverTelegram,
  // Stubs para canales futuros. Cuando se implementen, swap.
  email: async () => ({
    channel: "email",
    ok: false,
    reason: "not_implemented",
  }),
  whatsapp: async () => ({
    channel: "whatsapp",
    ok: false,
    reason: "not_implemented",
  }),
};

export async function notify(
  db: ReturnType<typeof createServerClient>,
  userId: string,
  payload: NotifyPayload,
  urgency: NotifyUrgency = "normal"
): Promise<NotifyResult> {
  const priority = await loadPriority(db, userId);
  const webPresent =
    priority.includes("web") && (await isWebPresent(db, userId));

  const attempted: NotifyChannelResult[] = [];
  const delivered: NotifyChannelResult[] = [];

  for (const channel of priority) {
    if (channel === "web" && !webPresent && urgency !== "high") {
      // Sin presencia web y baja urgencia → no marcamos web como entregado;
      // dejamos que el siguiente canal de la prioridad lo intente.
      attempted.push({
        channel: "web",
        ok: false,
        reason: "no_web_presence",
      });
      continue;
    }
    const result = await DELIVERERS[channel](db, userId, payload);
    attempted.push(result);
    if (result.ok) {
      delivered.push(result);
      // Para urgencia normal/low: con un canal entregado basta. Para high:
      // continuamos para que también llegue por Telegram aunque la web esté
      // presente.
      if (urgency !== "high") break;
    }
  }

  return { attempted, delivered };
}
