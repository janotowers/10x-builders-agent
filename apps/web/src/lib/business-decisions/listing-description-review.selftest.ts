import assert from "node:assert/strict";
import {
  looksLikeListingDescriptionDecisionText,
  parseListingDescriptionReviewDecision,
  shouldRouteTelegramTextToListingDescriptionReview,
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

// Standalone affirmatives approve; courtesy tails are ambiguous and must ask.
assert.equal(parseListingDescriptionReviewDecision("ok").intent, "approve");
assert.equal(parseListingDescriptionReviewDecision("Listo.").intent, "approve");
assert.equal(parseListingDescriptionReviewDecision("sí").intent, "approve");
assert.equal(
  parseListingDescriptionReviewDecision("apruebo la descripción").intent,
  "approve"
);
assert.equal(
  parseListingDescriptionReviewDecision("ok gracias").intent,
  "unclear",
  "acknowledgment with courtesy tail must not auto-approve"
);
assert.equal(
  parseListingDescriptionReviewDecision("gracias").intent,
  "unclear"
);
assert.equal(
  parseListingDescriptionReviewDecision("ok pero cambia el tono").intent,
  "change_request",
  "imperative 'cambia' must be detected as a change request"
);
assert.equal(
  parseListingDescriptionReviewDecision("aprobar pero ajusta el título").intent,
  "change_request"
);

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

assert.equal(
  shouldRouteTelegramTextToListingDescriptionReview({
    text: "quiero opcionar una propiedad",
    pendingReviewCount: 1,
    hasPendingReplyIntent: false,
    isExplicitNewCaseIntent: true,
  }),
  false,
  "explicit optioning intent must bypass sticky listing-description HITL"
);

assert.equal(
  shouldRouteTelegramTextToListingDescriptionReview({
    text: "Casa en venta en Las Fuentes. La zona es Las Fuentes, Zapopan, Jalisco",
    pendingReviewCount: 1,
    hasPendingReplyIntent: false,
    isExplicitNewCaseIntent: false,
  }),
  false,
  "intake property details must not be claimed as description edits"
);

assert.equal(
  shouldRouteTelegramTextToListingDescriptionReview({
    text: "Casa en venta en Las Fuentes. La zona es Las Fuentes, Zapopan, Jalisco",
    pendingReviewCount: 1,
    hasPendingReplyIntent: true,
    isExplicitNewCaseIntent: false,
    hasCompetingActiveConversationalIntake: true,
  }),
  true,
  "explicit Pedir cambios reply intent must beat competing incomplete intake"
);

assert.equal(
  shouldRouteTelegramTextToListingDescriptionReview({
    text: "Regenera el entorno/zona con las coordenadas reales del caso",
    pendingReviewCount: 1,
    hasPendingReplyIntent: true,
    isExplicitNewCaseIntent: false,
    hasCompetingActiveConversationalIntake: true,
  }),
  true,
  "zone/surroundings edit after Pedir cambios must not fall into intake"
);

assert.equal(
  shouldRouteTelegramTextToListingDescriptionReview({
    text: "Casa en venta en Las Fuentes. La zona es Las Fuentes, Zapopan, Jalisco",
    pendingReviewCount: 1,
    hasPendingReplyIntent: false,
    isExplicitNewCaseIntent: false,
    hasCompetingActiveConversationalIntake: true,
  }),
  false,
  "without Pedir cambios reply intent, active intake still beats sticky keyword HITL"
);

assert.equal(
  shouldRouteTelegramTextToListingDescriptionReview({
    text: "quiero opcionar una propiedad",
    pendingReviewCount: 1,
    hasPendingReplyIntent: true,
    isExplicitNewCaseIntent: true,
    hasCompetingActiveConversationalIntake: true,
  }),
  false,
  "explicit new-case intent still bypasses even with pending reply intent"
);

assert.equal(
  shouldRouteTelegramTextToListingDescriptionReview({
    text: "hazlo más ejecutivo y menciona el patio",
    pendingReviewCount: 1,
    hasPendingReplyIntent: false,
    isExplicitNewCaseIntent: false,
  }),
  true,
  "editorial description edits still route when they look like decisions"
);

assert.equal(
  shouldRouteTelegramTextToListingDescriptionReview({
    text: "APROBAR DESCRIPCIÓN",
    pendingReviewCount: 1,
    hasPendingReplyIntent: false,
    isExplicitNewCaseIntent: false,
  }),
  true,
  "approve text still routes to listing-description HITL"
);

assert.equal(
  shouldRouteTelegramTextToListingDescriptionReview({
    text: "menciona cercanía a hospitales",
    pendingReviewCount: 2,
    hasPendingReplyIntent: false,
    isExplicitNewCaseIntent: false,
  }),
  true,
  "keyword hint still routes when multiple reviews are pending"
);

assert.equal(
  shouldRouteTelegramTextToListingDescriptionReview({
    text: "hola",
    pendingReviewCount: 1,
    hasPendingReplyIntent: false,
    isExplicitNewCaseIntent: false,
  }),
  false,
  "ambiguous text must not be claimed solely because one review is pending"
);

assert.equal(
  looksLikeListingDescriptionDecisionText(
    "Casa en venta en Las Fuentes. La zona es Las Fuentes, Zapopan, Jalisco"
  ),
  false
);

console.log("listing-description-review business decision selftest ok");
