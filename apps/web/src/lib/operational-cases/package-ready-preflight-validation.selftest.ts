import assert from "node:assert/strict";
import {
  collectPackageReadyPreflightMissingData,
  publishToolExecuted,
} from "./package-ready-preflight-validation";

const missingPrice = collectPackageReadyPreflightMissingData({
  property_data: {
    property_type: "departamento",
    operation: "rent",
    currency: "MXN",
    municipality: "Zapopan",
    state: "Jalisco",
    address: "Dirección prueba",
    bedrooms: 2,
    bathrooms: 2,
    parking_spots: 1,
    area_total_m2: 90,
  },
  pricing_proposal: {
    approval_status: "approved",
    ideal: 22000,
    minimo: 18000,
  },
  contract_review: { status: "sent_by_email" },
  raw_photos: [],
  photo_analysis: {},
  zone_context: {},
  listing_description_approved: {},
});

assert.ok(
  missingPrice.includes("pricing_proposal.salida"),
  "Con pricing_proposal aprobado pero sin salida debe faltar pricing_proposal.salida."
);
assert.ok(
  !missingPrice.includes("target_price"),
  "No debe exigir target_price en preflight de package_ready."
);

const withSalida = collectPackageReadyPreflightMissingData({
  property_data: {
    property_type: "departamento",
    operation: "rent",
    currency: "MXN",
    municipality: "Zapopan",
    state: "Jalisco",
    address: "Dirección prueba",
    bedrooms: 2,
    bathrooms: 2,
    parking_spots: 1,
    area_total_m2: 90,
  },
  pricing_proposal: {
    approval_status: "approved",
    salida: 23500,
    ideal: 22000,
    minimo: 18000,
    currency: "MXN",
  },
  contract_review: { status: "sent_by_email" },
  raw_photos: ["a", "b", "c", "d", "e"],
  photo_analysis: { status: "analyzed" },
  zone_context: { area_summary: "ok" },
  listing_description_approved: { description: "ok" },
});

assert.ok(
  !withSalida.includes("pricing_proposal.salida"),
  "Con salida válida no debe reportar faltante de salida."
);
assert.deepEqual(
  publishToolExecuted([
    { tool_name: "easybroker_publish_listing", status: "pending_confirmation" },
  ]),
  ["easybroker_publish_listing"]
);

console.log("package-ready-preflight-validation.selftest: ok");
