import assert from "node:assert/strict";
import { missingRequiredCommissionContractFields } from "./realestate-adapters";

const fullDataMissingEmail = missingRequiredCommissionContractFields(
  ["owner_name", "owner_email", "property_address", "salida_price_formatted"],
  {
    owner_name: "MARIA CONCEPCION CASTAÑEDA GARCIA",
    owner_email: "",
    property_address: "CIRCUNVALACION SUR 3668, LAS FUENTES, ZAPOPAN, JALISCO",
    salida_price_formatted: "6,784,000",
  }
);
assert.deepEqual(fullDataMissingEmail, ["owner_email"]);

const noCriticalFieldInTemplate = missingRequiredCommissionContractFields(
  ["owner_name", "property_address", "salida_price_formatted"],
  {
    owner_name: "MARIA CONCEPCION CASTAÑEDA GARCIA",
    property_address: "CIRCUNVALACION SUR 3668, LAS FUENTES, ZAPOPAN, JALISCO",
    salida_price_formatted: "6,784,000",
  }
);
assert.deepEqual(
  noCriticalFieldInTemplate,
  [],
  "Si la plantilla no pide owner_email, no debe bloquear por email"
);

const optionalFieldMissingIsNotBlocked = missingRequiredCommissionContractFields(
  ["owner_name", "property_address", "salida_price_formatted", "commission_pct"],
  {
    owner_name: "MARIA CONCEPCION CASTAÑEDA GARCIA",
    property_address: "CIRCUNVALACION SUR 3668, LAS FUENTES, ZAPOPAN, JALISCO",
    salida_price_formatted: "6,784,000",
    commission_pct: "",
  }
);
assert.deepEqual(
  optionalFieldMissingIsNotBlocked,
  [],
  "Campos opcionales fuera del set crítico no deben bloquear"
);

console.log("realestate-adapters-commission-gate.selftest: ok");
