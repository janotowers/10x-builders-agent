import assert from "node:assert/strict";
import {
  parseListingDescriptionReviewDecision,
  splitInstructionAndHighlights,
} from "./listing-description-review";

assert.equal(
  parseListingDescriptionReviewDecision("APROBAR DESCRIPCIÓN").intent,
  "approve"
);

assert.equal(
  parseListingDescriptionReviewDecision("APROBAR DESCRIPCION").intent,
  "approve"
);

const change = parseListingDescriptionReviewDecision(
  "Menciona el patio techado y la cercanía a avenidas"
);
assert.equal(change.intent, "change_request");

const freeText = parseListingDescriptionReviewDecision(
  "Hacerlo más sobrio y mencionar zona de hospitales"
);
assert.equal(freeText.intent, "change_request");

const split = splitInstructionAndHighlights([
  "Mencionar una escuela cercana",
  "Cerca del Colegio IMI",
]);
assert.deepEqual(split.editorial, ["Mencionar una escuela cercana"]);
assert.deepEqual(split.highlights, ["Cerca del Colegio IMI"]);

console.log("listing-description-review business decision selftest ok");
