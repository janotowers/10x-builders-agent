import assert from "node:assert/strict";
import {
  buildPropertyDataReviewMessage,
  missingOwnerResponseCriticalFields,
  parseOwnerCharacteristics,
  resolveParkingSpacesForDisplay,
  syncIntakeFieldsFromPropertyData,
} from "./parse-owner-characteristics";

const sample =
  "Es venta, departamento, 3 recámaras, 2 baños completos y 1 cajón de estacionamiento.";
const parsed = parseOwnerCharacteristics(sample);

assert.equal(parsed.operation, "sale");
assert.equal(parsed.property_type, "departamento");
assert.equal(parsed.bedrooms, 3);
assert.equal(parsed.bathrooms, 2);
assert.equal(parsed.parking_spots, 1);

const merged = syncIntakeFieldsFromPropertyData(
  { operation_type: ["rent"], property_type: ["Departamento"] },
  {
    ...parsed,
    area_total_m2: 116.93,
    address: { street: "Privada del Tulipán" },
  }
);
assert.deepEqual(merged.operation_type, ["sale"]);
assert.deepEqual(merged.property_type, ["Departamento"]);
assert.equal(merged.parking_spaces, 1);
assert.equal(missingOwnerResponseCriticalFields(merged.property_data as Record<string, unknown>).length, 0);

const noHalfBathVariants = [
  "ningun medio baño",
  "ninguna medio baño",
  "sin medios baños",
  "no hay medios baños",
  "0 medios baños",
  "cero medios baños",
];
for (const text of noHalfBathVariants) {
  const parsedVariant = parseOwnerCharacteristics(text);
  assert.equal(
    parsedVariant.half_bathrooms,
    0,
    `debe interpretar como 0 medios baños: ${text}`
  );
}

assert.equal(resolveParkingSpacesForDisplay({ parking_spots: 2 }), 2);
assert.equal(resolveParkingSpacesForDisplay({ parking_spaces: 0 }), 0);
assert.equal(resolveParkingSpacesForDisplay({ cajones: 1 }), 1);
assert.equal(resolveParkingSpacesForDisplay({ estacionamientos: "3" }), 3);
assert.equal(resolveParkingSpacesForDisplay({}), null);

const reviewWithSpacesAlias = buildPropertyDataReviewMessage({
  propertyTitle: "Casa prueba",
  propertyData: {
    operation: "sale",
    property_type: "casa",
    bedrooms: 3,
    bathrooms: 2,
    area_total_m2: 138,
    parking_spaces: 1,
  },
});
assert.match(reviewWithSpacesAlias, /Estacionamientos: 1/);

const reviewWithZero = buildPropertyDataReviewMessage({
  propertyTitle: "Casa prueba",
  propertyData: {
    operation: "sale",
    property_type: "casa",
    bedrooms: 3,
    bathrooms: 2,
    area_total_m2: 138,
    parking_spots: 0,
  },
});
assert.match(reviewWithZero, /Estacionamientos: 0/);

const reviewWithoutParking = buildPropertyDataReviewMessage({
  propertyTitle: "Terreno prueba",
  propertyData: {
    operation: "sale",
    property_type: "terreno",
    area_total_m2: 200,
  },
});
assert.doesNotMatch(reviewWithoutParking, /Estacionamientos:/);

console.log("parse-owner-characteristics selftest ok");
