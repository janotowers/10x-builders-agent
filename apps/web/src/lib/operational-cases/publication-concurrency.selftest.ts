import assert from "node:assert/strict";
import {
  applyPublicationEvent,
  emptyPublicationState,
  nextPublicationAction,
} from "./publication-workflow";

/**
 * Concurrency / serialization contract tests (pure).
 * External claim ledger is covered by DB uniqueness; here we assert the
 * machine never schedules parallel side effects for the same destination.
 */

function simulateConcurrentTriggers(
  publication: ReturnType<typeof emptyPublicationState>
) {
  const actions = [
    nextPublicationAction(publication),
    nextPublicationAction(publication),
    nextPublicationAction(publication),
  ];
  const types = actions.map((a) => a.type);
  assert.equal(new Set(types).size, 1, "all observers see the same next action");
  return actions[0];
}

{
  let state = emptyPublicationState();
  const first = simulateConcurrentTriggers(state);
  assert.equal(first.type, "request_approval");

  state = applyPublicationEvent(state, {
    type: "approval_decided",
    destination: "easybroker",
    approval: "approved",
  });
  const second = simulateConcurrentTriggers(state);
  assert.equal(second.type, "create_draft");

  // While draft_creating, machine must idle (lease held) — no second create.
  state = applyPublicationEvent(state, {
    type: "draft_started",
    destination: "easybroker",
    operation_key: "create_draft:easybroker:new",
  });
  const inFlight = simulateConcurrentTriggers(state);
  assert.equal(inFlight.type, "idle");
  assert.match(
    (inFlight as { reason: string }).reason,
    /draft_in_flight|waiting_easybroker/
  );

  state = applyPublicationEvent(state, {
    type: "draft_created",
    destination: "easybroker",
    artifact: { listing_id: "EB-1", remote_status: "not_published" },
  });
  const afterDraft = simulateConcurrentTriggers(state);
  assert.equal(afterDraft.type, "process_media");

  state = applyPublicationEvent(state, {
    type: "media_submitted",
    destination: "easybroker",
    expected_count: 1,
  });
  state = applyPublicationEvent(state, {
    type: "media_verified",
    destination: "easybroker",
    remote_count: 1,
  });
  state = applyPublicationEvent(state, {
    type: "preflight_result",
    destination: "easybroker",
    status: "pass",
  });
  assert.equal(nextPublicationAction(state).type, "publish");
  state = applyPublicationEvent(state, {
    type: "publish_started",
    destination: "easybroker",
    operation_key: "publish:easybroker:EB-1",
  });
  const publishing = simulateConcurrentTriggers(state);
  assert.equal(publishing.type, "idle");
  assert.match(
    (publishing as { reason: string }).reason,
    /publish_in_flight|waiting_easybroker/
  );
}

// unknown_outcome must request review, never create_draft again
{
  let state = emptyPublicationState();
  state = applyPublicationEvent(state, {
    type: "approval_decided",
    destination: "easybroker",
    approval: "approved",
  });
  state = applyPublicationEvent(state, {
    type: "draft_failed",
    destination: "easybroker",
    error: "timeout",
    unknown: true,
  });
  assert.equal(state.destinations.easybroker.phase, "unknown_outcome");
  assert.equal(nextPublicationAction(state).type, "request_review");
}

console.log("publication-concurrency.selftest: ok");
