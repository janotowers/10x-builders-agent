import assert from "node:assert/strict";
import {
  applyPublicationEvent,
  emptyPublicationState,
  nextPublicationAction,
  reconcilePublicationWithArtifacts,
} from "./publication-workflow";
import { rebuildPublicationStateFromCaseContext } from "./publication-reconcile";

// Stuck draft_creating + legacy published listing → media_pending
{
  let state = emptyPublicationState();
  state = applyPublicationEvent(state, {
    type: "approval_decided",
    destination: "easybroker",
    approval: "approved",
  });
  state = applyPublicationEvent(state, {
    type: "draft_started",
    destination: "easybroker",
    operation_key: "create_draft:easybroker:new",
  });
  assert.equal(state.destinations.easybroker.phase, "draft_creating");
  assert.equal(nextPublicationAction(state).type, "idle");

  const reconciled = reconcilePublicationWithArtifacts(state, {
    publish_approvals: { easybroker: "approved" },
    published: {
      easybroker: {
        listing_id: "EB-WL4498",
        status: "not_published",
      },
    },
    raw_photos: ["a.jpg", "b.jpg"],
  });
  assert.equal(reconciled.destinations.easybroker.phase, "media_pending");
  assert.equal(reconciled.destinations.easybroker.artifact.listing_id, "EB-WL4498");
  assert.equal(nextPublicationAction(reconciled).type, "process_media");
}

// Images uploaded advance to wait/verify path
{
  let state = emptyPublicationState();
  state = applyPublicationEvent(state, {
    type: "approval_decided",
    destination: "easybroker",
    approval: "approved",
  });
  state = applyPublicationEvent(state, {
    type: "draft_started",
    destination: "easybroker",
    operation_key: "op",
  });
  const reconciled = reconcilePublicationWithArtifacts(state, {
    publish_approvals: { easybroker: "approved" },
    published: {
      easybroker: {
        listing_id: "EB-1",
        status: "not_published",
        images_uploaded: true,
        images_status: "submitted",
        image_count: 5,
      },
    },
    raw_photos: [1, 2, 3, 4, 5],
  });
  assert.equal(reconciled.destinations.easybroker.media.submitted, true);
  assert.equal(reconciled.destinations.easybroker.phase, "media_processing");
  assert.equal(nextPublicationAction(reconciled).type, "wait_remote_media");
}

// Legacy recovery: preserve EB listing and never auto-retry Ungga without GU-ID.
{
  const { publication, changes } = rebuildPublicationStateFromCaseContext(
    {
      publish_approvals: { easybroker: "approved", ungga: "approved" },
      published: {
        easybroker: {
          listing_id: "EB-WL4498",
          status: "not_published",
          images_uploaded: true,
          image_count: 5,
          images_status: "submitted",
        },
      },
      raw_photos: ["1", "2", "3", "4", "5"],
      publication: {
        version: 1,
        feature_enabled: true,
        destinations: {
          easybroker: {
            approval: "approved",
            phase: "unknown_outcome",
            artifact: {},
            media: {
              required: true,
              submitted: false,
              verified: false,
              expected_count: 0,
              remote_count: null,
            },
            preflight: null,
            last_error: "stale",
            operation_key: null,
            review_reason: null,
            updated_at: null,
          },
          ungga: {
            approval: "approved",
            phase: "failed",
            artifact: {},
            media: {
              required: true,
              submitted: false,
              verified: false,
              expected_count: 0,
              remote_count: null,
            },
            preflight: null,
            last_error: "cli_failed",
            operation_key: null,
            review_reason: null,
            updated_at: null,
          },
        },
      },
    }
  );
  assert.equal(publication.destinations.easybroker.artifact.listing_id, "EB-WL4498");
  assert.equal(publication.destinations.ungga.phase, "failed");
  assert.ok(!changes.includes("ungga_reset_to_draft_pending"));
}

console.log("publication-reconcile.selftest: ok");
