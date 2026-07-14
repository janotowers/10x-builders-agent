import assert from "node:assert/strict";
import {
  buildStepTestProgress,
  mergeStepScenarioEvidenceMaps,
  parseStepScenarioEvidenceFromEvents,
  parseStepScenarioEvidenceFromRuns,
  resolveStepN4TestStatus,
} from "./step-test-scenario-evidence";

const events = [
  {
    created_at: "2026-05-29T10:00:00Z",
    payload_jsonb: {
      kind: "step_test_completed",
      step_key: "contract_pending",
      scenario_id: "contract_pending_draft_review",
      status: "tested_ok",
    },
  },
  {
    created_at: "2026-05-29T11:00:00Z",
    payload_jsonb: {
      kind: "step_test_completed",
      step_key: "contract_pending",
      scenario_id: "contract_pending_advisor_approves_send",
      status: "tested_ok",
    },
  },
];

const evidence = parseStepScenarioEvidenceFromEvents(events);
const progress = buildStepTestProgress({
  catalogSlug: "property_optioning",
  stepKey: "contract_pending",
  scenarioEvidence: evidence.get("contract_pending"),
});
assert.equal(progress?.scenarios_total, 3);
assert.equal(progress?.scenarios?.length, 6);
assert.equal(
  progress?.scenarios?.filter((s) => s.optional).length,
  3
);
assert.equal(progress?.scenarios_passed, 2);
assert.equal(progress?.scenarios_pending, 1);

const partial = resolveStepN4TestStatus({
  catalogSlug: "property_optioning",
  stepKey: "contract_pending",
  scenarioEvidence: evidence.get("contract_pending"),
  allSkillsOk: true,
  directToolsOk: true,
});
assert.equal(partial.status, "partially_tested");

const allOkEvents = [
  "contract_pending_draft_review",
  "contract_pending_template_missing",
  "contract_pending_advisor_approves_send",
  "contract_pending_advisor_requests_changes",
  "contract_pending_owner_signed",
].map((scenario_id, index) => ({
  created_at: `2026-05-29T12:0${index}:00Z`,
  payload_jsonb: {
    kind: "step_test_completed",
    step_key: "contract_pending",
    scenario_id,
    status: "tested_ok",
  },
}));
const fullEvidence = parseStepScenarioEvidenceFromEvents(allOkEvents);
const complete = resolveStepN4TestStatus({
  catalogSlug: "property_optioning",
  stepKey: "contract_pending",
  scenarioEvidence: fullEvidence.get("contract_pending"),
  allSkillsOk: true,
  directToolsOk: true,
});
assert.equal(complete.status, "tested_ok");

const legacyOnly = parseStepScenarioEvidenceFromEvents([
  {
    created_at: "2026-05-29T09:00:00Z",
    payload_jsonb: {
      kind: "step_test_completed",
      step_key: "price_proposal_pending",
      status: "tested_ok",
    },
  },
]);
const legacyProgress = buildStepTestProgress({
  catalogSlug: "property_optioning",
  stepKey: "price_proposal_pending",
  scenarioEvidence: legacyOnly.get("price_proposal_pending"),
});
assert.equal(legacyProgress?.scenarios_total, 3);
assert.equal(legacyProgress?.scenarios_passed, 0);
assert.equal(legacyProgress?.scenarios_partial, 1);

const runEvidence = parseStepScenarioEvidenceFromRuns([
  {
    level: "n4",
    status: "completed",
    step_key: "price_proposal_pending",
    scenario_id: "price_proposal_pending_hitl",
    result_jsonb: { status: "tested_ok" },
    finished_at: "2026-05-29T13:00:00Z",
  },
  {
    level: "n4",
    status: "completed",
    step_key: "price_proposal_pending",
    scenario_id: "price_proposal_pending_advisor_approves",
    result_jsonb: { status: "tested_failed" },
    finished_at: "2026-05-29T13:05:00Z",
  },
]);
const runProgress = buildStepTestProgress({
  catalogSlug: "property_optioning",
  stepKey: "price_proposal_pending",
  scenarioEvidence: runEvidence.get("price_proposal_pending"),
});
assert.equal(runProgress?.scenarios_total, 3);
assert.equal(runProgress?.scenarios_passed, 1);
assert.equal(runProgress?.scenarios_failed, 1);
assert.equal(runProgress?.scenarios_pending, 1);

const awaiting = resolveStepN4TestStatus({
  catalogSlug: "property_optioning",
  stepKey: "awaiting_documents",
  scenarioEvidence: undefined,
  allSkillsOk: false,
  directToolsOk: true,
});
assert.equal(awaiting.status, "awaiting_n4");
assert.ok(awaiting.progress && awaiting.progress.scenarios_total > 0);
assert.equal(awaiting.progress?.scenarios_total, 2);

const awaitingOneOk = resolveStepN4TestStatus({
  catalogSlug: "property_optioning",
  stepKey: "awaiting_documents",
  scenarioEvidence: parseStepScenarioEvidenceFromEvents([
    {
      created_at: "2026-07-09T12:00:00Z",
      payload_jsonb: {
        kind: "step_test_completed",
        step_key: "awaiting_documents",
        scenario_id: "awaiting_documents_outreach",
        status: "tested_ok",
      },
    },
  ]).get("awaiting_documents"),
  allSkillsOk: true,
  directToolsOk: true,
});
assert.equal(awaitingOneOk.status, "partially_tested");
assert.equal(awaitingOneOk.progress?.scenarios_passed, 1);
assert.equal(awaitingOneOk.progress?.scenarios_pending, 1);

const merged = mergeStepScenarioEvidenceMaps(
  runEvidence,
  parseStepScenarioEvidenceFromEvents([
    {
      created_at: "2026-05-29T14:00:00Z",
      payload_jsonb: {
        kind: "step_test_completed",
        step_key: "price_proposal_pending",
        scenario_id: "price_proposal_pending_advisor_adjusts",
        status: "tested_ok",
      },
    },
  ])
);
const mergedProgress = buildStepTestProgress({
  catalogSlug: "property_optioning",
  stepKey: "price_proposal_pending",
  scenarioEvidence: merged.get("price_proposal_pending"),
});
assert.equal(mergedProgress?.scenarios_passed, 2);

console.log("step-test-scenario-evidence.selftest: ok");
