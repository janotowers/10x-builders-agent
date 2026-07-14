import assert from "node:assert/strict";
import {
  CONTRACT_REVIEW_TELEGRAM_SOFT_MAX_BYTES,
  TELEGRAM_MAX_CAPTION_LENGTH,
  canDeliverContractReviewAsSingleDocument,
  contractReviewTelegramDeliveryPlan,
  prepareContractReviewDocumentCaption,
  shouldAttachContractDraftAfterTextFallback,
} from "./contract-review-telegram-delivery";

const SHORT_REVIEW = [
  "Borrador de contrato listo para revisión.",
  "",
  "Descargar borrador del contrato: https://example.com/api/public/operational-cases/documents/download?token=abc",
  "",
  "Responde “mándalo al dueño” o “pedir cambios”, o usa los botones.",
].join("\n");

const shortPrepared = prepareContractReviewDocumentCaption(SHORT_REVIEW);
assert.equal(shortPrepared.fitsWithoutTruncation, true);
assert.equal(shortPrepared.caption, SHORT_REVIEW);
assert.ok(shortPrepared.caption.length <= TELEGRAM_MAX_CAPTION_LENGTH);

assert.equal(
  contractReviewTelegramDeliveryPlan({
    hasBytes: true,
    byteLength: 12_000,
    originalTextLength: SHORT_REVIEW.length,
    captionFitsWithoutTruncation: true,
  }),
  "document_with_actions"
);
assert.equal(
  shouldAttachContractDraftAfterTextFallback("document_with_actions"),
  false
);

assert.equal(
  canDeliverContractReviewAsSingleDocument({
    hasBytes: true,
    byteLength: CONTRACT_REVIEW_TELEGRAM_SOFT_MAX_BYTES + 1,
    captionFits: true,
  }),
  false
);

const longBody = `${"x".repeat(TELEGRAM_MAX_CAPTION_LENGTH + 80)}\n\n${SHORT_REVIEW}`;
const longPrepared = prepareContractReviewDocumentCaption(longBody);
assert.equal(longPrepared.fitsWithoutTruncation, false);
assert.ok(longPrepared.caption.length <= TELEGRAM_MAX_CAPTION_LENGTH);
assert.match(longPrepared.caption, /Descargar borrador del contrato/i);
assert.match(longPrepared.caption, /botones/i);

assert.equal(
  contractReviewTelegramDeliveryPlan({
    hasBytes: true,
    byteLength: 12_000,
    originalTextLength: longBody.length,
    captionFitsWithoutTruncation: false,
  }),
  "text_with_actions_then_attach"
);
assert.equal(
  shouldAttachContractDraftAfterTextFallback("text_with_actions_then_attach"),
  true
);

assert.equal(
  contractReviewTelegramDeliveryPlan({
    hasBytes: false,
    originalTextLength: SHORT_REVIEW.length,
    captionFitsWithoutTruncation: true,
  }),
  "text_only"
);
assert.equal(shouldAttachContractDraftAfterTextFallback("text_only"), false);

assert.equal(
  contractReviewTelegramDeliveryPlan({
    hasBytes: true,
    byteLength: CONTRACT_REVIEW_TELEGRAM_SOFT_MAX_BYTES + 5,
    originalTextLength: SHORT_REVIEW.length,
    captionFitsWithoutTruncation: true,
  }),
  "text_only"
);

console.log("contract-review-telegram-delivery.selftest: ok");
