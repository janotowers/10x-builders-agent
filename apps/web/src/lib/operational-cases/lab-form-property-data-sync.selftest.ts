import assert from "node:assert/strict";
import {
  LAB_FORM_SOURCE,
  syncLabFormIntoPropertyData,
} from "./lab-form-property-data-sync";

// 1) Formulario llena property_data vacío (una sola verdad).
{
  const { propertyData, adopted } = syncLabFormIntoPropertyData({
    formContext: {
      property_type: ["Casa"],
      operation_type: ["rent"],
      bedrooms: 3,
      bathrooms: 2,
      parking_spaces: 1,
      area_total_m2: 200,
      area_construida_m2: 450,
    },
    propertyData: {},
  });
  assert.equal(propertyData.property_type, "Casa");
  assert.equal(propertyData.operation, "rent");
  assert.equal(propertyData.bedrooms, 3);
  assert.equal(propertyData.area_total_m2, 200);
  assert.equal(propertyData.area_construida_m2, 450);
  assert.equal(propertyData.property_type_source, LAB_FORM_SOURCE);
  assert.ok(adopted.includes("property_type"));
  assert.ok(adopted.includes("area_construida_m2"));
}

// 2) Formulario sobrescribe una semilla previa (score 0, sin fuente de documento).
{
  const { propertyData } = syncLabFormIntoPropertyData({
    formContext: { property_type: ["Casa"], area_total_m2: 300 },
    propertyData: { property_type: "departamento", area_total_m2: 116.93 },
  });
  assert.equal(propertyData.property_type, "Casa");
  assert.equal(propertyData.area_total_m2, 300);
}

// 3) Un valor de documento (score >= 1) NO es sobrescrito por el formulario.
{
  const { propertyData, skippedByDocumentSource } = syncLabFormIntoPropertyData({
    formContext: { area_construida_m2: 999 },
    propertyData: {
      area_construida_m2: 146,
      area_construida_m2_source: "predial",
    },
  });
  assert.equal(propertyData.area_construida_m2, 146);
  assert.equal(propertyData.area_construida_m2_source, "predial");
  assert.ok(skippedByDocumentSource.includes("area_construida_m2"));
}

// 4) Re-editar un valor previo del formulario funciona (lab_form -> lab_form).
{
  const first = syncLabFormIntoPropertyData({
    formContext: { bedrooms: 2 },
    propertyData: {},
  });
  assert.equal(first.propertyData.bedrooms, 2);
  const second = syncLabFormIntoPropertyData({
    formContext: { bedrooms: 4 },
    propertyData: first.propertyData,
  });
  assert.equal(second.propertyData.bedrooms, 4);
  assert.ok(second.adopted.includes("bedrooms"));
}

// 5) Shim legacy: area_m2 (campo viejo) alimenta area_construida_m2.
{
  const { propertyData } = syncLabFormIntoPropertyData({
    formContext: { area_m2: 450 },
    propertyData: {},
  });
  assert.equal(propertyData.area_construida_m2, 450);
}

// 6) Operación normalizada (renta/venta -> rent/sale).
{
  const rent = syncLabFormIntoPropertyData({
    formContext: { operation_type: ["Renta"] },
    propertyData: {},
  });
  assert.equal(rent.propertyData.operation, "rent");
  const sale = syncLabFormIntoPropertyData({
    formContext: { operation_type: ["venta"] },
    propertyData: {},
  });
  assert.equal(sale.propertyData.operation, "sale");
}

// 7) Idempotencia: re-aplicar el mismo formulario no marca cambios.
{
  const once = syncLabFormIntoPropertyData({
    formContext: { property_type: ["Casa"], area_total_m2: 200 },
    propertyData: {},
  });
  const twice = syncLabFormIntoPropertyData({
    formContext: { property_type: ["Casa"], area_total_m2: 200 },
    propertyData: once.propertyData,
  });
  assert.equal(twice.changed, false);
  assert.deepEqual(twice.adopted, []);
}

// 8) Formulario llena dirección/zona en property_data cuando no hay fuente documental.
{
  const { propertyData, adopted } = syncLabFormIntoPropertyData({
    formContext: {
      property_zone: "Colomos Providencia, Guadalajara, Jalisco",
      street: "Av. Patria",
      exterior_number: "2644",
      postal_code: "44630",
    },
    propertyData: {},
  });
  const address = propertyData.address as Record<string, unknown>;
  assert.equal(address.neighborhood, "Colomos Providencia, Guadalajara, Jalisco");
  assert.equal(address.street, "Av. Patria");
  assert.equal(address.exterior_number, "2644");
  assert.equal(address.postal_code, "44630");
  assert.equal(address.source, LAB_FORM_SOURCE);
  assert.equal(propertyData.search_zone, "Colomos Providencia, Guadalajara, Jalisco");
  assert.equal(propertyData.search_zone_source, LAB_FORM_SOURCE);
  assert.ok(adopted.includes("address.street"));
  assert.ok(adopted.includes("search_zone"));
}

// 9) Re-editar dirección del formulario funciona cuando la fuente previa es lab_form.
{
  const first = syncLabFormIntoPropertyData({
    formContext: { street: "Av. Patria", exterior_number: "2644" },
    propertyData: {},
  });
  const second = syncLabFormIntoPropertyData({
    formContext: { street: "Av. Acueducto", exterior_number: "101" },
    propertyData: first.propertyData,
  });
  const address = second.propertyData.address as Record<string, unknown>;
  assert.equal(address.street, "Av. Acueducto");
  assert.equal(address.exterior_number, "101");
  assert.equal(address.source, LAB_FORM_SOURCE);
}

// 10) Dirección documental no se sobrescribe con el formulario.
{
  const { propertyData, skippedByDocumentSource } = syncLabFormIntoPropertyData({
    formContext: {
      property_zone: "Otra zona",
      street: "Otra calle",
      exterior_number: "999",
      postal_code: "00000",
    },
    propertyData: {
      address_source: "escritura",
      search_zone_source: "predial",
      search_zone: "Colomos Providencia",
      address: {
        source: "predial",
        neighborhood: "Colomos Providencia",
        street: "Privada del Tulipán",
        exterior_number: "1501",
        postal_code: "45050",
      },
    },
  });
  const address = propertyData.address as Record<string, unknown>;
  assert.equal(address.neighborhood, "Colomos Providencia");
  assert.equal(address.street, "Privada del Tulipán");
  assert.equal(address.exterior_number, "1501");
  assert.equal(address.postal_code, "45050");
  assert.equal(propertyData.search_zone, "Colomos Providencia");
  assert.ok(skippedByDocumentSource.includes("address.street"));
  assert.ok(skippedByDocumentSource.includes("search_zone"));
}

// 11) Preserva ciudad/estado/país al sincronizar zona/calle de formulario.
{
  const { propertyData } = syncLabFormIntoPropertyData({
    formContext: {
      property_zone: "Lomas Altas, Zapopan, Jalisco",
      street: "Paseo de los Lagos",
      exterior_number: "88",
      postal_code: "45120",
    },
    propertyData: {
      address: {
        city: "Zapopan",
        state: "Jalisco",
        country: "MX",
      },
    },
  });
  const address = propertyData.address as Record<string, unknown>;
  assert.equal(address.city, "Zapopan");
  assert.equal(address.state, "Jalisco");
  assert.equal(address.country, "MX");
  assert.equal(address.street, "Paseo de los Lagos");
  assert.equal(address.neighborhood, "Lomas Altas, Zapopan, Jalisco");
}

console.log("lab-form-property-data-sync.selftest: ok");
