import assert from "node:assert/strict";
import {
  mergeDocumentAddressIntoContextPropertyData,
  mergeDocumentLegalIdentityIntoContextPropertyData,
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
  const result = mergeDocumentLegalIdentityIntoContextPropertyData({
    context: { property_data: {} },
    documentFields: {
      owner_names: ["Juan Pérez", "María Pérez"],
      owner_names_source: "boleta_registral",
      legal_addresses: [
        "FINCA 3668 CALLE CIRCUNVALACION SUR, FRACCIONAMIENTO LAS FUENTES, ZAPOPAN, JALISCO",
      ],
      legal_addresses_source: "boleta_registral",
    },
  });
  assert.equal(result.changed, true);
  const propertyData = propertyDataOf(result);
  assert.deepEqual(propertyData.owner_names, ["Juan Pérez", "María Pérez"]);
  assert.equal(propertyData.owner_name, "Juan Pérez");
  assert.equal(
    propertyData.legal_address,
    "FINCA 3668 CALLE CIRCUNVALACION SUR, FRACCIONAMIENTO LAS FUENTES, ZAPOPAN, JALISCO"
  );
}

{
  const result = mergeDocumentLegalIdentityIntoContextPropertyData({
    context: {
      property_data: {
        owner_names: ["Titular Escritura"],
        owner_names_source: "escritura",
      },
    },
    documentFields: {
      owner_names: ["Titular Predial"],
      owner_names_source: "predial",
    },
  });
  assert.equal(result.changed, false);
  const propertyData = propertyDataOf(result);
  assert.deepEqual(propertyData.owner_names, ["Titular Escritura"]);
}

{
  const result = mergeDocumentLegalIdentityIntoContextPropertyData({
    context: {
      property_data: {
        owner_names: ["MARIA CONCEPCION CASTAÑEDA GARCIA"],
        owner_names_source: "boleta_registral",
        legal_addresses: [
          "CALLE CIRCUNVALACION SUR, NUMERO 3668, FRACCIONAMIENTO LAS FUENTES, ZAPOPAN, JALISCO",
        ],
        legal_addresses_source: "boleta_registral",
      },
    },
    documentFields: {
      owner_names: ["MARIA CONCEPCION CASTAÑEDA GARCIA"],
      owner_names_source: "boleta_registral",
      legal_addresses: [
        "CALLE CIRCUNVALACION SUR, NUMERO 3668, FRACCIONAMIENTO LAS FUENTES, ZAPOPAN, JALISCO",
      ],
      legal_addresses_source: "boleta_registral",
    },
  });
  assert.equal(
    result.changed,
    false,
    "si titularidad y fuente son equivalentes, no debe marcar cambio"
  );
}

{
  const result = mergeDocumentLegalIdentityIntoContextPropertyData({
    context: {
      property_data: {
        owner_names: ["MARIA CONCEPCION CASTAÑEDA GARCIA"],
        owner_names_source: "predial",
      },
    },
    documentFields: {
      owner_names: ["MARIA CONCEPCION CASTAÑEDA GARCIA"],
      owner_names_source: "boleta_registral",
    },
  });
  assert.equal(
    result.changed,
    true,
    "si la fuente mejora con mismo valor, debe marcar cambio una sola vez"
  );
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

// ── Idempotencia de consolidación de dirección ──────────────────────────────
// Re-ejecutar el merge con los mismos insumos NO debe re-marcar `changed`,
// re-emitir conflictos ni re-adoptar campos. Esto evita el churn real de
// escrituras/eventos (causa raíz de las "Dirección consolidada" repetidas).
{
  const documentFields = {
    legal_addresses: [
      "FRACCION C DEL LOTE 5-B, FINCA MARCADA CON EL NUMERO 3668, DE LA CALLE CIRCUNVALACION SUR, ZAPOPAN, JALISCO",
    ],
    legal_addresses_source: "boleta_registral",
    address: {
      neighborhood: "Las Fuentes",
      municipality: "Zapopan",
      state: "Jalisco",
    },
  };
  const first = mergeDocumentAddressIntoContextPropertyData({
    context: { property_data: {} },
    documentFields,
  });
  assert.equal(first.changed, true, "primera consolidación adopta dirección");
  assert.equal(first.newConflicts.length, 0, "sin conflictos en la primera");
  const firstAddress =
    (propertyDataOf(first).address as Record<string, unknown> | undefined) ?? {};
  assert.equal(firstAddress.street, "CIRCUNVALACION SUR");
  assert.equal(firstAddress.exterior_number, "3668");

  const second = mergeDocumentAddressIntoContextPropertyData({
    context: first.context,
    documentFields,
  });
  assert.equal(
    second.changed,
    false,
    "re-ejecutar con los mismos insumos no debe marcar cambio (idempotente)"
  );
  assert.equal(second.newConflicts.length, 0, "sin conflictos nuevos en la segunda");
  assert.deepEqual(
    second.adopted,
    {},
    "la segunda pasada no debe adoptar ningún campo"
  );
}

// Un conflicto ya registrado NO se vuelve a emitir ni dispara `changed`.
{
  const context = {
    property_data: {
      address: {
        street: "Circunvalacion Sur",
        exterior_number: "3668",
        source: "boleta_registral",
      },
    },
  };
  const documentFields = {
    legal_addresses_source: "documentos_compartidos",
    address: {
      street: "Circunvalacion Sur",
      number: "368",
    },
  };
  const firstConflict = mergeDocumentAddressIntoContextPropertyData({
    context,
    documentFields,
  });
  assert.equal(firstConflict.changed, true, "conflicto nuevo marca cambio");
  assert.equal(
    firstConflict.newConflicts.length,
    1,
    "se detecta exactamente un conflicto nuevo"
  );
  assert.equal(firstConflict.newConflicts[0]?.field, "exterior_number");
  const conflictAddress =
    (propertyDataOf(firstConflict).address as Record<string, unknown> | undefined) ??
    {};
  assert.equal(
    conflictAddress.exterior_number,
    "3668",
    "no se sobrescribe el exterior ante conflicto de fuente más débil"
  );

  const secondConflict = mergeDocumentAddressIntoContextPropertyData({
    context: firstConflict.context,
    documentFields,
  });
  assert.equal(
    secondConflict.newConflicts.length,
    0,
    "un conflicto ya registrado no se repite (idempotente)"
  );
  assert.equal(
    secondConflict.changed,
    false,
    "re-ejecutar con el mismo conflicto no marca cambio"
  );
}

console.log("property-optioning-post-agent-invariants.selftest: ok");
