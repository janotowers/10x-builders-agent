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
