import assert from "node:assert/strict";
import {
  allowsMovableItemCommercialClaim,
  analyzePropertyImagesSystemPrompt,
  prepareListingDescriptionDraftSystemPrompt,
} from "./realestate-adapters";

const visionPrompt = analyzePropertyImagesSystemPrompt();
assert.match(visionPrompt, /do_not_claim/);
assert.match(visionPrompt, /copy_safe_phrases/);
assert.match(visionPrompt, /venta y renta/);
assert.match(visionPrompt, /muebles|electrodomésticos portátiles/i);
assert.match(visionPrompt, /cocina integral|clósets empotrados/i);

const draftPrompt = prepareListingDescriptionDraftSystemPrompt();
assert.match(draftPrompt, /venta y renta/);
assert.match(draftPrompt, /se renta amueblada/);
assert.match(draftPrompt, /incluye refrigerador/);
assert.match(draftPrompt, /property_data/);
assert.match(draftPrompt, /advisor_highlights/);
assert.match(draftPrompt, /elementos fijos verificables/);

const salePhotosOnly = allowsMovableItemCommercialClaim({
  operationType: "venta",
  photoShowsMovableItems: true,
});
assert.equal(salePhotosOnly.allowed, false);
assert.equal(salePhotosOnly.reason, "photos_do_not_prove_inclusion_sale_or_rent");

const rentPhotosOnly = allowsMovableItemCommercialClaim({
  operationType: "renta",
  photoShowsMovableItems: true,
});
assert.equal(rentPhotosOnly.allowed, false);
assert.equal(rentPhotosOnly.reason, "photos_do_not_prove_inclusion_sale_or_rent");

const rentFurnishedExplicit = allowsMovableItemCommercialClaim({
  operationType: "renta",
  photoShowsMovableItems: true,
  explicitConfirmationText: "Se renta amueblada",
});
assert.equal(rentFurnishedExplicit.allowed, true);
assert.equal(rentFurnishedExplicit.reason, "explicit_confirmation");

const includesApplianceExplicit = allowsMovableItemCommercialClaim({
  operationType: "venta",
  photoShowsMovableItems: true,
  explicitConfirmationText: "incluye refrigerador y estufa",
});
assert.equal(includesApplianceExplicit.allowed, true);

console.log("realestate-adapters-listing-copy-policy.selftest.ts: ok");
