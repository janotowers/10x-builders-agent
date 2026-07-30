import assert from "node:assert/strict";
import type { OperationalCaseFlowStep } from "@agents/types";
import { replayCaseThroughDefinition, type ReplayEvent } from "./replay";
import { transformFlowToGraph } from "./transform-flow";

const flow: OperationalCaseFlowStep[] = [
  { step_key: "intake", step_label: "Intake" },
  { step_key: "awaiting_documents", step_label: "Docs" },
  { step_key: "documents_received", step_label: "Recibidos" },
  { step_key: "comparables_in_progress", step_label: "Comparables" },
  { step_key: "price_proposal_pending", step_label: "Precio" },
  { step_key: "contract_pending", step_label: "Contrato" },
  { step_key: "photos_requested", step_label: "Fotos" },
  { step_key: "package_ready", step_label: "Paquete" },
];
const graph = transformFlowToGraph({ caseType: "property_optioning", flow });

function stateChange(
  from: string | null,
  to: string,
  actor: string = "agent"
): ReplayEvent {
  return {
    event_type: "state_changed",
    actor,
    payload_jsonb: {
      from: { current_step: from },
      to: { current_step: to },
    },
  };
}

// 1. Clean history: legal transitions all the way; terminal state matches.
const cleanEvents: ReplayEvent[] = [
  stateChange(null, "intake"),
  stateChange("intake", "awaiting_documents"),
  { event_type: "external_response", actor: "external" },
  stateChange("awaiting_documents", "documents_received"),
  stateChange("documents_received", "property_data_review", "user"),
  stateChange("property_data_review", "comparables_in_progress", "user"),
  stateChange("comparables_in_progress", "price_proposal_pending", "system"),
  stateChange("price_proposal_pending", "contract_pending", "user"),
];
const clean = replayCaseThroughDefinition({
  graph,
  caseType: "property_optioning",
  events: cleanEvents,
  finalStep: "contract_pending",
  finalContext: {
    comparables_analysis: { data_quality: { unique_comparable_count: 4 } },
  },
});
assert.equal(clean.ok, true, "terminal state must match");
assert.equal(clean.terminalStep, "contract_pending");
assert.equal(
  clean.divergences.length,
  0,
  `clean history must have no divergences: ${JSON.stringify(clean.divergences)}`
);
assert.equal(clean.transitions.length, 7);

// 2. History with a divergence: documents_received advance WITHOUT a prior
// external_response fails the guard, but replay still lands on the recorded
// terminal state (history is truth).
const divergentEvents: ReplayEvent[] = [
  stateChange(null, "intake"),
  stateChange("intake", "awaiting_documents"),
  stateChange("awaiting_documents", "documents_received"), // no external_response (D4)
];
const divergent = replayCaseThroughDefinition({
  graph,
  caseType: "property_optioning",
  events: divergentEvents,
  finalStep: "documents_received",
});
assert.equal(divergent.ok, true);
assert.equal(divergent.divergences.length, 1);
assert.deepEqual(divergent.divergences[0].failedGuards, [
  "external_response_exists",
]);

// 3. Terminal mismatch is reported (event stream truncated vs case row).
const truncated = replayCaseThroughDefinition({
  graph,
  caseType: "property_optioning",
  events: divergentEvents.slice(0, 2),
  finalStep: "documents_received",
});
assert.equal(truncated.ok, false);
assert.equal(truncated.terminalStep, "awaiting_documents");

// 4. Undeclared forward skip is a divergence with reason undeclared_transition.
const skipping = replayCaseThroughDefinition({
  graph,
  caseType: "property_optioning",
  events: [stateChange(null, "intake"), stateChange("intake", "package_ready")],
  finalStep: "package_ready",
});
assert.equal(skipping.ok, true);
assert.equal(skipping.divergences.length, 1);
assert.equal(skipping.divergences[0].reason, "undeclared_transition");

// 5. Events without step payloads (reminders, notes) are ignored.
const noisy = replayCaseThroughDefinition({
  graph,
  caseType: "property_optioning",
  events: [
    { event_type: "reminder_sent", actor: "system" },
    stateChange(null, "intake"),
    { event_type: "human_decision", actor: "user", payload_jsonb: { kind: "x" } },
  ],
  finalStep: "intake",
});
assert.equal(noisy.ok, true);
assert.equal(noisy.transitions.length, 1);

// 6. Unrecorded gaps: when the stream's `from` disagrees with the tracked
// state, replay re-anchors on the recorded value and counts the gap instead
// of reporting a false divergence.
const gappedEvents: ReplayEvent[] = [
  stateChange(null, "intake"),
  // awaiting_documents/documents_received transitions were never recorded:
  stateChange("comparables_in_progress", "price_proposal_pending", "system"),
];
const gapped = replayCaseThroughDefinition({
  graph,
  caseType: "property_optioning",
  events: gappedEvents,
  finalStep: "price_proposal_pending",
  finalContext: {
    comparables_analysis: { data_quality: { unique_comparable_count: 3 } },
  },
});
assert.equal(gapped.ok, true);
assert.equal(gapped.unrecordedGaps, 1);
assert.equal(
  gapped.divergences.length,
  0,
  `re-anchored transition must be legal: ${JSON.stringify(gapped.divergences)}`
);
assert.equal(clean.unrecordedGaps, 0);

console.log("replay.selftest: OK");
