import assert from "node:assert/strict";
import {
  amountToSpanishLegalWords,
  COMMISSION_CONTRACT_TEMPLATE_PLACEHOLDERS,
  contractAreaM2FromCase,
  deriveCommissionContractTemplateData,
  formatContractSalidaPrice,
  readablePropertyAddress,
} from "./commission-contract-template-data";

const data = deriveCommissionContractTemplateData({
  property_data: {
    property_type: "departamento",
    owner_names: ["Titular Documental"],
    area_m2: 95,
    address: {
      street: "Av. Test",
      exterior_number: "123",
      neighborhood: "Colomos",
      municipality: "Guadalajara",
      state: "Jalisco",
      postal_code: "44660",
    },
  },
  pricing_proposal: { salida: 23500, minimo: 18000 },
  commission_terms: { commission_pct: 5, exclusive: true, duration_months: 6 },
  external_contact: { display_name: "María Dueña", email: "maria@example.com" },
});

for (const key of COMMISSION_CONTRACT_TEMPLATE_PLACEHOLDERS) {
  assert.ok(key in data, `missing placeholder ${key}`);
}
assert.equal(data.owner_name, "Titular Documental");
assert.equal(data.owner_email, "maria@example.com");
assert.match(String(data.property_address), /Colomos/);
assert.match(String(data.property_address), /44660/);
assert.equal(data.property_type, "departamento");
assert.equal(data.area_m2, 95);
assert.equal(data.salida_price, 23500);
assert.equal(data.salida_price_formatted, "23,500");
assert.equal(data.salida_price_words, "VEINTITRES MIL QUINIENTOS");
assert.equal(data.minimum_price, 18000);
assert.equal(data.commission_pct, 5);
assert.equal(data.exclusive, true);
assert.equal(data.duration_months, 6);

const aliasedData = deriveCommissionContractTemplateData({
  case_context: { owner_name: "Dueño del intake", owner_email: "dueno@example.com" },
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
assert.equal(aliasedData.owner_name, "Dueño del intake");
assert.equal(aliasedData.owner_email, "dueno@example.com");
assert.equal(aliasedData.property_address, "Colomos Providencia, Guadalajara");
assert.equal(aliasedData.area_m2, 116.93);
assert.equal(aliasedData.minimum_price, 20000);
assert.equal(aliasedData.commission_pct, 5);
assert.equal(aliasedData.exclusive, false);
assert.equal(aliasedData.duration_months, 12);

const constructionPreferred = deriveCommissionContractTemplateData({
  property_data: {
    property_type: "casa",
    area_m2: 138,
    area_construida_m2: 146,
    area_total_m2: 500,
  },
  pricing_proposal: { salida: 6784000 },
});
assert.equal(constructionPreferred.area_m2, 146);

const terrenoArea = deriveCommissionContractTemplateData({
  property_data: {
    property_type: "terreno",
    area_m2: 138,
    area_total_m2: 500,
  },
  pricing_proposal: { salida: 1200000 },
});
assert.equal(terrenoArea.area_m2, 500);

const approvedSubjectArea = deriveCommissionContractTemplateData({
  property_data: {
    property_type: "casa",
    area_m2: 138,
    area_construida_m2: 146,
  },
  pricing_proposal: {
    salida: 6784000,
    subject_area_m2: 146,
  },
});
assert.equal(approvedSubjectArea.area_m2, 146);

assert.equal(
  readablePropertyAddress({
    address: {
      street: "CIRCUNVALACION SUR",
      exterior_number: "3668",
      neighborhood: "Jardines de San Ignacio",
      municipality: "Zapopan",
      state: "Jalisco",
      postal_code: "45040",
    },
  }),
  "CIRCUNVALACION SUR 3668, Jardines de San Ignacio, Zapopan, Jalisco, 45040"
);

assert.equal(formatContractSalidaPrice(6784000), "6,784,000");
assert.equal(
  amountToSpanishLegalWords(6784000),
  "SEIS MILLONES SETECIENTOS OCHENTA Y CUATRO MIL"
);
assert.equal(contractAreaM2FromCase({
  property_data: { area_m2: 138, area_construida_m2: 146 },
}), 146);

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

const ignoresLabContactPlaceholder = deriveCommissionContractTemplateData({
  property_data: {},
  case_context: { owner_name: "Contacto de prueba E2E", lead_name: "Asesor interno" },
  external_contact: {
    display_name: "Contacto de prueba E2E",
    email: "lab@example.com",
  },
});
assert.equal(ignoresLabContactPlaceholder.owner_name, "Asesor interno");

const legalAddressPreferredData = deriveCommissionContractTemplateData({
  case_context: {
    legal_address: "CIRCUNVALACION SUR 3668, LAS FUENTES, ZAPOPAN, JALISCO",
  },
  property_data: {
    address: {
      street: "CIRCUNVALACION SUR",
      exterior_number: "3668",
      neighborhood: "Las Fuentes",
      municipality: "Zapopan",
      state: "Jalisco",
    },
  },
});
assert.equal(
  legalAddressPreferredData.property_address,
  "CIRCUNVALACION SUR 3668, LAS FUENTES, ZAPOPAN, JALISCO"
);

console.log("commission-contract-template-data.selftest: ok");
