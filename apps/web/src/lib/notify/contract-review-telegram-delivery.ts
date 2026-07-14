/**
 * Pure helpers for Telegram delivery of `contract_review`:
 * prefer one sendDocument (caption + HITL buttons), fall back to text +
 * best-effort attach when the caption/binary path cannot carry the review.
 */
import { TELEGRAM_MAX_CAPTION_LENGTH } from "@/lib/telegram/send-message";

export { TELEGRAM_MAX_CAPTION_LENGTH };

/** Soft cap used before attempting sendDocument for contract drafts. */
export const CONTRACT_REVIEW_TELEGRAM_SOFT_MAX_BYTES = 20 * 1024 * 1024;

export type ContractReviewTelegramDeliveryPlan =
  | "document_with_actions"
  | "text_with_actions_then_attach"
  | "text_only";

const DOWNLOAD_HINT =
  /descargar borrador del contrato|\/documents\/contract_draft\/download|\/api\/public\/operational-cases\/documents\/download/i;
const ACTION_HINT =
  /responde\s+[“"']?mándalo al dueño|usar los botones|pide?r cambios/i;

export const CONTRACT_REVIEW_FALLBACK_ATTACH_CAPTION =
  "Borrador del contrato (adjunto). Usa la liga/botones del mensaje anterior.";

export const CONTRACT_REVIEW_BUTTONS_ONLY_FOLLOWUP_TEXT =
  "Borrador adjunto arriba. Responde “mándalo al dueño” o “pedir cambios”, o usa los botones.";

/**
 * Truncate review copy for a document caption without dropping the download
 * link or the action instruction when they fit in the budget.
 */
export function prepareContractReviewDocumentCaption(
  text: string,
  maxLength: number = TELEGRAM_MAX_CAPTION_LENGTH
): { caption: string; fitsWithoutTruncation: boolean } {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) {
    return { caption: trimmed, fitsWithoutTruncation: true };
  }

  const lines = trimmed.split(/\r?\n/);
  const keepTail: string[] = [];
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] ?? "";
    if (DOWNLOAD_HINT.test(line) || ACTION_HINT.test(line) || line.trim().length === 0) {
      keepTail.unshift(line);
      continue;
    }
    break;
  }
  const headLines = lines.slice(0, Math.max(0, lines.length - keepTail.length));
  const tail = keepTail.join("\n").trimEnd();
  const suffix = "\n\n…(caption recortado)";
  const reserved = (tail ? `\n\n${tail}` : "") + suffix;
  const headBudget = Math.max(0, maxLength - reserved.length);
  const head = headLines.join("\n").trimEnd().slice(0, headBudget).trimEnd();
  const caption = `${head}${reserved}`.trim();
  if (caption.length <= maxLength && (DOWNLOAD_HINT.test(caption) || ACTION_HINT.test(caption))) {
    return { caption, fitsWithoutTruncation: false };
  }

  // Last resort: keep the end of the message (usually link + instruction).
  const endSlice = trimmed.slice(Math.max(0, trimmed.length - maxLength));
  return { caption: endSlice, fitsWithoutTruncation: false };
}

export function canDeliverContractReviewAsSingleDocument(params: {
  hasBytes: boolean;
  byteLength?: number;
  captionFits: boolean;
}): boolean {
  if (!params.hasBytes) return false;
  if (
    typeof params.byteLength === "number" &&
    params.byteLength > CONTRACT_REVIEW_TELEGRAM_SOFT_MAX_BYTES
  ) {
    return false;
  }
  return params.captionFits;
}

/**
 * Decide the Telegram transport plan before calling Bot API.
 * `captionFits` should be true only when the review text fits in a caption
 * without losing the download/action cues (see prepareContractReviewDocumentCaption).
 */
export function contractReviewTelegramDeliveryPlan(params: {
  hasBytes: boolean;
  byteLength?: number;
  originalTextLength: number;
  captionFitsWithoutTruncation: boolean;
}): ContractReviewTelegramDeliveryPlan {
  const softCapOk =
    typeof params.byteLength !== "number" ||
    params.byteLength <= CONTRACT_REVIEW_TELEGRAM_SOFT_MAX_BYTES;
  if (
    canDeliverContractReviewAsSingleDocument({
      hasBytes: params.hasBytes,
      byteLength: params.byteLength,
      captionFits: params.captionFitsWithoutTruncation && softCapOk,
    })
  ) {
    return "document_with_actions";
  }
  if (params.hasBytes && softCapOk) {
    return "text_with_actions_then_attach";
  }
  return "text_only";
}

/** Whether a successful document_with_actions delivery should skip a follow-up attach. */
export function shouldAttachContractDraftAfterTextFallback(
  plan: ContractReviewTelegramDeliveryPlan
): boolean {
  return plan === "text_with_actions_then_attach";
}
