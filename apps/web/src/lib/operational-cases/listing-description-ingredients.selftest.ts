import assert from "node:assert/strict";
import {
  buildListingApprovalSummary,
  buildListingDescriptionPrompt,
  collectListingDescriptionIngredients,
} from "./listing-description-ingredients";

const ingredients = collectListingDescriptionIngredients({
  property_data: {
    property_type: "casa",
    operation: "venta",
    legal_address: "CALLE CIRCUNVALACION SUR, NUMERO 3668, ZAPOPAN, JALISCO",
    municipality: "Zapopan",
    state: "Jalisco",
    neighborhood: "Las Fuentes",
    bedrooms: 3,
    bathrooms: 2,
    parking_spots: 2,
    area_total_m2: 180,
    area_built_m2: 150,
  },
  pricing_proposal: {
    target_price: 6200000,
    currency: "MXN",
  },
  raw_photos: [{ id: "1" }, { id: "2" }, { id: "3" }, { id: "4" }, { id: "5" }],
  listing_highlights: ["Terraza amplia", "Cocina integral remodelada"],
  zone_points_of_interest: ["Parque Las Fuentes", "Plaza Galerias"],
});

assert.equal(ingredients.missingIngredients.length, 0);
const descriptionPrompt = buildListingDescriptionPrompt(ingredients);
assert.match(descriptionPrompt, /Redacta una descripcion inmobiliaria/);
assert.match(descriptionPrompt, /no incluir en el copy/i);
assert.doesNotMatch(descriptionPrompt, /6200000|6,200,000|MXN/);
const approvalSummary = buildListingApprovalSummary(ingredients);
assert.match(approvalSummary, /Cobertura de fotos: 5 foto\(s\)/);
assert.match(approvalSummary, /Precio: 6200000 MXN/);

const missing = collectListingDescriptionIngredients({
  property_data: {},
  raw_photos: [],
});
assert.ok(missing.missingIngredients.includes("raw_photos>=5"));
assert.ok(missing.missingIngredients.includes("advisor_highlights"));

const addressFallback = collectListingDescriptionIngredients({
  property_data: {
    address: {
      city: "Zapopan",
      state: "Jalisco",
      neighborhood: "Seattle",
      formatted_address: "Seattle, Zapopan, Jalisco, MX",
    },
  },
  raw_photos: [],
});
assert.equal(addressFallback.municipality, "Zapopan");
assert.equal(addressFallback.state, "Jalisco");
assert.equal(addressFallback.neighborhood, "Seattle");
assert.equal(addressFallback.legalAddress, "Seattle, Zapopan, Jalisco, MX");

console.log("listing-description-ingredients.selftest: ok");
