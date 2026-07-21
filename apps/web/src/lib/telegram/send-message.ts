/**
 * Shared Telegram helper — used by both the webhook handler and the cron runner.
 * Requires TELEGRAM_BOT_TOKEN to be set in the environment.
 */

const BOT_TOKEN = () => process.env.TELEGRAM_BOT_TOKEN ?? "";

/** https://core.telegram.org/bots/api#sendmessage */
export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

/** https://core.telegram.org/bots/api#senddocument — caption hard limit */
export const TELEGRAM_MAX_CAPTION_LENGTH = 1024;

/** Intentos totales (1 inicial + reintentos) ante fallos transitorios. */
const TELEGRAM_FETCH_MAX_ATTEMPTS = 3;
/** Backoff entre intentos (ms). El índice 0 es la espera antes del 2º intento. */
const TELEGRAM_FETCH_BACKOFF_MS = [500, 1500];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Errores HTTP que vale la pena reintentar: rate limit (429) y fallas
 * transitorias del lado servidor (5xx). El resto (p. ej. 400 chat inválido)
 * no se reintenta porque no cambiaría el resultado.
 */
function isRetriableTelegramStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function formatFetchNetworkError(error: unknown): string {
  const cause =
    error instanceof Error && error.cause instanceof Error
      ? `: ${error.cause.message}`
      : "";
  return `network error${cause}`;
}

/**
 * Fetch resiliente hacia la Bot API de Telegram. Reintenta timeouts/DNS y 429/5xx.
 * Por defecto no lanza: el webhook debe completar aunque falle el envío.
 */
export async function telegramBotFetch(
  url: string,
  init?: RequestInit,
  options?: { throwOnError?: boolean; label?: string }
): Promise<Response | null> {
  const label = options?.label ?? "fetch";
  let lastErrorMessage = "";

  for (let attempt = 1; attempt <= TELEGRAM_FETCH_MAX_ATTEMPTS; attempt += 1) {
    let res: Response | null = null;
    try {
      res = await fetch(url, init);
    } catch (error) {
      lastErrorMessage = formatFetchNetworkError(error);
      console.error(
        `[telegram] ${label} ${lastErrorMessage} (intento ${attempt}/${TELEGRAM_FETCH_MAX_ATTEMPTS})`
      );
      if (attempt < TELEGRAM_FETCH_MAX_ATTEMPTS) {
        await sleep(TELEGRAM_FETCH_BACKOFF_MS[attempt - 1] ?? 1500);
        continue;
      }
      break;
    }

    if (res.ok) return res;

    const body = (await res.clone().json().catch(() => ({}))) as Record<string, unknown>;
    const desc = typeof body.description === "string" ? body.description : "";
    lastErrorMessage = `HTTP ${res.status}${desc ? `: ${desc}` : ""}`;
    console.error(
      `[telegram] ${label} failed: ${lastErrorMessage} (intento ${attempt}/${TELEGRAM_FETCH_MAX_ATTEMPTS})`
    );
    if (attempt < TELEGRAM_FETCH_MAX_ATTEMPTS && isRetriableTelegramStatus(res.status)) {
      await sleep(TELEGRAM_FETCH_BACKOFF_MS[attempt - 1] ?? 1500);
      continue;
    }
    return res;
  }

  if (options?.throwOnError) {
    throw new Error(`Telegram ${label} ${lastErrorMessage}`);
  }
  return null;
}

/** Ensures text fits in a single sendMessage (Telegram hard limit). */
export function truncateTelegramText(text: string): string {
  if (text.length <= TELEGRAM_MAX_MESSAGE_LENGTH) return text;
  const suffix = "\n\n…(mensaje recortado: límite de 4096 caracteres en Telegram)";
  const max = TELEGRAM_MAX_MESSAGE_LENGTH - suffix.length;
  return text.slice(0, Math.max(0, max)) + suffix;
}

function escapeTelegramHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Converts a subset of GitHub-style Markdown (as the agent emits for web chat)
 * into Telegram HTML. Supports **bold** and `inline code`; other text is escaped.
 */
export function agentMarkdownToTelegramHtml(text: string): string {
  let html = "";
  let cursor = 0;
  const pattern = /(\*\*([\s\S]+?)\*\*|`([^`]+)`)/g;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    html += escapeTelegramHtml(text.slice(cursor, index));
    if (match[2] !== undefined) {
      html += `<b>${escapeTelegramHtml(match[2])}</b>`;
    } else if (match[3] !== undefined) {
      html += `<code>${escapeTelegramHtml(match[3])}</code>`;
    }
    cursor = index + match[0].length;
  }
  html += escapeTelegramHtml(text.slice(cursor));
  return html;
}

function isTelegramParseEntityError(description: string): boolean {
  const lower = description.toLowerCase();
  return (
    lower.includes("can't parse") ||
    lower.includes("cant parse") ||
    lower.includes("parse entities") ||
    lower.includes("entity") ||
    lower.includes("character")
  );
}

export type TelegramParseMode = "HTML" | "Markdown";

export async function sendTelegramMessage(
  chatId: number,
  text: string,
  replyMarkup?: Record<string, unknown>,
  options?: {
    throwOnError?: boolean;
    parseMode?: TelegramParseMode;
  }
): Promise<void> {
  const token = BOT_TOKEN().trim();
  if (!token) {
    throw new Error("Telegram sendMessage not configured: TELEGRAM_BOT_TOKEN is empty");
  }

  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    ...(options?.parseMode ? { parse_mode: options.parseMode } : {}),
  };

  const res = await telegramBotFetch(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    { throwOnError: options?.throwOnError, label: "sendMessage" }
  );
  if (!res?.ok && options?.throwOnError) {
    const body = (await res?.json().catch(() => ({}))) as Record<string, unknown>;
    const desc = typeof body.description === "string" ? body.description : "";
    throw new Error(
      `Telegram sendMessage HTTP ${res?.status ?? "unknown"}${desc ? `: ${desc}` : ""}`
    );
  }
}

/**
 * Sends product Markdown (`**bold**`, `` `code` ``) with Telegram HTML rendering.
 * Does not imply the text came from the AI agent — deterministic copy uses this too.
 * Falls back to plain text if Telegram rejects the formatted payload.
 */
export async function sendTelegramMarkdownMessage(
  chatId: number,
  text: string,
  replyMarkup?: Record<string, unknown>,
  options?: { throwOnError?: boolean }
): Promise<void> {
  const trimmed = truncateTelegramText(text.trim());
  if (!trimmed) return;

  const token = BOT_TOKEN().trim();
  if (!token) {
    throw new Error("Telegram sendMessage not configured: TELEGRAM_BOT_TOKEN is empty");
  }

  const html = agentMarkdownToTelegramHtml(trimmed);
  const res = await telegramBotFetch(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: html,
        parse_mode: "HTML",
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      }),
    },
    { label: "sendMessage" }
  );

  if (res?.ok) return;

  const body = (await res?.json().catch(() => ({}))) as Record<string, unknown>;
  const desc = typeof body.description === "string" ? body.description : "";
  if (res && isTelegramParseEntityError(desc)) {
    console.warn(
      "[telegram] sendMessage HTML parse failed; retrying plain text:",
      desc
    );
    await sendTelegramMessage(chatId, trimmed, replyMarkup, options);
    return;
  }

  if (options?.throwOnError) {
    throw new Error(
      `Telegram sendMessage HTTP ${res?.status ?? "unknown"}${desc ? `: ${desc}` : ""}`
    );
  }
}

/**
 * Sends a binary document via Telegram Bot API `sendDocument`.
 * Prefer this for DOCX/PDF artifacts so advisors can download without opening a URL.
 * Keeps an optional caption (plain text; Telegram caption limit is 1024).
 */
export async function sendTelegramDocument(
  chatId: number,
  params: {
    filename: string;
    bytes: Buffer | Uint8Array;
    contentType?: string;
    caption?: string;
    replyMarkup?: Record<string, unknown>;
  },
  options?: { throwOnError?: boolean }
): Promise<void> {
  const token = BOT_TOKEN().trim();
  if (!token) {
    throw new Error("Telegram sendDocument not configured: TELEGRAM_BOT_TOKEN is empty");
  }

  const form = new FormData();
  form.set("chat_id", String(chatId));
  // Copy into a plain Uint8Array so BlobPart typing stays valid across Node/DOM.
  const body = new Uint8Array(params.bytes);
  const blob = new Blob([body], {
    type: params.contentType ?? "application/octet-stream",
  });
  form.set("document", blob, params.filename);
  const caption = params.caption?.trim();
  if (caption) {
    form.set(
      "caption",
      caption.length <= TELEGRAM_MAX_CAPTION_LENGTH
        ? caption
        : caption.slice(0, TELEGRAM_MAX_CAPTION_LENGTH)
    );
  }
  if (params.replyMarkup) {
    form.set("reply_markup", JSON.stringify(params.replyMarkup));
  }

  const res = await telegramBotFetch(
    `https://api.telegram.org/bot${token}/sendDocument`,
    { method: "POST", body: form },
    { throwOnError: options?.throwOnError, label: "sendDocument" }
  );
  if (!res?.ok && options?.throwOnError) {
    const body = (await res?.json().catch(() => ({}))) as Record<string, unknown>;
    const desc = typeof body.description === "string" ? body.description : "";
    throw new Error(
      `Telegram sendDocument HTTP ${res?.status ?? "unknown"}${desc ? `: ${desc}` : ""}`
    );
  }
}

export async function answerTelegramCallbackQuery(
  callbackQueryId: string,
  text: string
): Promise<void> {
  const token = BOT_TOKEN().trim();
  if (!token) return;
  await telegramBotFetch(
    `https://api.telegram.org/bot${token}/answerCallbackQuery`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
    },
    { label: "answerCallbackQuery" }
  );
}

export interface TelegramFileInfo {
  file_id: string;
  file_unique_id?: string;
  file_size?: number;
  file_path?: string;
}

export async function getTelegramFile(fileId: string): Promise<TelegramFileInfo> {
  const token = BOT_TOKEN().trim();
  if (!token) {
    throw new Error("Telegram getFile not configured: TELEGRAM_BOT_TOKEN is empty");
  }
  const res = await telegramBotFetch(
    `https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`,
    undefined,
    { throwOnError: true, label: "getFile" }
  );
  const body = (await res!.json().catch(() => ({}))) as {
    ok?: boolean;
    result?: TelegramFileInfo;
    description?: string;
  };
  if (!res!.ok || body.ok !== true || !body.result?.file_path) {
    throw new Error(
      `Telegram getFile failed${body.description ? `: ${body.description}` : ""}`
    );
  }
  return body.result;
}

export async function downloadTelegramFile(filePath: string): Promise<ArrayBuffer> {
  const token = BOT_TOKEN().trim();
  if (!token) {
    throw new Error("Telegram file download not configured: TELEGRAM_BOT_TOKEN is empty");
  }
  const res = await telegramBotFetch(
    `https://api.telegram.org/file/bot${token}/${filePath}`,
    undefined,
    { throwOnError: true, label: "downloadFile" }
  );
  if (!res!.ok) {
    throw new Error(`Telegram file download failed: HTTP ${res!.status}`);
  }
  return res!.arrayBuffer();
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
  const token = BOT_TOKEN().trim();
  if (!token) return;
  const res = await telegramBotFetch(
    `https://api.telegram.org/bot${token}/sendChatAction`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action }),
    },
    { label: "sendChatAction" }
  );
  if (res && !res.ok) {
    console.warn("[telegram] sendChatAction failed:", res.status, action, chatId);
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
