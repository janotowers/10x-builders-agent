import assert from "node:assert/strict";
import {
  blockedAwaitingDocumentsTransitionReason,
  blockedPropertyOptioningStepRegressionReason,
  buildPropertyDataMinimumsSummaryMessage,
  buildContractDataReviewNotifyText,
  buildOperationalCaseIntakeUpdateContext,
  buildOperationalCaseCreateContext,
  canonicalizeNotifyKindForTest,
  canonicalizePropertyDataReviewText,
  contractDraftOutputPathFromContext,
  documentExtractionMinimumsContext,
  evaluateContractReviewNotifyGate,
  evaluateListingDescriptionReviewNotifyGate,
  listingDescriptionDraftContentFromContext,
  evaluatePropertyDataMinimumsForReview,
  evaluatePredialBuiltAreaQualityForTest,
  extractPredialSurfacesFromTextForTest,
  extractSurfaceTotalM2FromTextForTest,
  looksLikeComparablesSummaryNotificationForTest,
  looksLikeComparablesCompletionProseForTest,
  comparablesSearchExpansionDecisionAlreadyRequestedForTest,
  priceApprovalNotificationAlreadyDeliveredForTest,
  missingRequiredIntakeFields,
  normalizePredialExtractionSurfacesForTest,
  operationalCaseIntakeSuccessStep,
  predialSurfacesFromContribuyenteRowValuesForTest,
} from "./operational-cases-adapters";
import type {
  OperationalCaseDocument,
  OperationalCaseFlowStep,
  OperationalCaseIntakeField,
} from "@agents/types";

const schema: OperationalCaseIntakeField[] = [
  {
    name: "property_address",
    label: "Dirección",
    type: "text",
    required: true,
  },
  {
    name: "owner_name",
    label: "Dueño",
    type: "text",
    required: true,
  },
  {
    name: "notes",
    label: "Notas",
    type: "textarea",
    required: false,
  },
];

const missing = missingRequiredIntakeFields(schema, {
  property_address: "Av. Siempre Viva 123",
  owner_name: " ",
});

assert.deepEqual(missing, [{ name: "owner_name", label: "Dueño" }]);

const context = buildOperationalCaseCreateContext({
  context: { property_address: "Av. Siempre Viva 123" },
  missing,
  allowIncompleteIntake: true,
  e2eControlled: true,
  channel: "telegram",
});

assert.equal(context.created_from, "agent_conversation");
assert.equal(context.e2e_controlled, true);
assert.equal(context.e2e_control_source, "telegram");
assert.equal(context.e2e_control_status, "intake");
assert.equal(context.intake_status, "incomplete");
assert.deepEqual(context.missing_required, missing);
assert.equal(canonicalizeNotifyKindForTest("price proposal"), "price_approval");
assert.equal(canonicalizeNotifyKindForTest("pricing_proposal"), "price_approval");
assert.equal(
  canonicalizeNotifyKindForTest("contract_generation_error"),
  "contract_data_review"
);
assert.equal(
  canonicalizeNotifyKindForTest("publish destination approvals"),
  "easybroker_publish_approval"
);
assert.equal(
  canonicalizeNotifyKindForTest("publish_destination_approvals"),
  "easybroker_publish_approval"
);
assert.equal(
  looksLikeComparablesSummaryNotificationForTest({
    text: "El análisis de comparables ha sido completado. El caso ha avanzado a la propuesta de precio.",
  }),
  true
);
assert.equal(
  looksLikeComparablesSummaryNotificationForTest({
    kind: "price_approval",
    text: "Propuesta de precio lista para revisión. Lectura por fuente: EasyBroker comparables.",
  }),
  false
);
assert.equal(
  looksLikeComparablesCompletionProseForTest(
    "El análisis de comparables ha sido completado. Se encontraron 3 comparables usables y el caso ha avanzado a la propuesta de precio. Sin embargo, no se pudo obtener la valoración de Avaclick debido a que se alcanzó el límite de avaluos."
  ),
  true
);
assert.equal(
  looksLikeComparablesCompletionProseForTest(
    "Propuesta de precio lista para revisión:\n\nRecomendación:\n- Salida (publicación): $6,784,000"
  ),
  false
);
assert.equal(
  priceApprovalNotificationAlreadyDeliveredForTest([
    {
      payload_jsonb: {
        kind: "price_approval_requested",
        notify_delivered: [{ channel: "telegram", ok: true }],
      },
    },
  ]),
  true
);
assert.equal(
  priceApprovalNotificationAlreadyDeliveredForTest([
    {
      payload_jsonb: {
        kind: "price_approval_requested",
        notify_delivered: [],
      },
    },
  ]),
  false
);
assert.equal(
  comparablesSearchExpansionDecisionAlreadyRequestedForTest([
    {
      payload_jsonb: {
        kind: "comparables_search_expansion_decision_requested",
        notify_delivered: [{ channel: "telegram", ok: true }],
      },
    },
  ]),
  true
);
assert.equal(
  comparablesSearchExpansionDecisionAlreadyRequestedForTest([
    { payload_jsonb: { kind: "comparables_insufficient_data" } },
  ]),
  false
);

const completeContext = buildOperationalCaseCreateContext({
  context: { property_address: "Av. Siempre Viva 123", owner_name: "Ana" },
  missing: [],
  allowIncompleteIntake: true,
  e2eControlled: true,
  channel: "telegram",
});

assert.equal(completeContext.e2e_control_status, "ready_for_manual_tick");
assert.equal(completeContext.intake_status, "complete");
assert.deepEqual(completeContext.missing_required, []);

const flow: OperationalCaseFlowStep[] = [
  { step_key: "intake", step_label: "Completar registro" },
  { step_key: "awaiting_documents", step_label: "Solicitar documentos" },
];

assert.equal(
  operationalCaseIntakeSuccessStep({ activationPolicy: null, flow }),
  "awaiting_documents"
);
assert.equal(
  operationalCaseIntakeSuccessStep({
    activationPolicy: { safe_test: { success_step: "custom_first_step" } },
    flow,
  }),
  "custom_first_step"
);

const partialIntakeUpdate = buildOperationalCaseIntakeUpdateContext({
  existingContext: {
    created_from: "agent_conversation",
    property_address: "Av. Siempre Viva 123",
    missing_required: missing,
    intake_status: "incomplete",
  },
  intakePatch: {
    notes: "Nota opcional",
    unknown_field: "no debe persistir",
  },
  intakeSchema: schema,
  e2eControlled: true,
  channel: "telegram",
});

assert.equal(partialIntakeUpdate.complete, false);
assert.equal(partialIntakeUpdate.context.intake_status, "incomplete");
assert.deepEqual(partialIntakeUpdate.context.missing_required, [
  { name: "owner_name", label: "Dueño" },
]);
assert.equal("unknown_field" in partialIntakeUpdate.context, false);

const completeIntakeUpdate = buildOperationalCaseIntakeUpdateContext({
  existingContext: partialIntakeUpdate.context,
  intakePatch: { owner_name: "Ana" },
  intakeSchema: schema,
  e2eControlled: true,
  channel: "telegram",
});

assert.equal(completeIntakeUpdate.complete, true);
assert.equal(completeIntakeUpdate.context.intake_status, "complete");
assert.equal(completeIntakeUpdate.context.e2e_control_status, "ready_for_manual_tick");
assert.deepEqual(completeIntakeUpdate.context.missing_required, []);

assert.equal(
  blockedAwaitingDocumentsTransitionReason({
    currentStep: "awaiting_documents",
    nextStep: "contract_pending",
    recentEventTypes: [],
  }),
  "awaiting_documents_requires_external_response"
);
assert.equal(
  blockedAwaitingDocumentsTransitionReason({
    currentStep: "awaiting_documents",
    nextStep: "documents_received",
    recentEventTypes: ["external_response"],
  }),
  null
);
assert.equal(
  blockedAwaitingDocumentsTransitionReason({
    currentStep: "awaiting_documents",
    nextStep: "awaiting_documents",
    recentEventTypes: [],
  }),
  null
);
assert.equal(
  blockedPropertyOptioningStepRegressionReason({
    caseType: "property_optioning",
    currentStep: "package_ready",
    nextStep: "photos_requested",
  }),
  "property_optioning_step_regression_blocked"
);
assert.equal(
  blockedPropertyOptioningStepRegressionReason({
    caseType: "property_optioning",
    currentStep: "photos_requested",
    nextStep: "package_ready",
  }),
  null
);
assert.equal(
  blockedPropertyOptioningStepRegressionReason({
    caseType: "property_optioning",
    currentStep: "package_ready",
    nextStep: "published",
  }),
  null
);

console.log("operational-cases-adapters.selftest: ok");

assert.equal(
  extractSurfaceTotalM2FromTextForTest(
    "la cual cuenta con una superficie total de 116.93 ciento dieciseis punto noventa y tres metros cuadrados"
  ),
  116.93
);

assert.equal(
  extractSurfaceTotalM2FromTextForTest(
    "la cual cuenta con una superficie total de I16.93 ciento dieciseis punto noventa y tres metros cuadrados"
  ),
  116.93
);

assert.equal(
  extractSurfaceTotalM2FromTextForTest(
    "la unidad privativa cuenta con una superficie total de ciento dieciseis punto noventa y tres metros cuadrados"
  ),
  116.93
);

assert.deepEqual(
  evaluatePropertyDataMinimumsForReview({
    property_type: "Terreno",
    property_data: {
      owner_names: ["Ana Propietaria"],
      legal_addresses: ["Privada del Tulipán, Zapopan"],
      area_total_m2: 116.93,
    },
  }).missing.map((item) => item.key),
  ["land_context"]
);

assert.deepEqual(
  evaluatePropertyDataMinimumsForReview(
    {
      property_type: "Terreno",
      property_data: {},
    },
    {
      owner_names: ["Ana Propietaria"],
      legal_addresses: ["Privada del Tulipán, Zapopan"],
      area_total_m2: 116.93,
    }
  ).missing.map((item) => item.key),
  ["land_context"]
);

const documentFieldsFromEscFilename = documentExtractionMinimumsContext([
  {
    kind: "unknown",
    display_name: "unknown",
    original_name: "Páginas desdeEsc 28551 Sendas0001 (1).pdf",
    status: "received",
    extraction_status: "low_confidence",
    extraction_jsonb: {
      owner_names: ["Ana Propietaria"],
      property_description: "Privada del Tulipán, Zapopan",
      area_total_m2: 116.93,
    },
  } as unknown as OperationalCaseDocument,
]);

assert.deepEqual(documentFieldsFromEscFilename.owner_names, ["Ana Propietaria"]);
assert.equal(documentFieldsFromEscFilename.owner_names_source, "documentos_compartidos");
assert.deepEqual(documentFieldsFromEscFilename.legal_addresses, [
  "Privada del Tulipán, Zapopan",
]);
assert.equal(documentFieldsFromEscFilename.area_total_m2, 116.93);

const documentFieldsFromBoletaLegalAddress = documentExtractionMinimumsContext([
  {
    kind: "boleta_registral",
    display_name: "boleta",
    original_name: "boleta-las-fuentes.pdf",
    status: "received",
    extraction_status: "ok",
    extraction_jsonb: {
      owner_names: ["MARIA CONCEPCION CASTANEDA GARCIA"],
      legal_address:
        "FRACCION C DEL LOTE 5-B, FINCA MARCADA CON EL NUMERO 3668, DE LA CALLE CIRCUNVALACION SUR, LAS FUENTES, ZAPOPAN, JALISCO",
      document_kind: "boleta_registral",
    },
  } as unknown as OperationalCaseDocument,
]);
assert.equal(
  (documentFieldsFromBoletaLegalAddress.legal_addresses as string[])[0]?.includes(
    "CIRCUNVALACION SUR"
  ),
  true
);
assert.equal(
  documentFieldsFromBoletaLegalAddress.legal_addresses_source,
  "boleta_registral"
);

const documentFieldsWithPendingBoletaAndEscritura = documentExtractionMinimumsContext([
  {
    kind: "boleta_registral",
    display_name: "boleta",
    original_name: "boleta-registral.pdf",
    status: "received",
    extraction_status: "pending",
    extraction_jsonb: {},
  } as unknown as OperationalCaseDocument,
  {
    kind: "escritura_descripcion",
    display_name: "escritura",
    original_name: "escritura-sucesion.pdf",
    status: "received",
    extraction_status: "ok",
    extraction_jsonb: {
      owner_names: ["Teresa Campos", "Sixto Elvira", "Celia García de Padilla"],
      legal_address:
        "Finca marcada con el número 185 de la calle Ribera del Lago, Jocotepec, Jalisco",
      document_kind: "escritura_descripcion",
    },
  } as unknown as OperationalCaseDocument,
]);
assert.equal(
  "owner_names" in documentFieldsWithPendingBoletaAndEscritura,
  false,
  "si hay boleta pendiente no debe canonizar titulares desde escritura"
);
assert.equal(
  "legal_addresses" in documentFieldsWithPendingBoletaAndEscritura,
  false,
  "si hay boleta pendiente no debe canonizar dirección legal desde escritura"
);
assert.deepEqual(
  documentFieldsWithPendingBoletaAndEscritura.owner_names_excluded_from_consistency,
  ["Teresa Campos", "Sixto Elvira", "Celia García de Padilla"]
);

const documentFieldsWithAmbiguousDeedAddress = documentExtractionMinimumsContext([
  {
    kind: "boleta_registral",
    display_name: "boleta",
    original_name: "boleta-las-fuentes.pdf",
    status: "received",
    extraction_status: "ok",
    extraction_jsonb: {
      owner_names: ["MARIA CONCEPCION CASTANEDA GARCIA"],
      legal_address:
        "FRACCION C DEL LOTE 5-B, FINCA MARCADA CON EL NUMERO 3668, DE LA CALLE CIRCUNVALACION SUR, LAS FUENTES, ZAPOPAN, JALISCO",
      document_kind: "boleta_registral",
    },
  } as unknown as OperationalCaseDocument,
  {
    kind: "escritura_descripcion",
    display_name: "escritura",
    original_name: "escritura-sucesion.pdf",
    status: "received",
    extraction_status: "ok",
    extraction_jsonb: {
      document_kind: "escritura_descripcion",
      multi_property_ambiguous: true,
      deed_property_match_low_confidence: true,
      address: {
        street: "Ribera del Lago",
        exterior_number: "185",
        neighborhood: "Las Fuentes",
        municipality: "Zapopan",
      },
    },
  } as unknown as OperationalCaseDocument,
]);
{
  const consolidatedAddress =
    (documentFieldsWithAmbiguousDeedAddress.address as Record<string, unknown> | undefined) ??
    {};
  assert.notEqual(
    consolidatedAddress.street,
    "Ribera del Lago",
    "una escritura multi-inmueble ambigua no debe poblar street canónico"
  );
  assert.notEqual(
    consolidatedAddress.exterior_number,
    "185",
    "una escritura multi-inmueble ambigua no debe poblar exterior_number canónico"
  );
  assert.equal(documentFieldsWithAmbiguousDeedAddress.address_needs_review, true);
}

const documentFieldsWithBoletaAndIne = documentExtractionMinimumsContext([
  {
    kind: "boleta_registral",
    display_name: "boleta",
    original_name: "boleta-registral.pdf",
    status: "received",
    extraction_status: "ok",
    extraction_jsonb: {
      owner_names: ["Maria Concepcion Castañeda Garcia"],
      area_total_m2: 1760,
      document_kind: "boleta_registral",
    },
  } as unknown as OperationalCaseDocument,
  {
    kind: "ine",
    display_name: "ine",
    original_name: "ine-frente.jpg",
    status: "received",
    extraction_status: "ok",
    extraction_jsonb: {
      owner_names: ["Teresa Campos"],
      document_kind: "identificacion_oficial",
    },
  } as unknown as OperationalCaseDocument,
]);
assert.deepEqual(documentFieldsWithBoletaAndIne.owner_names, [
  "Maria Concepcion Castañeda Garcia",
]);
assert.equal(documentFieldsWithBoletaAndIne.owner_names_source, "boleta_registral");
assert.equal(
  documentFieldsWithBoletaAndIne.owner_consistency_status,
  "mismatch"
);
assert.match(
  String(documentFieldsWithBoletaAndIne.owner_consistency_warning ?? ""),
  /no coinciden/i
);

const documentFieldsWithIneAndComprobanteCorroboration =
  documentExtractionMinimumsContext([
    {
      kind: "boleta_registral",
      display_name: "boleta",
      original_name: "boleta-registral.pdf",
      status: "received",
      extraction_status: "ok",
      extraction_jsonb: {
        owner_names: ["MARIA CONCEPCION CASTAÑEDA GARCIA"],
        document_kind: "boleta_registral",
      },
    } as unknown as OperationalCaseDocument,
    {
      kind: "ine",
      display_name: "ine",
      original_name: "INSTITUTO NACIONAL ELECTORAL (3).pdf",
      status: "received",
      extraction_status: "ok",
      extraction_jsonb: {
        holder_name: "Maria Concepcion Castaneda Garcia",
        document_kind: "identificacion_oficial",
      },
    } as unknown as OperationalCaseDocument,
    {
      kind: "comprobante_domicilio",
      display_name: "estado de cuenta",
      original_name: "Estado de cuenta diciembre 2025.pdf",
      status: "received",
      extraction_status: "ok",
      extraction_jsonb: {
        owner_name: "Maria Concepcion Castaneda Garcia",
        document_kind: "comprobante_domicilio",
      },
    } as unknown as OperationalCaseDocument,
  ]);
assert.equal(
  documentFieldsWithIneAndComprobanteCorroboration.owner_consistency_status,
  "match"
);
assert.deepEqual(
  documentFieldsWithIneAndComprobanteCorroboration.owner_consistency_matched_sources,
  ["identificacion oficial", "comprobante de domicilio"]
);

const documentFieldsWithReorderedOwnerName = documentExtractionMinimumsContext([
  {
    kind: "boleta_registral",
    display_name: "boleta",
    original_name: "boleta.pdf",
    status: "received",
    extraction_status: "ok",
    extraction_jsonb: {
      owner_names: ["MARIA CONCEPCION CASTAÑEDA GARCIA"],
      legal_address: "Direccion legal completa 123, Zapopan, Jalisco",
      document_kind: "boleta_registral",
    },
  } as unknown as OperationalCaseDocument,
  {
    kind: "ine",
    display_name: "ine",
    original_name: "ine.pdf",
    status: "received",
    extraction_status: "ok",
    extraction_jsonb: {
      owner_names: ["garcia castaneda maria concepcion"],
      document_kind: "identificacion_oficial",
    },
  } as unknown as OperationalCaseDocument,
  {
    kind: "escritura_descripcion",
    display_name: "escritura",
    original_name: "escritura.pdf",
    status: "received",
    extraction_status: "ok",
    extraction_jsonb: {
      owner_names: ["Teresa Campos", "Sixto Elvira"],
      legal_address: "Caminos Real",
      document_kind: "escritura_descripcion",
    },
  } as unknown as OperationalCaseDocument,
]);
assert.equal(documentFieldsWithReorderedOwnerName.owner_consistency_status, "match");
assert.deepEqual(documentFieldsWithReorderedOwnerName.owner_consistency_matched_sources, [
  "identificacion oficial",
]);
assert.deepEqual(documentFieldsWithReorderedOwnerName.owner_names_other_documents, [
  "garcia castaneda maria concepcion",
]);
assert.deepEqual(documentFieldsWithReorderedOwnerName.owner_names_excluded_from_consistency, [
  "Teresa Campos",
  "Sixto Elvira",
]);
assert.equal(
  documentFieldsWithReorderedOwnerName.legal_addresses_source,
  "boleta_registral"
);
assert.deepEqual(documentFieldsWithReorderedOwnerName.legal_addresses, [
  "Direccion legal completa 123, Zapopan, Jalisco",
]);

const documentFieldsWithPendingPredialAndEscritura = documentExtractionMinimumsContext([
  {
    kind: "predial",
    display_name: "predial",
    original_name: "predial.pdf",
    status: "received",
    extraction_status: "pending",
    extraction_jsonb: {},
  } as unknown as OperationalCaseDocument,
  {
    kind: "escritura_descripcion",
    display_name: "escritura",
    original_name: "escritura.pdf",
    status: "received",
    extraction_status: "ok",
    extraction_jsonb: {
      area_total_m2: 1760,
      document_kind: "escritura_descripcion",
    },
  } as unknown as OperationalCaseDocument,
]);
assert.equal(documentFieldsWithPendingPredialAndEscritura.area_total_m2, undefined);
assert.equal(
  documentFieldsWithPendingPredialAndEscritura.area_total_m2_source,
  undefined
);

const terrainMinimumsWithEscDocument = evaluatePropertyDataMinimumsForReview(
  {
    property_title: "Terreno en Sendas",
    property_zone: "Sendas Residencial",
    operation_type: "Venta",
    property_type: "Terreno",
    property_data: {},
  },
  documentFieldsFromEscFilename
);

assert.deepEqual(
  terrainMinimumsWithEscDocument.missing.map((item) => item.key),
  ["land_context"]
);

const minimumsMessage = buildPropertyDataMinimumsSummaryMessage({
  context: {
    property_title: "Terreno en Sendas",
    property_zone: "Sendas Residencial",
    operation_type: "Venta",
    property_type: "Terreno",
  },
  supplement: documentFieldsFromEscFilename,
  missing: terrainMinimumsWithEscDocument.missing,
});

assert.match(minimumsMessage, /Ya tengo estos datos del caso:/);
assert.match(minimumsMessage, /Dirección encontrada: Privada del Tulipán/);
assert.match(minimumsMessage, /Superficie de terreno encontrada: 116.93 m²/);
assert.match(minimumsMessage, /Titularidad tomada de boleta registral/i);
assert.doesNotMatch(minimumsMessage, /Dirección completa de la propiedad/);
assert.match(minimumsMessage, /coto\/condominio\/parque industrial/);
assert.doesNotMatch(minimumsMessage, /Aparecen solo en documentos de apoyo/i);

const ownerMatchMessage = buildPropertyDataMinimumsSummaryMessage({
  context: {
    property_title: "Casa en Las Fuentes",
    property_zone: "Las Fuentes",
    operation_type: "Venta",
    property_type: "Casa",
  },
  supplement: documentFieldsWithReorderedOwnerName,
  missing: [],
});
assert.match(ownerMatchMessage, /Coincidencia encontrada en: identificacion oficial\./);
assert.doesNotMatch(ownerMatchMessage, /Teresa Campos|Sixto Elvira/);

const documentFieldsWithFragmentedIneNames = documentExtractionMinimumsContext([
  {
    kind: "boleta_registral",
    display_name: "boleta",
    original_name: "boleta.pdf",
    status: "received",
    extraction_status: "ok",
    extraction_jsonb: {
      owner_names: ["MARIA CONCEPCION CASTAÑEDA GARCIA"],
      document_kind: "boleta_registral",
    },
  } as unknown as OperationalCaseDocument,
  {
    kind: "ine",
    display_name: "ine",
    original_name: "ine.pdf",
    status: "received",
    extraction_status: "ok",
    extraction_jsonb: {
      owner_names: ["CASTANEDA", "GARCIA", "MARIA", "CONCEP"],
      document_kind: "identificacion_oficial",
    },
  } as unknown as OperationalCaseDocument,
]);
assert.equal(
  documentFieldsWithFragmentedIneNames.owner_consistency_status,
  "insufficient"
);
assert.match(
  String(documentFieldsWithFragmentedIneNames.owner_consistency_note ?? ""),
  /fragmentos OCR/i
);

assert.deepEqual(
  extractPredialSurfacesFromTextForTest(
    [
      "DATOS DEL PREDIO",
      "CTA CATASTRAL FECHA SUP. TERR. SUP. CONST. VALOR FISCAL TASA",
      "2023 138.00 146.00 1,234,567.00 0.00023",
    ].join("\n")
  ),
  { area_total_m2: 138, area_construida_m2: 146 }
);

assert.deepEqual(
  extractPredialSurfacesFromTextForTest(
    [
      "TIPO SUP. TERR. SUP. CONST. SUP. PRIV. SUP. COM. VALOR CONST. VALOR TERR.",
      "U 138.00 146.00 0.00 0.00 1,022,000.00 834,900.00",
    ].join("\n")
  ),
  { area_total_m2: 138, area_construida_m2: 146 }
);

assert.deepEqual(
  extractPredialSurfacesFromTextForTest(
    [
      "SUP. TERR. SUP. CONST. SUP. PRIV. SUP. COM. VALOR CONST. VALOR TERR.",
      "0.00 0.00",
      "138.00 146.00 0.00 0.00",
    ].join("\n")
  ),
  { area_total_m2: 138, area_construida_m2: 146 }
);

assert.deepEqual(
  predialSurfacesFromContribuyenteRowValuesForTest([
    "U",
    "138.00",
    "146.00",
    "0.00",
    "0.00",
  ]),
  { area_total_m2: 138, area_construida_m2: 146 }
);

assert.deepEqual(
  normalizePredialExtractionSurfacesForTest(
    {
      document_kind: "predial",
      area_total_m2: 138,
      area_construida_m2: 14.6,
      predial_contribuyente_row_values: ["U", "138.00", "146.00", "0.00", "0.00"],
    },
    "predial"
  ),
  {
    document_kind: "predial",
    area_total_m2: 138,
    area_construida_m2: 146,
    predial_contribuyente_row_values: ["U", "138.00", "146.00", "0.00", "0.00"],
    area_total_m2_source: "predial_table_row_vision",
    area_construida_m2_source: "predial_table_row_vision",
    sup_terr: 138,
    sup_const: 146,
  }
);

assert.deepEqual(
  normalizePredialExtractionSurfacesForTest(
    {
      document_kind: "predial",
      predial_contribuyente_row_values: ["U", "138.00", "146.00", "0.00", "0.00"],
      sup_terr_raw: "146.00",
      sup_const_raw: "146.00",
    },
    "predial"
  ),
  {
    document_kind: "predial",
    predial_contribuyente_row_values: ["U", "138.00", "146.00", "0.00", "0.00"],
    sup_terr_raw: "146.00",
    sup_const_raw: "146.00",
    area_total_m2: 138,
    area_construida_m2: 146,
    area_total_m2_source: "predial_table_row_vision",
    area_construida_m2_source: "predial_table_row_vision",
    sup_terr: 138,
    sup_const: 146,
    warnings: ["Se ignoró SUP. TERR extraída por columna porque contradice la fila tabular del predial."],
  }
);

assert.deepEqual(
  normalizePredialExtractionSurfacesForTest(
    {
      document_kind: "predial",
      area_total_m2: 138,
      area_construida_m2: 14.6,
    },
    "predial"
  ).area_construida_m2,
  14.6
);

assert.deepEqual(
  normalizePredialExtractionSurfacesForTest(
    {
      document_kind: "predial",
      area_total_m2: 138,
      area_construida_m2: 14.6,
    },
    "predial"
  ).predial_area_construida_quality,
  {
    status: "implausible_decimal_misread_suspected",
    observed_m2: 14.6,
    suggested_m2: 146,
  }
);

assert.deepEqual(
  normalizePredialExtractionSurfacesForTest(
    {
      document_kind: "predial",
      area_total_m2: 138,
      area_construida_m2: 14.6,
      sup_const_raw: "146.00",
    },
    "predial"
  ),
  {
    document_kind: "predial",
    area_total_m2: 138,
    area_construida_m2: 146,
    sup_const_raw: "146.00",
    area_construida_m2_source: "predial_raw_column_vision",
    sup_const: 146,
  }
);

assert.deepEqual(
  evaluatePredialBuiltAreaQualityForTest({
    area_total_m2: 138,
    area_construida_m2: 14.6,
    sup_const_raw: "146.00",
  }),
  {
    implausible: false,
    observed_m2: 14.6,
    suggested_m2: 146,
    corroborated_m2: 146,
    corroboration_source: "predial_raw_column_vision",
  }
);

const partialOwnerMessage = buildPropertyDataMinimumsSummaryMessage({
  context: {
    property_title: "Casa en Las Fuentes",
    property_zone: "Las Fuentes",
    operation_type: "Venta",
    property_type: "Casa",
  },
  supplement: {
    owner_consistency_status: "partial_mismatch",
    owner_consistency_note:
      "Hay nombres adicionales en documentos de apoyo que no coinciden con boleta.",
    owner_consistency_matched_sources: [
      "predial",
      "identificacion oficial",
      "comprobante de domicilio",
    ],
    area_total_m2: 138,
    area_total_m2_source: "predial",
  },
  missing: [{ key: "area_construida_m2", label: "Metros cuadrados de construcción", question: "Metros cuadrados de construcción." }],
});
assert.match(partialOwnerMessage, /Coincidencia encontrada en: predial; identificacion oficial; comprobante de domicilio\./);
assert.match(partialOwnerMessage, /nombres adicionales en documentos de apoyo que no coinciden con boleta/i);
assert.doesNotMatch(partialOwnerMessage, /Teresa Campos|Sixto Elvira/);

assert.equal(
  evaluatePropertyDataMinimumsForReview({
    property_type: "Terreno",
    property_data: {
      owner_names: ["Ana Propietaria"],
      legal_addresses: ["Privada del Tulipán, Zapopan"],
      area_total_m2: 116.93,
      land_context: "coto residencial",
    },
  }).ok,
  true
);

assert.deepEqual(
  evaluatePropertyDataMinimumsForReview({
    property_type: "Casa",
    property_data: {
      owner_names: ["Ana Propietaria"],
      legal_addresses: ["Calle 1"],
      area_total_m2: 180,
      area_construida_m2: 120,
      floors: 2,
      bedrooms: 3,
      bathrooms: 2,
      half_bathrooms: 1,
    },
  }).missing.map((item) => item.key),
  ["integral_kitchen", "parking_spaces"]
);

assert.deepEqual(
  evaluatePropertyDataMinimumsForReview({
    property_type: "Casa",
    property_data: {
      owner_names: ["Ana Propietaria"],
      legal_addresses: ["Calle 1"],
      area_total_m2: 180,
      area_construida_m2: 120,
      floors: 2,
      bedrooms: 3,
      bathrooms: 2,
      half_bathrooms: 1,
      integral_kitchen: true,
      parking_spots: 0,
    },
  }).missing.map((item) => item.key),
  []
);

const reviewText = canonicalizePropertyDataReviewText(
  {
    id: "case-1",
    context_jsonb: {
      property_title: "Terreno en Sendas",
      property_zone: "Sendas Residencial",
      operation_type: "Venta",
      property_type: "Terreno",
    },
  } as unknown as Awaited<ReturnType<typeof import("@agents/db").getOperationalCase>>,
  [
    "Datos extraídos:",
    "- Tipo: Terreno",
    "- Operación: Venta",
    "- Zona: Sendas Residencial",
    "- Dirección legal: Privada del Tulipán, Zapopan",
    "- Superficie: 116.93 m²",
  ].join("\n")
);

assert.match(reviewText, /Datos confirmados por intake:/);
assert.match(reviewText, /Datos encontrados en documentos:/);
assert.doesNotMatch(reviewText, /Datos encontrados en documentos:[\s\S]*Tipo: Terreno/);
assert.doesNotMatch(reviewText, /Datos encontrados en documentos:[\s\S]*Operaci[oó]n: Venta/);
assert.doesNotMatch(reviewText, /Datos encontrados en documentos:[\s\S]*Zona: Sendas Residencial/);
assert.match(reviewText, /Direcci[oó]n legal: Privada del Tulipán, Zapopan/i);

assert.equal(contractDraftOutputPathFromContext({}), null);
assert.equal(
  contractDraftOutputPathFromContext({
    contract_draft: { output_path: "  " },
  }),
  null
);
assert.equal(
  contractDraftOutputPathFromContext({
    contract_draft: {
      output_path: "user/generated-documents/commission_contract/draft.docx",
    },
  }),
  "user/generated-documents/commission_contract/draft.docx"
);

const blockedContractReview = evaluateContractReviewNotifyGate({
  contract_draft: {},
});
assert.equal(blockedContractReview.ok, false);
if (!blockedContractReview.ok) {
  assert.equal(
    blockedContractReview.error,
    "contract_draft_required_before_review_notify"
  );
}

const allowedContractReview = evaluateContractReviewNotifyGate({
  contract_draft: {
    output_path: "user/generated-documents/commission_contract/draft.docx",
  },
});
assert.equal(allowedContractReview.ok, true);
if (allowedContractReview.ok) {
  assert.equal(
    allowedContractReview.output_path,
    "user/generated-documents/commission_contract/draft.docx"
  );
}

assert.equal(
  listingDescriptionDraftContentFromContext({
    listing_description_draft: { headline: "Casa", description: "  " },
  }),
  null
);
assert.deepEqual(
  listingDescriptionDraftContentFromContext({
    listing_description_draft: {
      headline: "Casa luminosa",
      description: "Descripción comercial completa.",
    },
  }),
  {
    headline: "Casa luminosa",
    description: "Descripción comercial completa.",
  }
);

const blockedListingReview = evaluateListingDescriptionReviewNotifyGate({
  listing_description_draft: { headline: "Sin cuerpo" },
});
assert.equal(blockedListingReview.ok, false);
if (!blockedListingReview.ok) {
  assert.equal(
    blockedListingReview.error,
    "listing_description_draft_required_before_review_notify"
  );
}

const allowedListingReview = evaluateListingDescriptionReviewNotifyGate({
  listing_description_draft: {
    headline: "Departamento",
    description: "Amplio departamento con luz natural.",
  },
});
assert.equal(allowedListingReview.ok, true);
if (allowedListingReview.ok) {
  assert.equal(allowedListingReview.draft.description, "Amplio departamento con luz natural.");
}

const ownerEmailReviewText = buildContractDataReviewNotifyText(["owner_email"]);
assert.match(ownerEmailReviewText, /correo electr[oó]nico del propietario/i);
assert.match(ownerEmailReviewText, /owner_email/);

const multiFieldReviewText = buildContractDataReviewNotifyText([
  "owner_name",
  "property_address",
]);
assert.match(multiFieldReviewText, /owner_name/);
assert.match(multiFieldReviewText, /property_address/);

console.log("operational-cases-adapters surface selftest ok");
