import assert from "node:assert/strict";
import type { OperationalCaseEvent, ToolCall } from "@agents/types";
import {
  buildE2ETransitionGroups,
  buildE2ETransitionStepSubgroups,
  buildE2ETransitionSubgroupTimeline,
  formatE2ETransitionGroupTitle,
  inferE2ETransitionStepAfter,
  UNATTRIBUTED_E2E_STEP_SUBGROUP_LABEL,
} from "./settings-test-e2e-transitions";
import { eventBelongsToStep } from "./settings-test-flow-progress";

function event(
  id: string,
  created_at: string,
  payload: Record<string, unknown>,
  event_type = "step_completed"
): OperationalCaseEvent {
  return {
    id,
    case_id: "case-1",
    event_type,
    actor: "system",
    payload_jsonb: payload,
    created_at,
  } as OperationalCaseEvent;
}

const anchor = "2026-06-02T19:35:52.322Z";

const e2e1 = event("e1", "2026-06-02T19:45:00.000Z", {
  kind: "controlled_test_e2e_started",
  current_step: "price_proposal_pending",
});
const state1 = event("s1", "2026-06-02T19:45:05.000Z", {
  to: { current_step: "price_proposal_pending", status: "active" },
  from: { current_step: "price_proposal_pending", status: "paused" },
}, "state_changed");
const approvalRequested = event(
  "a1",
  "2026-06-02T19:45:08.000Z",
  { kind: "price_approval_requested" },
  "human_decision"
);
const approved = event(
  "a2",
  "2026-06-02T19:45:15.000Z",
  {
    kind: "price_approved",
    to: { current_step: "contract_pending", status: "active" },
  },
  "human_decision"
);
const comparablesCompleted = event(
  "a0",
  "2026-06-02T19:45:06.000Z",
  {
    kind: "comparables_analysis_completed",
    to: { current_step: "price_proposal_pending", status: "active" },
  },
  "state_changed"
);
const e2e2 = event("e2", "2026-06-02T20:20:00.000Z", {
  kind: "controlled_test_e2e_started",
  current_step: "price_proposal_pending",
});

const groups = buildE2ETransitionGroups({
  events: [e2e1, comparablesCompleted, state1, approvalRequested, approved, e2e2],
  toolCalls: [],
  anchorAt: anchor,
  e2eStartEvents: [e2e1, e2e2],
  stepLabels: { price_proposal_pending: "Preparar precio" },
});

assert.equal(groups.length, 2);

const groupsFromDbStarts = buildE2ETransitionGroups({
  events: [state1],
  toolCalls: [],
  anchorAt: anchor,
  e2eStartEvents: [e2e1, e2e2],
  stepLabels: { price_proposal_pending: "Preparar precio" },
});
assert.equal(
  groupsFromDbStarts.length,
  2,
  "e2e starts from DB align counter even if start events are outside recent window"
);
assert.equal(groups[0]!.index, 1);
assert.equal(groups[0]!.stepKey, "price_proposal_pending");
assert.equal(groups[0]!.events.length, 5);
assert.deepEqual(
  groups[0]!.events.map((event) => event.id),
  ["e1", "s1", "a0", "a1", "a2"],
  "eventos de una transición deben mostrarse en orden cronológico"
);
assert.equal(groups[1]!.index, 2);
assert.equal(groups[1]!.events.length, 1);

assert.equal(
  inferE2ETransitionStepAfter(groups[0]!),
  "contract_pending",
  "debe inferir el paso final desde el último state change con to.current_step"
);
assert.equal(
  formatE2ETransitionGroupTitle({
    index: 1,
    stepBefore: "price_proposal_pending",
    stepAfter: "contract_pending",
    stepLabels: { price_proposal_pending: "Preparar precio", contract_pending: "Preparar contrato" },
  }),
  "Transición 1 · Preparar precio → Preparar contrato"
);
assert.equal(
  formatE2ETransitionGroupTitle({
    index: 2,
    stepBefore: "price_proposal_pending",
    stepAfter: "price_proposal_pending",
    stepLabels: { price_proposal_pending: "Preparar precio" },
  }),
  "Transición 2 · Preparar precio"
);

const groupedByStep = buildE2ETransitionStepSubgroups({
  group: {
    ...groups[0]!,
    events: [
      {
        ...groups[0]!.events[0]!,
        payload_jsonb: {
          ...(groups[0]!.events[0]!.payload_jsonb ?? {}),
          step_key: "price_proposal_pending",
        },
      } as OperationalCaseEvent,
      {
        ...groups[0]!.events[1]!,
        payload_jsonb: {
          ...(groups[0]!.events[1]!.payload_jsonb ?? {}),
          step_key: "contract_pending",
        },
      } as OperationalCaseEvent,
      groups[0]!.events[2]!,
    ],
    toolCalls: [
      {
        id: "t-price",
        session_id: "s1",
        tool_name: "notify_user",
        arguments_json: {},
        status: "executed",
        requires_confirmation: false,
        created_at: "2026-06-02T19:45:09.000Z",
        metadata_jsonb: { operational_step_key: "price_proposal_pending" },
      } as ToolCall,
      {
        id: "t-legacy",
        session_id: "s1",
        tool_name: "generate_document_from_template",
        arguments_json: {},
        status: "executed",
        requires_confirmation: false,
        created_at: "2026-06-02T19:45:14.000Z",
      } as ToolCall,
    ],
  },
  stepLabels: {
    price_proposal_pending: "Preparar precio",
    contract_pending: "Preparar contrato",
  },
});
assert.equal(groupedByStep.length, 3);
assert.equal(groupedByStep[0]?.stepKey, "price_proposal_pending");
assert.equal(groupedByStep[0]?.stepLabel, "Preparar precio");
assert.equal(groupedByStep[1]?.stepKey, "contract_pending");
assert.equal(groupedByStep[2]?.stepKey, null);
assert.equal(groupedByStep[2]?.bucket, "legacy");
assert.equal(
  groupedByStep[2]?.stepLabel,
  UNATTRIBUTED_E2E_STEP_SUBGROUP_LABEL
);

const chronologicalSubgroups = buildE2ETransitionStepSubgroups({
  group: {
    index: 3,
    startedAt: "2026-06-28T21:35:10.000Z",
    stepKey: "contract_pending",
    stepLabel: "Preparar contrato",
    events: [
      event("contract-entered", "2026-06-28T21:35:10.500Z", {
        kind: "contract_preparation_entered",
        step_key: "contract_pending",
      }),
      event("price-prepared", "2026-06-28T21:35:10.200Z", {
        kind: "price_proposal_prepared",
        step_key: "price_proposal_pending",
      }),
    ],
    toolCalls: [],
  },
  stepLabels: {
    price_proposal_pending: "Preparar precio",
    contract_pending: "Preparar contrato",
  },
});
assert.deepEqual(
  chronologicalSubgroups.map((subgroup) => subgroup.stepKey),
  ["price_proposal_pending", "contract_pending"],
  "subgrupos deben ordenarse por primera actividad, no por paso ancla de la transición"
);

const timeline = buildE2ETransitionSubgroupTimeline(groupedByStep[0]!);
assert.deepEqual(
  timeline.map((item) => item.id),
  [groupedByStep[0]!.events[0]!.id, "t-price"],
  "timeline de subgrupo debe intercalar eventos y tools en orden cronológico"
);

assert.equal(
  eventBelongsToStep(e2e1, "price_proposal_pending", 4),
  true,
  "e2e_started follows payload current_step"
);
assert.equal(
  eventBelongsToStep(e2e1, "intake", 0),
  false,
  "e2e_started must not fall back to step index 0"
);
assert.equal(
  eventBelongsToStep(state1, "price_proposal_pending", 4),
  true,
  "state_changed to.current_step"
);
assert.equal(
  eventBelongsToStep(comparablesCompleted, "price_proposal_pending", 4),
  true,
  "comparables_analysis_completed to price should be attributed to step 4"
);
assert.equal(
  eventBelongsToStep(approvalRequested, "price_proposal_pending", 4),
  true,
  "price_approval_requested should be attributed to step 4"
);
assert.equal(
  eventBelongsToStep(approved, "price_proposal_pending", 4),
  true,
  "price_approved should be attributed to step 4"
);

console.log("settings-test-e2e-transitions.selftest: ok");
