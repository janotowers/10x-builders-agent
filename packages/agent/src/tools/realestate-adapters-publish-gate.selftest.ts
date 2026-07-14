import assert from "node:assert/strict";
import { evaluatePublishGateContext } from "./realestate-adapters";

const readyContext: Record<string, unknown> = {
  publication_mode: "active",
  package_ready_machine_work_in_flight: true,
  publication_runner_pending_action: {
    destination: "easybroker",
    type: "create_draft",
  },
  property_data: {
    property_type: "house",
    operation: "sale",
    currency: "MXN",
  },
  pricing_proposal: {
    approval_status: "approved",
    currency: "MXN",
  },
  contract_review: { status: "sent_by_email" },
  raw_photos: [{}, {}, {}, {}, {}],
  photo_analysis: { summary: "ok" },
  zone_context: { summary: "ok" },
  listing_description_approved: { description: "Texto aprobado" },
  publish_approvals: {
    easybroker: "approved",
    ungga: "pending",
  },
};

assert.deepEqual(
  evaluatePublishGateContext({
    context: { ...readyContext, publication_mode: "off" },
    destination: "easybroker",
    operationType: "create_draft",
  }),
  { ok: false, status: "publication_workflow_off" }
);
assert.deepEqual(
  evaluatePublishGateContext({
    context: { ...readyContext, publication_mode: "shadow" },
    destination: "easybroker",
    operationType: "create_draft",
  }),
  { ok: false, status: "publication_shadow_no_side_effects" }
);
assert.deepEqual(
  evaluatePublishGateContext({
    context: { ...readyContext, publication_workflow_v1: false },
    destination: "easybroker",
    operationType: "create_draft",
  }),
  { ok: false, status: "publication_workflow_off" }
);
assert.deepEqual(
  evaluatePublishGateContext({
    context: {
      ...readyContext,
      package_ready_machine_work_in_flight: false,
    },
    destination: "easybroker",
    operationType: "create_draft",
  }),
  { ok: false, status: "publication_runner_required" }
);
assert.deepEqual(
  evaluatePublishGateContext({
    context: readyContext,
    destination: "easybroker",
    operationType: "publish",
  }),
  { ok: false, status: "publication_runner_required" }
);

const wrongDestination = evaluatePublishGateContext({
  context: {
    ...readyContext,
    publication_runner_pending_action: {
      destination: "ungga",
      type: "create_draft",
    },
  },
  destination: "ungga",
  operationType: "create_draft",
});
assert.equal(wrongDestination.ok, false);
assert.equal(
  wrongDestination.ok ? null : wrongDestination.status,
  "publish_gate_blocked"
);
assert.ok(
  !wrongDestination.ok &&
    wrongDestination.missing?.includes("publish_approvals.ungga=approved")
);

assert.deepEqual(
  evaluatePublishGateContext({
    context: readyContext,
    destination: "easybroker",
    operationType: "create_draft",
  }),
  { ok: true }
);

console.log("realestate-adapters-publish-gate.selftest: ok");
