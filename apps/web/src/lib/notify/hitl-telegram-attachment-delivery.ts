/**
 * Shared Telegram transport planner for HITL notifications that may carry a
 * file attachment (contract DOCX, listing-description .txt, future kinds).
 *
 * Prefer one sendDocument (caption + action buttons). When the full review
 * text does not fit in Telegram's caption limit (1024), fall back to
 * text+buttons and then attach the file — preserving the rich review body.
 *
 * Web parity is semantic (notification metadata / download link), not the
 * Bot API two-bubble transport. See docs/operational-cases/pending-decision-routing.md.
 */
import { TELEGRAM_MAX_CAPTION_LENGTH } from "@/lib/telegram/send-message";

export { TELEGRAM_MAX_CAPTION_LENGTH };

/** Soft cap before attempting sendDocument for HITL attachments. */
export const HITL_TELEGRAM_ATTACHMENT_SOFT_MAX_BYTES = 20 * 1024 * 1024;

export type HitlTelegramAttachmentDeliveryPlan =
  | "document_with_actions"
  | "text_with_actions_then_attach"
  | "text_only";

export function canDeliverHitlAsSingleDocument(params: {
  hasBytes: boolean;
  byteLength?: number;
  captionFits: boolean;
  softMaxBytes?: number;
}): boolean {
  if (!params.hasBytes) return false;
  const softMax = params.softMaxBytes ?? HITL_TELEGRAM_ATTACHMENT_SOFT_MAX_BYTES;
  if (typeof params.byteLength === "number" && params.byteLength > softMax) {
    return false;
  }
  return params.captionFits;
}

/**
 * Decide the Telegram transport plan before calling Bot API.
 * `captionFitsWithoutTruncation` must be true only when the *full* review
 * text fits in a caption — do not pass a compacted substitute as "fits".
 */
export function hitlTelegramAttachmentDeliveryPlan(params: {
  hasBytes: boolean;
  byteLength?: number;
  captionFitsWithoutTruncation: boolean;
  softMaxBytes?: number;
}): HitlTelegramAttachmentDeliveryPlan {
  const softMax = params.softMaxBytes ?? HITL_TELEGRAM_ATTACHMENT_SOFT_MAX_BYTES;
  const softCapOk =
    typeof params.byteLength !== "number" || params.byteLength <= softMax;
  if (
    canDeliverHitlAsSingleDocument({
      hasBytes: params.hasBytes,
      byteLength: params.byteLength,
      captionFits: params.captionFitsWithoutTruncation && softCapOk,
      softMaxBytes: softMax,
    })
  ) {
    return "document_with_actions";
  }
  if (params.hasBytes && softCapOk) {
    return "text_with_actions_then_attach";
  }
  return "text_only";
}

/** True when the text+buttons path should still best-effort attach the file. */
export function shouldAttachAfterTextFallback(
  plan: HitlTelegramAttachmentDeliveryPlan
): boolean {
  return plan === "text_with_actions_then_attach";
}

/** Strict full-text caption fit (no compaction). */
export function reviewTextFitsTelegramCaption(
  text: string,
  maxLength: number = TELEGRAM_MAX_CAPTION_LENGTH
): boolean {
  return text.trim().length > 0 && text.trim().length <= maxLength;
}
