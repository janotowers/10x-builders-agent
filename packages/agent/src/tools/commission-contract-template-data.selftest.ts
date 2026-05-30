import assert from "node:assert/strict";
import {
  COMMISSION_CONTRACT_TEMPLATE_PLACEHOLDERS,
  deriveCommissionContractTemplateData,
} from "./commission-contract-template-data";

const data = deriveCommissionContractTemplateData({
  property_data: {
    property_type: "departamento",
    area_m2: 95,
    address: {
      street: "Av. Test",
      neighborhood: "Colomos",
      city: "Guadalajara",
      state: "Jalisco",
    },
  },
  pricing_proposal: { salida: 23500, minimo: 18000 },
  commission_terms: { commission_pct: 5, exclusive: true, duration_months: 6 },
  external_contact: { display_name: "María Dueña" },
});

for (const key of COMMISSION_CONTRACT_TEMPLATE_PLACEHOLDERS) {
  assert.ok(key in data, `missing placeholder ${key}`);
}
assert.equal(data.owner_name, "María Dueña");
assert.match(String(data.property_address), /Colomos/);
assert.equal(data.property_type, "departamento");
assert.equal(data.area_m2, 95);
assert.equal(data.salida_price, 23500);
assert.equal(data.minimum_price, 18000);
assert.equal(data.commission_pct, 5);
assert.equal(data.exclusive, true);
assert.equal(data.duration_months, 6);

const aliasedData = deriveCommissionContractTemplateData({
  case_context: { owner_name: "Dueño del intake" },
  property_data: {
    property_type: "casa",
    area_total_m2: 116.93,
    address: "Colomos Providencia, Guadalajara",
  },
  pricing_proposal: { salida_price: 25000, min_price: 20000 },
  commission_terms: {
    commission_percent: 5,
    exclusive: false,
    months: 12,
  },
  external_contact: { name: "Dueño Alias" },
});
assert.equal(aliasedData.owner_name, "Dueño Alias");
assert.equal(aliasedData.property_address, "Colomos Providencia, Guadalajara");
assert.equal(aliasedData.area_m2, 116.93);
assert.equal(aliasedData.minimum_price, 20000);
assert.equal(aliasedData.commission_pct, 5);
assert.equal(aliasedData.exclusive, false);
assert.equal(aliasedData.duration_months, 12);

const contextFallbackData = deriveCommissionContractTemplateData({
  case_context: { owner_name: "Dueño desde formulario" },
  property_data: { property_type: "departamento" },
});
assert.equal(contextFallbackData.owner_name, "Dueño desde formulario");

const leadFallbackData = deriveCommissionContractTemplateData({
  case_context: { lead_name: "Lead dueño" },
  external_contact: {},
});
assert.equal(leadFallbackData.owner_name, "Lead dueño");

console.log("commission-contract-template-data.selftest: ok");
