import assert from "node:assert/strict";
import type { OperationalCaseFlowStep } from "@agents/types";
import {
  collectStepDecisionWarnings,
  normalizeStepDecision,
} from "./step-decision";

assert.equal(normalizeStepDecision(null), undefined);
assert.equal(normalizeStepDecision({}), undefined);
assert.equal(normalizeStepDecision({ id: "x", label: "Y", branches: [] }), undefined);

const decision = normalizeStepDecision({
  id: "document_request_target",
  label: "¿Quién aporta?",
  context_key: "document_request_target",
  decided_by_hint: "Post-intake",
  branches: [
    {
      value: "internal_user",
      label: "Interno",
      expected_status: "waiting_internal",
      primary_tool_ids: ["notify_user", "notify_user"],
      scenario_ids: ["awaiting_documents_internal_upload"],
    },
    {
      value: "external_contact",
      label: "Externo",
      expected_status: "not_a_status",
      primary_tool_ids: ["telegram_send_message_to_contact"],
      scenario_ids: ["awaiting_documents_outreach"],
    },
  ],
  shared_tool_ids: ["operational_case_list_documents", ""],
});

assert.ok(decision);
assert.equal(decision!.id, "document_request_target");
assert.equal(decision!.branches.length, 2);
assert.deepEqual(decision!.branches[0]!.primary_tool_ids, ["notify_user"]);
assert.equal(decision!.branches[1]!.expected_status, undefined);
assert.deepEqual(decision!.shared_tool_ids, ["operational_case_list_documents"]);

const stepOk: OperationalCaseFlowStep = {
  step_key: "awaiting_documents",
  step_label: "Reunir documentos",
  step_skills: [
    {
      skill_slug: "request-property-documents",
      skill_tools: [
        { tool_id: "telegram_send_message_to_contact" },
        { tool_id: "notify_user" },
        { tool_id: "operational_case_list_documents" },
      ],
    },
  ],
  step_decision: decision!,
};

assert.equal(
  collectStepDecisionWarnings({
    step: stepOk,
    knownScenarioIds: [
      "awaiting_documents_outreach",
      "awaiting_documents_internal_upload",
    ],
  }).length,
  0
);

const stepBad: OperationalCaseFlowStep = {
  ...stepOk,
  step_decision: {
    ...decision!,
    branches: [
      ...decision!.branches,
      {
        value: "internal_user",
        label: "Dup",
        primary_tool_ids: ["missing_tool"],
        scenario_ids: ["no_such_scenario"],
      },
    ],
    shared_tool_ids: ["also_missing"],
  },
};

const warnings = collectStepDecisionWarnings({
  step: stepBad,
  knownScenarioIds: [
    "awaiting_documents_outreach",
    "awaiting_documents_internal_upload",
  ],
});
assert.ok(warnings.some((w) => w.code === "duplicate_branch_value"));
assert.ok(warnings.some((w) => w.code === "unknown_primary_tool"));
assert.ok(warnings.some((w) => w.code === "unknown_scenario_id"));
assert.ok(warnings.some((w) => w.code === "unknown_shared_tool"));

// Fase F — shapes mapeados a N4 existentes (documents_received / comparables).
const documentsDecision = normalizeStepDecision({
  id: "critical_property_data",
  label: "¿Datos críticos completos?",
  context_key: "property_data.missing_critical_fields",
  branches: [
    {
      value: "complete",
      label: "Completos → revisión interna",
      expected_status: "waiting_internal",
      primary_tool_ids: ["notify_user"],
      scenario_ids: ["documents_received_property_data_review"],
    },
    {
      value: "pending_external",
      label: "Faltantes → contacto externo",
      expected_status: "waiting_external",
      primary_tool_ids: ["telegram_send_message_to_contact"],
      scenario_ids: ["documents_received_characteristics_pending"],
    },
    {
      value: "pending_internal",
      label: "Faltantes → equipo interno",
      expected_status: "waiting_internal",
      primary_tool_ids: ["notify_user"],
      scenario_ids: ["documents_received_characteristics_pending_internal"],
    },
  ],
  shared_tool_ids: [
    "operational_case_list_documents",
    "operational_case_extract_document_fields",
  ],
});
assert.ok(documentsDecision);
assert.equal(documentsDecision!.branches.length, 3);
assert.equal(
  collectStepDecisionWarnings({
    step: {
      step_key: "documents_received",
      step_label: "Extraer características",
      step_skills: [
        {
          skill_slug: "extract-property-characteristics",
          skill_tools: [
            { tool_id: "operational_case_list_documents" },
            { tool_id: "operational_case_extract_document_fields" },
            { tool_id: "telegram_send_message_to_contact" },
            { tool_id: "notify_user" },
          ],
        },
      ],
      step_decision: documentsDecision!,
    },
    knownScenarioIds: [
      "documents_received_property_data_review",
      "documents_received_characteristics_pending",
      "documents_received_characteristics_pending_internal",
    ],
  }).length,
  0
);

const comparablesDecision = normalizeStepDecision({
  id: "defensible_comparables_sample",
  label: "¿Muestra de comparables defendible?",
  context_key: "comparables_analysis.data_quality.usable_count",
  branches: [
    {
      value: "defensible",
      label: "Muestra defendible → precio",
      expected_status: "active",
      primary_tool_ids: ["operational_case_update_state"],
      scenario_ids: ["comparables_in_progress_complete"],
    },
    {
      value: "insufficient",
      label: "Sin usables → no avanzar",
      expected_status: "waiting_internal",
      primary_tool_ids: ["notify_user"],
      scenario_ids: ["comparables_in_progress_insufficient_data"],
    },
  ],
  shared_tool_ids: [
    "easybroker_search_listings",
    "easybroker_search_closed_deals",
    "bigquery_lookup_local_comparables",
    "geocode_property_address",
    "get_avaclick_valuation",
    "operational_case_persist_comparables_analysis",
  ],
});
assert.ok(comparablesDecision);
assert.equal(
  collectStepDecisionWarnings({
    step: {
      step_key: "comparables_in_progress",
      step_label: "Análisis de comparables",
      step_skills: [
        {
          skill_slug: "perform-comparable-analysis",
          skill_tools: [
            { tool_id: "easybroker_search_listings" },
            { tool_id: "easybroker_search_closed_deals" },
            { tool_id: "bigquery_lookup_local_comparables" },
            { tool_id: "geocode_property_address" },
            { tool_id: "get_avaclick_valuation" },
            { tool_id: "operational_case_persist_comparables_analysis" },
            { tool_id: "operational_case_update_state" },
            { tool_id: "notify_user" },
          ],
        },
      ],
      step_decision: comparablesDecision!,
    },
    knownScenarioIds: [
      "comparables_in_progress_complete",
      "comparables_in_progress_insufficient_data",
    ],
  }).length,
  0
);

console.log("step-decision.selftest: ok");
