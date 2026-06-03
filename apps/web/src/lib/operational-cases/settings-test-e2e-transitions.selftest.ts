import assert from "node:assert/strict";
import type { OperationalCaseEvent, ToolCall } from "@agents/types";
import { buildE2ETransitionGroups } from "./settings-test-e2e-transitions";
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
const e2e2 = event("e2", "2026-06-02T20:20:00.000Z", {
  kind: "controlled_test_e2e_started",
  current_step: "price_proposal_pending",
});

const groups = buildE2ETransitionGroups({
  events: [e2e1, state1, e2e2],
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
assert.equal(groups[0]!.events.length, 2);
assert.equal(groups[1]!.index, 2);
assert.equal(groups[1]!.events.length, 1);

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

console.log("settings-test-e2e-transitions.selftest: ok");
