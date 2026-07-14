/**
 * Inline keyboard for HITL tool-confirmation notices on Telegram.
 *
 * One message should carry both decision actions and (when available) the web
 * detail link. Do not send a second plain-text "Ver detalle" message — that
 * duplicates the same notice and confuses advisors.
 */

export type HitlTelegramKeyboardButton =
  | { text: string; callback_data: string }
  | { text: string; url: string };

export type HitlTelegramReplyMarkup = {
  inline_keyboard: HitlTelegramKeyboardButton[][];
};

export function isTelegramUrlButtonHref(value: string | null | undefined): boolean {
  if (!value || typeof value !== "string") return false;
  return /^https?:\/\//i.test(value.trim());
}

/** Resolve an absolute http(s) URL for Telegram URL buttons (relative paths need APP_URL). */
export function resolveHitlDetailUrlForTelegram(
  detailUrl: string | null | undefined,
  appUrl: string | null | undefined = process.env.NEXT_PUBLIC_APP_URL ??
    process.env.NEXT_PUBLIC_SITE_URL ??
    process.env.APP_URL ??
    process.env.SITE_URL ??
    ""
): string | null {
  const raw = typeof detailUrl === "string" ? detailUrl.trim() : "";
  if (!raw) return null;
  if (isTelegramUrlButtonHref(raw)) return raw;
  const origin = typeof appUrl === "string" ? appUrl.trim().replace(/\/$/, "") : "";
  if (!origin || !/^https?:\/\//i.test(origin)) return null;
  if (raw.startsWith("/")) return `${origin}${raw}`;
  return `${origin}/${raw}`;
}

/**
 * Approve / reject callbacks, plus an optional URL row for Pendientes.
 */
export function buildHitlApprovalTelegramMarkup(params: {
  toolCallId: string;
  detailUrl?: string | null;
}): HitlTelegramReplyMarkup {
  const toolCallId = params.toolCallId.trim();
  const rows: HitlTelegramKeyboardButton[][] = [
    [
      { text: "✅ Aprobar", callback_data: `approve:${toolCallId}` },
      { text: "❌ Cancelar", callback_data: `reject:${toolCallId}` },
    ],
  ];
  const detailUrl = resolveHitlDetailUrlForTelegram(params.detailUrl);
  if (detailUrl) {
    rows.push([{ text: "Ver detalle", url: detailUrl }]);
  }
  return { inline_keyboard: rows };
}
