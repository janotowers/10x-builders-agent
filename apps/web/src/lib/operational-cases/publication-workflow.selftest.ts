import assert from "node:assert/strict";
import {
  applyPublicationEvent,
  containsProtectedPublicationKeys,
  emptyPublicationState,
  isEasybrokerDraftCreated,
  isEasybrokerEffectivelyPublished,
  migrateLegacyPublicationState,
  nextPublicationAction,
  publicationFromContext,
  projectLegacyPublicationFields,
} from "./publication-workflow";

const empty = emptyPublicationState();
assert.equal(nextPublicationAction(empty).type, "request_approval");
assert.equal(
  (nextPublicationAction(empty) as { destination: string }).destination,
  "easybroker"
);

const afterEbApproval = applyPublicationEvent(empty, {
  type: "approval_decided",
  destination: "easybroker",
  approval: "approved",
});
assert.equal(nextPublicationAction(afterEbApproval).type, "create_draft");

const afterDraft = applyPublicationEvent(afterEbApproval, {
  type: "draft_created",
  destination: "easybroker",
  artifact: { listing_id: "EB-1", remote_status: "not_published" },
});
assert.equal(afterDraft.destinations.easybroker.phase, "media_pending");
assert.equal(nextPublicationAction(afterDraft).type, "process_media");
assert.equal(isEasybrokerDraftCreated(afterDraft), true);
assert.equal(isEasybrokerEffectivelyPublished(afterDraft), false);

let state = applyPublicationEvent(afterDraft, {
  type: "media_submitted",
  destination: "easybroker",
  expected_count: 5,
});
assert.equal(nextPublicationAction(state).type, "wait_remote_media");

state = applyPublicationEvent(state, {
  type: "media_verified",
  destination: "easybroker",
  remote_count: 5,
});
assert.equal(nextPublicationAction(state).type, "validate");

state = applyPublicationEvent(state, {
  type: "preflight_result",
  destination: "easybroker",
  status: "pass",
});
assert.equal(nextPublicationAction(state).type, "publish");

state = applyPublicationEvent(state, {
  type: "publish_succeeded",
  destination: "easybroker",
  artifact: { published_url: "https://example.com/eb" },
});
assert.equal(isEasybrokerEffectivelyPublished(state), true);
assert.equal(nextPublicationAction(state).type, "request_approval");
assert.equal(
  (nextPublicationAction(state) as { destination: string }).destination,
  "ungga"
);

// Review path
let review = applyPublicationEvent(afterDraft, {
  type: "media_verified",
  destination: "easybroker",
  remote_count: 5,
});
review = applyPublicationEvent(review, {
  type: "preflight_result",
  destination: "easybroker",
  status: "review_required",
  reason: "low_confidence_labels",
});
assert.equal(nextPublicationAction(review).type, "request_review");
review = applyPublicationEvent(review, {
  type: "review_resolved",
  destination: "easybroker",
});
assert.equal(nextPublicationAction(review).type, "validate");

// Legacy migration
const legacy = migrateLegacyPublicationState({
  publish_approvals: { easybroker: "approved", ungga: "pending" },
  published: {
    easybroker: {
      listing_id: "EB-WL4498",
      status: "created",
      images_uploaded: true,
      image_count: 5,
    },
  },
  raw_photos: ["a", "b", "c", "d", "e"],
});
assert.equal(legacy.destinations.easybroker.approval, "approved");
assert.equal(legacy.destinations.easybroker.phase, "validating");
assert.equal(legacy.destinations.easybroker.media.submitted, true);
assert.equal(isEasybrokerEffectivelyPublished(legacy), false);

const projected = projectLegacyPublicationFields(state);
assert.equal(projected.publish_approvals.easybroker, "approved");
assert.equal(projected.published.easybroker.status, "published");

const fromContext = publicationFromContext({
  publication: state,
  publish_approvals: { easybroker: "approved" },
});
assert.equal(fromContext.destinations.easybroker.phase, "published");

assert.deepEqual(
  containsProtectedPublicationKeys({
    publication: {},
    title: "ok",
    published: {},
  }),
  ["publication", "published"]
);

// Unknown outcome never auto-retries create
const unknown = applyPublicationEvent(afterEbApproval, {
  type: "draft_failed",
  destination: "easybroker",
  error: "timeout",
  unknown: true,
});
assert.equal(unknown.destinations.easybroker.phase, "unknown_outcome");
assert.equal(nextPublicationAction(unknown).type, "request_review");

console.log("publication-workflow.selftest: ok");
