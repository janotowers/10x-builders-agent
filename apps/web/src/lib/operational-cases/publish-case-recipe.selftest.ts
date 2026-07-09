import assert from "node:assert/strict";
import {
  resolvePublishConstructionAreaM2,
  resolvePublishListingCopy,
  resolvePublishListingPrice,
  resolvePublishLandAreaM2,
} from "./publish-case-recipe";

const ctx = {
  property_type: "departamento",
  pricing_proposal: {
    approval_status: "approved",
    salida: 23500,
    currency: "MXN",
  },
  listing_description_draft: {
    headline: "Departamento en renta en Colomos",
    description: "Descripción comercial del borrador.",
  },
  listing_description_approved: {
    headline: "Departamento aprobado",
    description: "Descripción aprobada por el asesor.",
  },
};

assert.equal(resolvePublishListingPrice(ctx), 23500);

const copy = resolvePublishListingCopy(ctx);
assert.equal(copy.source, "approved");
assert.equal(copy.description, "Descripción aprobada por el asesor.");
assert.equal(copy.title, "Departamento aprobado");

const draftOnly = {
  pricing_proposal: { salida: 21000 },
  property_data: {
    area_built_m2: 116.93,
    area_total_m2: 450,
  },
  listing_description_draft: {
    headline: "Borrador",
    description: "Solo borrador.",
  },
};
assert.equal(resolvePublishListingPrice(draftOnly), 21000);
assert.equal(resolvePublishListingCopy(draftOnly).source, "draft");
assert.equal(resolvePublishConstructionAreaM2(draftOnly), 116.93);
assert.equal(resolvePublishLandAreaM2(draftOnly), 450);

console.log("publish-case-recipe.selftest: ok");
