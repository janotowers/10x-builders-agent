import assert from "node:assert/strict";
import {
  buildEasyBrokerCreatePayload,
  filterFeaturesAgainstCatalog,
  EASYBROKER_CREATE_TOP_LEVEL_ALLOWLIST,
  EASYBROKER_CREATE_LOCATION_ALLOWLIST,
  mergeEasyBrokerCreateInputFromCaseSources,
} from "./realestate-adapters";

const allowlist = new Set<string>(EASYBROKER_CREATE_TOP_LEVEL_ALLOWLIST);
const locationAllowlist = new Set<string>(EASYBROKER_CREATE_LOCATION_ALLOWLIST);

function assertPayloadKeysAllowed(payload: Record<string, unknown>) {
  for (const key of Object.keys(payload)) {
    assert.ok(allowlist.has(key), `unexpected top-level key: ${key}`);
  }
  const location = payload.location;
  assert.ok(location && typeof location === "object" && !Array.isArray(location));
  for (const key of Object.keys(location as Record<string, unknown>)) {
    assert.ok(locationAllowlist.has(key), `unexpected location key: ${key}`);
  }
}

// Replica del payload E2E que produjo 422 Unpermitted parameters.
const e2eFailingInput = {
  age: "",
  tags: ["Las Fuentes", "Zapopan", "Casa", "Venta"],
  agent: "Alebrixe",
  floor: "",
  price: 6_784_000,
  title: "Casa en venta en Fraccionamiento Las Fuentes, Zapopan",
  floors: 2,
  status: "not_published" as const,
  street: "CIRCUNVALACION SUR",
  videos: [] as string[],
  area_m2: 138,
  case_id: "97d9ba19-687d-4fd6-8b7d-75be29b5f285",
  dry_run: false,
  parking: 0,
  bedrooms: 3,
  currency: "MXN",
  expenses: "",
  features: [
    "2 niveles",
    "cocina con gabinetes de madera",
    "encimera de granito",
    "patio con techo translúcido",
  ],
  location: {
    latitude: 20.6200855,
    longitude: -103.4256502,
  },
  lot_size: 138,
  bathrooms: 2,
  exclusive: false,
  lot_width: 0,
  operation: "sale" as const,
  lot_length: 0,
  description: "x".repeat(120),
  internal_id: "97d9ba19-687d-4fd6-8b7d-75be29b5f285",
  show_prices: true,
  virtual_tour: "",
  covered_space: 0,
  custom_fields: {
    legal_address:
      "CALLE CIRCUNVALACION SUR, NUMERO 3668, FRACCIONAMIENTO LAS FUENTES, ZAPOPAN, JALISCO",
    area_construida_m2: 146,
  },
  property_type: "Casa",
  half_bathrooms: 0,
  parking_spaces: 0,
  share_commission: false,
  construction_size: 146,
  custom_fields_json: "{}",
  collaboration_notes: "",
  private_description:
    "Casa en venta en Fraccionamiento Las Fuentes, Zapopan. Superficie total 138 m², 3 recámaras, 2 baños, 2 niveles.",
  show_exact_location: false,
};

const enrichedE2e = mergeEasyBrokerCreateInputFromCaseSources(e2eFailingInput, {
  propertyData: {
    address: {
      street: "CIRCUNVALACION SUR",
      exterior_number: "3668",
      neighborhood: "Las Fuentes",
      municipality: "Zapopan",
      state: "Jalisco",
      latitude: 20.6200855,
      longitude: -103.4256502,
    },
    bedrooms: 3,
    bathrooms: 2,
    construction_size: 146,
    lot_size: 138,
  },
});

const e2eBuilt = buildEasyBrokerCreatePayload(enrichedE2e, {
  catalogFeatureNames: ["Cocina integral", "Patio"],
});

assertPayloadKeysAllowed(e2eBuilt.payload);
assert.equal(
  Object.prototype.hasOwnProperty.call(e2eBuilt.payload, "legal_address"),
  false
);
assert.equal(
  Object.prototype.hasOwnProperty.call(e2eBuilt.payload, "area_construida_m2"),
  false
);
assert.equal(
  Object.prototype.hasOwnProperty.call(e2eBuilt.payload, "covered_space"),
  false
);
assert.equal(
  Object.prototype.hasOwnProperty.call(e2eBuilt.payload, "lot_width"),
  false
);
assert.equal(
  Object.prototype.hasOwnProperty.call(e2eBuilt.payload, "lot_length"),
  false
);
assert.equal(
  Object.prototype.hasOwnProperty.call(e2eBuilt.payload, "agent"),
  false
);
assert.deepEqual(e2eBuilt.payload.tags, [
  "Las Fuentes",
  "Zapopan",
  "Casa",
  "Venta",
]);
assert.equal(e2eBuilt.payload.bedrooms, 3);
assert.equal(e2eBuilt.payload.bathrooms, 2);
assert.equal(e2eBuilt.payload.floors, 2);
assert.equal(e2eBuilt.payload.construction_size, 146);
assert.equal(e2eBuilt.payload.lot_size, 138);
assert.equal(e2eBuilt.payload.parking_spaces, 0);
assert.equal(e2eBuilt.payload.half_bathrooms, 0);
assert.equal(
  (e2eBuilt.payload.location as Record<string, unknown>).name,
  "Las Fuentes, Zapopan, Jalisco"
);
assert.equal(
  (e2eBuilt.payload.location as Record<string, unknown>).exterior_number,
  "3668"
);
assert.equal(
  (e2eBuilt.payload.location as Record<string, unknown>).latitude,
  20.6200855
);
assert.ok(
  e2eBuilt.dropped_fields.some(
    (item) => item.field === "custom_fields.legal_address"
  )
);
assert.ok(
  e2eBuilt.dropped_fields.some(
    (item) => item.field === "custom_fields.area_construida_m2"
  )
);
assert.ok(
  e2eBuilt.dropped_fields.some(
    (item) =>
      item.field === "features" &&
      item.reason === "not_in_easybroker_feature_catalog"
  )
);
assert.equal(Object.prototype.hasOwnProperty.call(e2eBuilt.payload, "features"), false);

assert.ok(
  e2eBuilt.dropped_fields.some(
    (item) =>
      item.field === "internal_id" &&
      item.reason === "invalid_or_exceeds_max_length_15"
  )
);
assert.equal(
  Object.prototype.hasOwnProperty.call(e2eBuilt.payload, "internal_id"),
  false
);

const withPlaceholders = buildEasyBrokerCreatePayload(
  {
    ...enrichedE2e,
    internal_id: undefined,
    floor: "N/D",
    expenses: "N/A",
    age: "N/D",
    features: undefined,
    street:
      "CIRCUNVALACION SUR 3668, FRACCIONAMIENTO LAS FUENTES, ZAPOPAN, JALISCO",
  },
  { catalogFeatureNames: [] }
);
assert.equal(
  Object.prototype.hasOwnProperty.call(withPlaceholders.payload, "floor"),
  false
);
assert.equal(
  Object.prototype.hasOwnProperty.call(withPlaceholders.payload, "expenses"),
  false
);
assert.equal(
  (withPlaceholders.payload.location as Record<string, unknown>).street,
  "Circunvalacion Sur"
);

const shortInternalId = buildEasyBrokerCreatePayload(
  {
    ...enrichedE2e,
    internal_id: "CASE-001",
    features: undefined,
  },
  { catalogFeatureNames: [] }
);
assert.equal(shortInternalId.payload.internal_id, "CASE-001");

// Replica del fallo: location solo con lat/lng + street=dirección completa, sin property_data.
const coordsOnlyBuilt = buildEasyBrokerCreatePayload(
  {
    title: "Casa en venta en Fraccionamiento Las Fuentes, Zapopan",
    description: "x".repeat(120),
    operation: "sale",
    property_type: "Casa",
    price: 6_784_000,
    street:
      "CALLE CIRCUNVALACION SUR, NUMERO 3668, FRACCIONAMIENTO LAS FUENTES, ZAPOPAN, JALISCO",
    location: {
      latitude: 20.6200855,
      longitude: -103.4256502,
    },
    bedrooms: 3,
    bathrooms: 2,
    construction_size: 146,
  },
  { catalogFeatureNames: [] }
);
assert.equal(
  (coordsOnlyBuilt.payload.location as Record<string, unknown>).name,
  "Las Fuentes, Zapopan, Jalisco"
);
assert.equal(
  (coordsOnlyBuilt.payload.location as Record<string, unknown>).street,
  "Circunvalacion Sur"
);
assert.equal(
  (coordsOnlyBuilt.payload.location as Record<string, unknown>).exterior_number,
  "3668"
);

const sharedCommission50 = buildEasyBrokerCreatePayload(
  {
    ...enrichedE2e,
    shared_commission_percentage: 50,
    features: undefined,
  },
  { catalogFeatureNames: [] }
);
assert.equal(sharedCommission50.payload.shared_commission_percentage, 50);

const sharedCommission0 = buildEasyBrokerCreatePayload(
  {
    ...enrichedE2e,
    shared_commission_percentage: 0,
    features: undefined,
  },
  { catalogFeatureNames: [] }
);
assert.equal(
  Object.prototype.hasOwnProperty.call(
    sharedCommission0.payload,
    "shared_commission_percentage"
  ),
  false
);

const featureFilter = filterFeaturesAgainstCatalog(
  ["Cocina Integral", "frase libre", "patio"],
  ["Cocina integral", "Patio", "Alberca"]
);
assert.deepEqual(featureFilter.matched, ["Cocina integral", "Patio"]);
assert.equal(featureFilter.dropped.length, 1);

const catalogUnavailable = filterFeaturesAgainstCatalog(["Alberca"], null);
assert.deepEqual(catalogUnavailable.matched, []);
assert.equal(catalogUnavailable.dropped[0]?.reason, "feature_catalog_unavailable");

// Payload tipo readiness recipe (rico pero allowlisted).
const readinessLike = buildEasyBrokerCreatePayload(
  {
    title: "Casa en venta en Colomos Providencia",
    description: "Borrador de prueba lo suficientemente largo para EasyBroker.",
    operation: "sale",
    property_type: "Casa",
    price: 4_500_000,
    currency: "MXN",
    status: "not_published",
    street: "Av. Patria 2644",
    bedrooms: 2,
    bathrooms: 2,
    parking_spaces: 1,
    construction_size: 120,
    location: {
      street: "Av. Patria 2644",
      name: "Colomos Providencia",
      full_name: "Colomos Providencia, Guadalajara, Jalisco",
      city: "Guadalajara",
      state: "Jalisco",
      country: "México",
      city_area: "Colomos Providencia",
      latitude: 20.7044,
      longitude: -103.3793,
    },
  },
  { catalogFeatureNames: [] }
);
assertPayloadKeysAllowed(readinessLike.payload);
assert.equal(
  (readinessLike.payload.location as Record<string, unknown>).name,
  "Colomos Providencia, Guadalajara, Jalisco"
);
assert.deepEqual(
  (readinessLike.payload.operations as Array<Record<string, unknown>>)[0],
  {
    type: "sale",
    amount: 4_500_000,
    currency: "MXN",
    active: true,
    unit: "total",
  }
);

console.log("realestate-adapters-easybroker-payload.selftest: ok");
