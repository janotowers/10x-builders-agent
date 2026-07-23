import assert from "node:assert/strict";
import {
  HITL_TELEGRAM_ATTACHMENT_SOFT_MAX_BYTES,
  TELEGRAM_MAX_CAPTION_LENGTH,
  canDeliverHitlAsSingleDocument,
  hitlTelegramAttachmentDeliveryPlan,
  reviewTextFitsTelegramCaption,
  shouldAttachAfterTextFallback,
} from "./hitl-telegram-attachment-delivery";

assert.equal(
  reviewTextFitsTelegramCaption("short review"),
  true
);
assert.equal(
  reviewTextFitsTelegramCaption("x".repeat(TELEGRAM_MAX_CAPTION_LENGTH)),
  true
);
assert.equal(
  reviewTextFitsTelegramCaption("x".repeat(TELEGRAM_MAX_CAPTION_LENGTH + 1)),
  false,
  "listing-style long review must not claim caption fit"
);
assert.equal(reviewTextFitsTelegramCaption("   "), false);

assert.equal(
  hitlTelegramAttachmentDeliveryPlan({
    hasBytes: true,
    byteLength: 4_000,
    captionFitsWithoutTruncation: true,
  }),
  "document_with_actions"
);

assert.equal(
  hitlTelegramAttachmentDeliveryPlan({
    hasBytes: true,
    byteLength: 4_000,
    captionFitsWithoutTruncation: false,
  }),
  "text_with_actions_then_attach",
  "long listing description with .txt uses text+buttons then attach"
);
assert.equal(
  shouldAttachAfterTextFallback("text_with_actions_then_attach"),
  true
);
assert.equal(shouldAttachAfterTextFallback("document_with_actions"), false);
assert.equal(shouldAttachAfterTextFallback("text_only"), false);

assert.equal(
  hitlTelegramAttachmentDeliveryPlan({
    hasBytes: false,
    captionFitsWithoutTruncation: true,
  }),
  "text_only"
);

assert.equal(
  canDeliverHitlAsSingleDocument({
    hasBytes: true,
    byteLength: HITL_TELEGRAM_ATTACHMENT_SOFT_MAX_BYTES + 1,
    captionFits: true,
  }),
  false
);
assert.equal(
  hitlTelegramAttachmentDeliveryPlan({
    hasBytes: true,
    byteLength: HITL_TELEGRAM_ATTACHMENT_SOFT_MAX_BYTES + 1,
    captionFitsWithoutTruncation: true,
  }),
  "text_only"
);

console.log("hitl-telegram-attachment-delivery.selftest: ok");
