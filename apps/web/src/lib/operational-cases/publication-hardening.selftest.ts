import assert from "node:assert/strict";
import { compareEasyBrokerSnapshot } from "./publication-remote-snapshot";
import { resolvePublicationRolloutMode } from "./publication-rollout";
import { classifyPublicationExecutionFromToolCalls } from "./run-settings-test-case-tick";
import type { PublicationMachineAction } from "./publication-workflow";

assert.equal(resolvePublicationRolloutMode({}), "off");
assert.equal(
  resolvePublicationRolloutMode(
    { publication_mode: "shadow" },
    { publication_mode: "active" }
  ),
  "shadow"
);
assert.equal(
  resolvePublicationRolloutMode({}, { publication: { mode: "active" } }),
  "active"
);

const mismatches = compareEasyBrokerSnapshot({
  snapshot: {
    listing_id: "EB-WL4498",
    public_id: "EB-WL4498",
    internal_id: "legacy-case",
    status: "not_published",
    title: "Casa correcta",
    description: "Descripción aprobada",
    image_count: 5,
    image_titles: ["Fachada", "Sala", "Cocina", "Recámara", "Baño"],
    fields: {},
    raw: {},
  },
  expectedInternalId: "legacy-case",
  expectedImageCount: 5,
  expectedImageTitles: ["Fachada", "Sala", "Cocina", "Recámara", "Baño"],
  expectedFields: {
    title: "Casa correcta",
    description: "Descripción aprobada",
  },
});
assert.deepEqual(mismatches, []);

const prepareUngga = {
  type: "create_draft",
  destination: "ungga",
} as PublicationMachineAction;
assert.equal(
  classifyPublicationExecutionFromToolCalls(prepareUngga, [
    {
      tool_name: "ungga_publish_listing",
      status: "failed",
      result_json: { error: "process killed after timeout" },
    },
  ]).status,
  "unknown_outcome"
);
assert.equal(
  classifyPublicationExecutionFromToolCalls(prepareUngga, []).status,
  "not_executed"
);
assert.equal(
  classifyPublicationExecutionFromToolCalls(prepareUngga, [
    {
      tool_name: "ungga_publish_listing",
      status: "executed",
      result_json: {
        ok: true,
        status: "draft_created",
        ungga_property_id: "GU-1",
      },
    },
  ]).status,
  "succeeded"
);

const publishEasyBroker = {
  type: "publish",
  destination: "easybroker",
} as PublicationMachineAction;
assert.equal(
  classifyPublicationExecutionFromToolCalls(publishEasyBroker, [
    {
      tool_name: "easybroker_publish_listing",
      status: "pending_confirmation",
      result_json: {},
    },
  ]).status,
  "pending_hitl"
);

console.log("publication-hardening.selftest: ok");
