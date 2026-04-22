/**
 * Shared Telegram helper — used by both the webhook handler and the cron runner.
 * Requires TELEGRAM_BOT_TOKEN to be set in the environment.
 */

const BOT_TOKEN = () => process.env.TELEGRAM_BOT_TOKEN ?? "";

/** https://core.telegram.org/bots/api#sendmessage */
export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

/** Ensures text fits in a single sendMessage (Telegram hard limit). */
export function truncateTelegramText(text: string): string {
  if (text.length <= TELEGRAM_MAX_MESSAGE_LENGTH) return text;
  const suffix = "\n\n…(mensaje recortado: límite de 4096 caracteres en Telegram)";
  const max = TELEGRAM_MAX_MESSAGE_LENGTH - suffix.length;
  return text.slice(0, Math.max(0, max)) + suffix;
}

export async function sendTelegramMessage(
  chatId: number,
  text: string,
  replyMarkup?: Record<string, unknown>,
  options?: { throwOnError?: boolean }
): Promise<void> {
  const res = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN()}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      }),
    }
  );
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    console.error("[telegram] sendMessage failed:", res.status, body);
    if (options?.throwOnError) {
      const desc =
        typeof body.description === "string" ? body.description : "";
      throw new Error(
        `Telegram sendMessage HTTP ${res.status}${desc ? `: ${desc}` : ""}`
      );
    }
  }
}

/**
 * Acciones soportadas por https://core.telegram.org/bots/api#sendchataction
 * Listamos solo las que usamos hoy. `typing` es la equivalente al "está
 * escribiendo…" del cliente.
 */
export type TelegramChatAction =
  | "typing"
  | "upload_photo"
  | "record_video"
  | "upload_video"
  | "record_voice"
  | "upload_voice"
  | "upload_document"
  | "choose_sticker"
  | "find_location"
  | "record_video_note"
  | "upload_video_note";

/**
 * Envía un `sendChatAction` (fire-and-forget). Telegram lo muestra ~5s desde
 * la última señal, por eso se renueva con `withTypingHeartbeat` cuando la
 * operación dura más. Errores de red/HTTP solo se loguean: el indicador es
 * cosmético y no debe romper el flujo principal.
 */
export async function sendTelegramChatAction(
  chatId: number,
  action: TelegramChatAction = "typing"
): Promise<void> {
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN()}/sendChatAction`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, action }),
      }
    );
    if (!res.ok) {
      console.warn(
        "[telegram] sendChatAction failed:",
        res.status,
        action,
        chatId
      );
    }
  } catch (e) {
    console.warn("[telegram] sendChatAction error:", e);
  }
}

/**
 * Envuelve una operación asíncrona mostrando "escribiendo…" en el chat hasta
 * que termina (éxito o error). Manda la primera señal inmediatamente y la
 * renueva cada 4 segundos mientras `fn` siga ejecutándose. Garantiza limpiar
 * el interval con `try/finally` aunque `fn` lance.
 *
 * Uso típico:
 *   const result = await withTypingHeartbeat(chatId, () => runAgent(...));
 */
export async function withTypingHeartbeat<T>(
  chatId: number,
  fn: () => Promise<T>,
  action: TelegramChatAction = "typing"
): Promise<T> {
  // Disparo inmediato — no esperamos a la primera respuesta para que el
  // indicador aparezca en el cliente lo antes posible.
  void sendTelegramChatAction(chatId, action);
  const interval = setInterval(() => {
    void sendTelegramChatAction(chatId, action);
  }, 4000);
  try {
    return await fn();
  } finally {
    clearInterval(interval);
  }
}
