import assert from "node:assert/strict";
import {
  missingOwnerResponseCriticalFields,
  parseOwnerCharacteristics,
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

console.log("parse-owner-characteristics selftest ok");
