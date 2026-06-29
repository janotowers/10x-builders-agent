import assert from "node:assert/strict";
import {
  extractOwnerEmailFromContractDataReply,
  parseContractDataReviewReply,
} from "./contract-data-review";

assert.equal(
  extractOwnerEmailFromContractDataReply("El correo es maria.castaneda@example.com"),
  "maria.castaneda@example.com"
);

assert.equal(parseContractDataReviewReply("").intent, "unclear");
assert.equal(parseContractDataReviewReply("sin correo aqui").intent, "unclear");

const parsed = parseContractDataReviewReply(
  "Correo del comitente: maria.castaneda@example.com"
);
assert.equal(parsed.intent, "provide_data");
assert.equal(parsed.owner_email, "maria.castaneda@example.com");

console.log("contract-data-review.selftest: ok");
