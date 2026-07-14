import assert from "node:assert/strict";
import {
  formatFlowStepEvidenceSummaryLine,
  formatStepScenarioChecklist,
  formatStepScenarioProgress,
  stepScenarioBucketCounts,
  summarizeFlowStepEvidence,
} from "./readiness-test-ui";
import type { StepTestProgressSummary } from "./readiness-test-ui";

const contractPendingComplete: StepTestProgressSummary = {
  scenarios_total: 4,
  scenarios_passed: 4,
  scenarios_failed: 0,
  scenarios_pending: 0,
  scenarios: [
    {
      id: "contract_pending_template_missing",
      label: "Plantilla ausente o inválida (guardrail)",
      status: "tested_failed",
      optional: true,
    },
    {
      id: "contract_pending_draft_review",
      label: "Borrador de contrato para revisión",
      status: "tested_ok",
    },
    {
      id: "contract_pending_advisor_approves_send",
      label: "Asesor aprueba envío al dueño",
      status: "tested_ok",
    },
    {
      id: "contract_pending_advisor_requests_changes",
      label: "Asesor pide cambios al borrador",
      status: "tested_ok",
    },
    {
      id: "contract_pending_owner_signed",
      label: "Dueño devuelve contrato firmado",
      status: "tested_ok",
    },
  ],
};

const counts = stepScenarioBucketCounts(contractPendingComplete);
assert.equal(counts?.milestoneTotal, 4);
assert.equal(counts?.optionalTotal, 1);
assert.equal(counts?.optionalFailed, 1);

assert.equal(
  formatStepScenarioProgress(contractPendingComplete),
  "4/4 escenarios del hito probados · 1 escenario opcional con fallo"
);

const checklist = formatStepScenarioChecklist(contractPendingComplete);
assert.ok(checklist?.includes("✓ Borrador de contrato para revisión"));
assert.ok(checklist?.includes("Opcional: ✗ Plantilla ausente"));

const noOptional: StepTestProgressSummary = {
  scenarios_total: 1,
  scenarios_passed: 1,
  scenarios: [
    { id: "only", label: "Único", status: "tested_ok", optional: false },
  ],
};
assert.equal(
  formatStepScenarioProgress(noOptional),
  "1/1 escenarios probados"
);

{
  const blockedSummary = summarizeFlowStepEvidence(
    ["event:state_changed", "tool:generate_document_from_template:failed"],
    [
      {
        kind: "event",
        summary: "Preparación de contrato iniciada",
      },
      {
        kind: "tool",
        tool_name: "generate_document_from_template",
        status: "failed",
        summary: "Preflight de contrato bloqueado — requiere datos contractuales",
        result_json: {
          status: "blocked",
          error: "commission_contract_missing_required_data",
        },
      },
    ]
  );
  assert.equal(blockedSummary.toolBlocked, 1);
  assert.equal(blockedSummary.toolFailed, 0);
  assert.match(
    formatFlowStepEvidenceSummaryLine(blockedSummary),
    /1 bloqueada/
  );
  assert.equal(
    formatFlowStepEvidenceSummaryLine(blockedSummary).includes("fallida"),
    false
  );

  const realFailSummary = summarizeFlowStepEvidence(
    ["tool:generate_document_from_template:failed"],
    [
      {
        kind: "tool",
        tool_name: "generate_document_from_template",
        status: "failed",
        summary: "generate_document_from_template · Fallida",
        result_json: {
          status: "failed",
          error: "No se pudo guardar el documento",
        },
      },
    ]
  );
  assert.equal(realFailSummary.toolFailed, 1);
  assert.equal(realFailSummary.toolBlocked, 0);
}

console.log("readiness-test-ui.selftest: ok");
