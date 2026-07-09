import assert from "node:assert/strict";
import {
  buildPropertyIdentitySignature,
  buildPropertyIdentitySnapshot,
} from "./property-identity-signature";

const baseContext = {
  property_data: {
    property_type: "Departamento",
    operation: "rent",
    search_zone: "Colomos Providencia, Guadalajara, Jalisco",
    area_total_m2: 116.93,
    area_construida_m2: 116.93,
    bedrooms: 3,
    bathrooms: 2,
    parking_spots: 1,
    address: {
      neighborhood: "Colomos Providencia, Guadalajara, Jalisco",
      street: "Av. Patria",
      source: "lab_form",
    },
  },
  updated_at: "2026-07-08T10:00:00.000Z",
  some_noise: true,
};

const signatureA = buildPropertyIdentitySignature(baseContext);
const signatureB = buildPropertyIdentitySignature({
  ...baseContext,
  updated_at: "2026-07-08T12:00:00.000Z",
  some_noise: false,
});
assert.equal(signatureA, signatureB, "la firma debe ignorar ruido fuera de identidad");

const changedType = buildPropertyIdentitySignature({
  property_data: {
    ...baseContext.property_data,
    property_type: "Casa",
  },
});
assert.notEqual(signatureA, changedType, "cambiar tipo debe cambiar firma");

const changedZone = buildPropertyIdentitySignature({
  property_data: {
    ...baseContext.property_data,
    search_zone: "Lomas Altas, Zapopan, Jalisco",
  },
});
assert.notEqual(signatureA, changedZone, "cambiar zona debe cambiar firma");

const changedArea = buildPropertyIdentitySignature({
  property_data: {
    ...baseContext.property_data,
    area_construida_m2: 130,
  },
});
assert.notEqual(signatureA, changedArea, "cambiar superficie debe cambiar firma");

const noAddress = buildPropertyIdentitySnapshot({
  property_data: {
    property_type: "Departamento",
    operation: "rent",
    area_total_m2: 116.93,
    area_construida_m2: 116.93,
  },
});
assert.equal(noAddress.search_zone, "");
assert.equal(noAddress.neighborhood, "");

console.log("property-identity-signature.selftest: ok");

