import assert from "node:assert/strict";
import { looksLikePropertyDataReviewReply } from "./property-data-review";

assert.equal(looksLikePropertyDataReviewReply("sí"), true);
assert.equal(looksLikePropertyDataReviewReply("Correcto"), true);
assert.equal(looksLikePropertyDataReviewReply("confirmo"), true);
assert.equal(
  looksLikePropertyDataReviewReply("Recámaras: 3, baños: 2"),
  true
);
assert.equal(looksLikePropertyDataReviewReply("hola"), false);
assert.equal(looksLikePropertyDataReviewReply(""), false);

console.log("property-data-review-reply.selftest: ok");
