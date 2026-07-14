import assert from "node:assert/strict";
import {
  compareEasyBrokerSnapshot,
  easyBrokerSnapshot,
} from "./publication-remote-snapshot";
import { resolvePublicationRolloutMode } from "./publication-rollout";
import { buildPublicationPersistenceContext, applyProcessMediaPublicationEvents } from "./publication-runner";
import { classifyPublicationExecutionFromToolCalls } from "./run-settings-test-case-tick";
import {
  applyPublicationEvent,
  emptyPublicationState,
  nextPublicationAction,
  type PublicationMachineAction,
} from "./publication-workflow";

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
assert.equal(
  easyBrokerSnapshot({
    public_id: "EB-WL7415",
    published_at: "2026-07-13T12:47:26-06:00",
  }).status,
  "published",
  "EasyBroker GET omits status; published_at is the canonical publish signal"
);
assert.equal(
  buildPublicationPersistenceContext({}, emptyPublicationState(), {
    package_ready_machine_work_in_flight: true,
    publication_runner_pending_action: {
      type: "create_draft",
      destination: "easybroker",
    },
  }).package_ready_machine_work_in_flight,
  true,
  "runner ownership must not be overwritten by the default false value"
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
assert.deepEqual(
  compareEasyBrokerSnapshot({
    snapshot: {
      listing_id: "EB-WL7415",
      public_id: "EB-WL7415",
      internal_id: "51C782CA40C7492",
      status: "not_published",
      title: null,
      description: null,
      image_count: 6,
      image_titles: [],
      fields: {},
      raw: {},
    },
    expectedInternalId: "51c782ca-40c7-492c-9b23-8a903f05b9fa",
  }),
  [],
  "remote verification must compare EasyBroker's canonical 15-char internal_id"
);
assert.deepEqual(
  compareEasyBrokerSnapshot({
    snapshot: {
      listing_id: "EB-WL7415",
      public_id: "EB-WL7415",
      internal_id: null,
      status: "not_published",
      title:
        "Casa en venta en Fraccionamiento Las Fuentes, Zapopan con diseño contemporáneo",
      description: null,
      image_count: 0,
      image_titles: [],
      fields: {},
      raw: {},
    },
    expectedFields: {
      title:
        "Casa en venta en Fraccionamiento Las Fuentes, Zapopan con diseño contemporáneo y detalles tradicionales",
    },
  }),
  [],
  "remote verification must compare the canonical 80-char EasyBroker title"
);

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
  classifyPublicationExecutionFromToolCalls(prepareUngga, [
    {
      tool_name: "ungga_publish_listing",
      status: "failed",
      result_json: { status: "unknown_outcome", error: "CLI ended abruptly" },
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
        expected_image_count: 6,
        uploaded_image_count: 6,
        images_verified: true,
      },
    },
  ]).status,
  "succeeded"
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
        expected_image_count: 6,
        uploaded_image_count: 2,
      },
    },
  ]).status,
  "failed"
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

const processMedia = {
  type: "process_media",
  destination: "easybroker",
} as PublicationMachineAction;
assert.equal(
  classifyPublicationExecutionFromToolCalls(processMedia, []).error,
  "easybroker_upload_images_not_called"
);
assert.equal(
  buildPublicationPersistenceContext(
    {},
    emptyPublicationState(),
    {
      package_ready_machine_work_in_flight: true,
      publication_runner_pending_action: processMedia,
    }
  ).publication_runner_pending_action,
  processMedia,
  "pending process_media gate must persist before tool execution"
);

let mediaState = applyPublicationEvent(emptyPublicationState(), {
  type: "approval_decided",
  destination: "easybroker",
  approval: "approved",
});
mediaState = applyPublicationEvent(mediaState, {
  type: "draft_created",
  destination: "easybroker",
  artifact: { listing_id: "EB-1" },
});
const submittedOnly = applyProcessMediaPublicationEvents(mediaState, "easybroker", {
  count: 6,
  remote_count: 0,
  images_status: "submitted",
});
assert.equal(submittedOnly.destinations.easybroker.media.submitted, true);
assert.equal(submittedOnly.destinations.easybroker.media.verified, false);
assert.equal(nextPublicationAction(submittedOnly).type, "wait_remote_media");

const verifiedInline = applyProcessMediaPublicationEvents(mediaState, "easybroker", {
  count: 6,
  remote_count: 6,
  images_status: "verified",
});
assert.equal(verifiedInline.destinations.easybroker.media.verified, true);
assert.equal(nextPublicationAction(verifiedInline).type, "validate");

console.log("publication-hardening.selftest: ok");
