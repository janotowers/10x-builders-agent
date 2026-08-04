import assert from "node:assert/strict";
import { looksLikePropertyDataReviewReply } from "./property-data-review";

assert.equal(looksLikePropertyDataReviewReply("sí"), true);
assert.equal(looksLikePropertyDataReviewReply("Correcto"), true);
assert.equal(looksLikePropertyDataReviewReply("confirmo"), true);
assert.equal(
  looksLikePropertyDataReviewReply("Recámaras: 3, baños: 2"),
  true
);
// Formas de aprobación en primera persona / infinitivo (hallazgo walkthrough E2E).
assert.equal(
  looksLikePropertyDataReviewReply("Apruebo los datos de la propiedad, todo correcto"),
  true
);
assert.equal(looksLikePropertyDataReviewReply("aprobamos la ficha"), true);
assert.equal(looksLikePropertyDataReviewReply("Aprobar"), true);
assert.equal(looksLikePropertyDataReviewReply("Todo correcto"), true);
assert.equal(looksLikePropertyDataReviewReply("todo en orden"), true);
assert.equal(looksLikePropertyDataReviewReply("hola"), false);
assert.equal(looksLikePropertyDataReviewReply(""), false);
assert.equal(looksLikePropertyDataReviewReply("todo mal"), false);

console.log("property-data-review-reply.selftest: ok");
