import assert from "node:assert/strict";
import {
  mergeDocumentAddressIntoContextPropertyData,
  mergeDocumentSurfacesIntoContextPropertyData,
} from "./property-optioning-post-agent-invariants";

function propertyDataOf(result: {
  context: Record<string, unknown>;
}): Record<string, unknown> {
  return (result.context.property_data as Record<string, unknown> | undefined) ?? {};
}

{
  const result = mergeDocumentSurfacesIntoContextPropertyData({
    context: {
      property_data: {
        bedrooms: 3,
      },
    },
    documentFields: {
      area_total_m2: 138,
      area_total_m2_source: "predial",
      area_construida_m2: 146,
      area_construida_m2_source: "predial",
    },
  });
  assert.equal(result.changed, true);
  const propertyData = propertyDataOf(result);
  assert.equal(propertyData.area_total_m2, 138);
  assert.equal(propertyData.area_construida_m2, 146);
  assert.equal(propertyData.area_construida_m2_source, "predial");
}

{
  const result = mergeDocumentSurfacesIntoContextPropertyData({
    context: {
      property_data: {
        area_construida_m2: 90,
        area_construida_m2_source: "escritura",
      },
    },
    documentFields: {
      area_construida_m2: 146,
      area_construida_m2_source: "predial",
    },
  });
  assert.equal(result.changed, true);
  const propertyData = propertyDataOf(result);
  assert.equal(propertyData.area_construida_m2, 146);
  assert.equal(propertyData.area_construida_m2_source, "predial");
}

{
  const result = mergeDocumentSurfacesIntoContextPropertyData({
    context: {
      property_data: {
        area_construida_m2: 146,
        area_construida_m2_source: "predial",
      },
    },
    documentFields: {
      area_construida_m2: 120,
      area_construida_m2_source: "escritura",
    },
  });
  assert.equal(result.changed, false);
  const propertyData = propertyDataOf(result);
  assert.equal(propertyData.area_construida_m2, 146);
}

{
  const result = mergeDocumentSurfacesIntoContextPropertyData({
    context: { property_data: { floors: 2 } },
    documentFields: {},
  });
  assert.equal(result.changed, false);
  const propertyData = propertyDataOf(result);
  assert.equal(propertyData.floors, 2);
}

{
  const result = mergeDocumentAddressIntoContextPropertyData({
    context: { property_data: {} },
    documentFields: {
      legal_addresses: [
        "FRACCION C ... FINCA MARCADA CON EL NUMERO 3668, DE LA CALLE CIRCUNVALACION SUR, ZAPOPAN, JALISCO",
      ],
      legal_addresses_source: "boleta_registral",
      address: {
        neighborhood: "Las Fuentes",
        municipality: "Zapopan",
        state: "Jalisco",
      },
    },
  });
  assert.equal(result.changed, true);
  const propertyData = propertyDataOf(result);
  const address = (propertyData.address as Record<string, unknown> | undefined) ?? {};
  assert.equal(address.street, "CIRCUNVALACION SUR");
  assert.equal(address.exterior_number, "3668");
  assert.equal(address.source, "boleta_registral");
}

{
  const result = mergeDocumentAddressIntoContextPropertyData({
    context: {
      property_data: {
        address: {
          street: "Circunvalacion Sur",
          exterior_number: "3668",
          source: "boleta_registral",
        },
      },
    },
    documentFields: {
      legal_addresses_source: "documentos_compartidos",
      address: {
        street: "Circunvalacion Sur",
        number: "368",
      },
    },
  });
  assert.equal(result.changed, true);
  const propertyData = propertyDataOf(result);
  const address = (propertyData.address as Record<string, unknown> | undefined) ?? {};
  assert.equal(address.exterior_number, "3668");
  assert.ok(Array.isArray(propertyData.address_conflicts));
}

{
  const result = mergeDocumentAddressIntoContextPropertyData({
    context: {
      property_data: {
        address: {
          street: "Circunvalacion Sur",
          exterior_number: "3668",
          municipality: "Zapopan",
          postal_code: "45070",
          source: "boleta_registral",
        },
      },
    },
    documentFields: {
      legal_addresses: [
        "FINCA MARCADA CON EL NUMERO 3668, DE LA CALLE CIRCUNVALACION SUR, ZAPOPAN, JALISCO",
      ],
      legal_addresses_source: "boleta_registral",
      address: {
        municipality: "Jocotepec",
        postal_code: "45150",
        extraction_source: "escritura",
      },
    },
  });
  const propertyData = propertyDataOf(result);
  const address = (propertyData.address as Record<string, unknown> | undefined) ?? {};
  assert.equal(address.municipality, "Zapopan");
  assert.equal(address.postal_code, "45070");
  assert.equal(propertyData.address_conflicts, undefined);
}

{
  const result = mergeDocumentAddressIntoContextPropertyData({
    context: { property_data: {} },
    documentFields: {
      legal_addresses: [
        "CALLE CIRCUNVALACION SUR, 3668, FRACCIONAMIENTO LAS FUENTES, ZAPOPAN, JALISCO",
      ],
      legal_addresses_source: "boleta_registral",
      address: {
        street: "Ribera del Lago",
        exterior_number: "185",
        municipality: "Jocotepec",
        extraction_source: "escritura",
      },
    },
  });
  const propertyData = propertyDataOf(result);
  const address = (propertyData.address as Record<string, unknown> | undefined) ?? {};
  assert.equal(address.street, "CIRCUNVALACION SUR");
  assert.equal(address.exterior_number, "3668");
  assert.ok(Array.isArray(propertyData.address_conflicts));
}

{
  const result = mergeDocumentAddressIntoContextPropertyData({
    context: { property_data: {} },
    documentFields: {
      legal_addresses: [
        "FRACCION C DEL LOTE 5-B DE LA MANZANA QUINTA",
        "FINCA MARCADA CON EL NUMERO 3668, DE LA CALLE CIRCUNVALACION SUR, ZAPOPAN, JALISCO",
      ],
      legal_addresses_source: "boleta_registral",
      address: {
        street: "Ribera del Lago",
        number: "185",
        extraction_source: "escritura",
      },
    },
  });
  const propertyData = propertyDataOf(result);
  const address = (propertyData.address as Record<string, unknown> | undefined) ?? {};
  assert.equal(address.street, "CIRCUNVALACION SUR");
  assert.equal(address.exterior_number, "3668");
}

{
  const result = mergeDocumentAddressIntoContextPropertyData({
    context: { property_data: {} },
    documentFields: {
      legal_addresses: ["DIRECCION NO PARSEABLE SIN NUMERO DETECTABLE"],
      legal_addresses_source: "boleta_registral",
      address: {
        street: "Ribera del Lago",
        exterior_number: "185",
        extraction_source: "escritura",
      },
    },
  });
  const propertyData = propertyDataOf(result);
  const address = (propertyData.address as Record<string, unknown> | undefined) ?? {};
  assert.equal(address.street, undefined);
  assert.equal(address.exterior_number, undefined);
}

console.log("property-optioning-post-agent-invariants.selftest: ok");
