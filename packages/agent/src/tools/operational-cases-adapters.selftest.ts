import assert from "node:assert/strict";
import {
  blockedAwaitingDocumentsTransitionReason,
  buildPropertyDataMinimumsSummaryMessage,
  buildOperationalCaseIntakeUpdateContext,
  buildOperationalCaseCreateContext,
  canonicalizePropertyDataReviewText,
  documentExtractionMinimumsContext,
  evaluatePropertyDataMinimumsForReview,
  extractSurfaceTotalM2FromTextForTest,
  missingRequiredIntakeFields,
  operationalCaseIntakeSuccessStep,
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
assert.deepEqual(documentFieldsFromEscFilename.legal_addresses, [
  "Privada del Tulipán, Zapopan",
]);
assert.equal(documentFieldsFromEscFilename.area_total_m2, 116.93);

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
assert.match(minimumsMessage, /Superficie encontrada: 116.93 m²/);
assert.doesNotMatch(minimumsMessage, /Dirección completa de la propiedad/);
assert.match(minimumsMessage, /coto\/condominio\/parque industrial/);

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
  ["integral_kitchen"]
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

console.log("operational-cases-adapters surface selftest ok");
