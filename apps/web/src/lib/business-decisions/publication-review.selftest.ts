import assert from "node:assert/strict";
import {
  shouldForceRetryPublicationCreateAfterReview,
  publicationReviewContinueGuidance,
} from "./publication-review";
import {
  applyPublicationEvent,
  emptyPublicationState,
} from "@/lib/operational-cases/publication-workflow";

{
  let publication = emptyPublicationState();
  publication = applyPublicationEvent(publication, {
    type: "approval_decided",
    destination: "ungga",
    approval: "approved",
  });
  publication = applyPublicationEvent(publication, {
    type: "draft_failed",
    destination: "ungga",
    error: "timeout",
    unknown: true,
  });
  assert.equal(publication.destinations.ungga.phase, "unknown_outcome");
  assert.equal(
    shouldForceRetryPublicationCreateAfterReview({
      destination: "ungga",
      publication,
    }),
    true,
    "human can force-retry create when unknown_outcome has no artifact"
  );
  assert.match(
    publicationReviewContinueGuidance({
      destination: "ungga",
      publication,
      forceRetry: true,
    }),
    /Reintento de create/
  );
}

{
  // Cron request_review may remap unknown_outcome → review_required; human
  // "Reintentar" must still force-retry create when there is no GU-ID.
  let publication = emptyPublicationState();
  publication = applyPublicationEvent(publication, {
    type: "approval_decided",
    destination: "ungga",
    approval: "approved",
  });
  publication = applyPublicationEvent(publication, {
    type: "draft_failed",
    destination: "ungga",
    error: "page.waitForURL: Timeout",
    unknown: true,
  });
  publication = applyPublicationEvent(publication, {
    type: "preflight_result",
    destination: "ungga",
    status: "review_required",
    reason: "ungga_prepare_draft_failed",
  });
  assert.equal(publication.destinations.ungga.phase, "review_required");
  assert.equal(
    shouldForceRetryPublicationCreateAfterReview({
      destination: "ungga",
      publication,
    }),
    true,
    "review_required without artifact still force-retries create"
  );
}

{
  let publication = emptyPublicationState();
  publication = applyPublicationEvent(publication, {
    type: "approval_decided",
    destination: "ungga",
    approval: "approved",
  });
  publication = applyPublicationEvent(publication, {
    type: "draft_created",
    destination: "ungga",
    artifact: { ungga_property_id: "GU-1" },
  });
  publication = applyPublicationEvent(publication, {
    type: "publish_failed",
    destination: "ungga",
    error: "timeout",
    unknown: true,
  });
  assert.equal(
    shouldForceRetryPublicationCreateAfterReview({
      destination: "ungga",
      publication,
    }),
    false,
    "must not treat unknown_outcome with an existing artifact as create retry"
  );
  assert.match(
    publicationReviewContinueGuidance({
      destination: "ungga",
      publication,
      forceRetry: false,
    }),
    /GU-1|no se recreará/i
  );
}

{
  let publication = emptyPublicationState();
  publication = applyPublicationEvent(publication, {
    type: "approval_decided",
    destination: "ungga",
    approval: "approved",
  });
  publication = applyPublicationEvent(publication, {
    type: "draft_created",
    destination: "ungga",
    artifact: { ungga_property_id: "GU-CLI" },
  });
  publication = applyPublicationEvent(publication, {
    type: "publish_failed",
    destination: "ungga",
    error: "ungga_publish_listing_not_called",
  });
  assert.equal(
    shouldForceRetryPublicationCreateAfterReview({
      destination: "ungga",
      publication,
      lastError: "ungga_publish_listing_not_called",
    }),
    true,
    "pre-side-effect publish failure may force-retry publish on existing CLI draft"
  );
  assert.match(
    publicationReviewContinueGuidance({
      destination: "ungga",
      publication,
      forceRetry: true,
    }),
    /Reintento de publish|GU-CLI/
  );
}

console.log("publication-review.selftest: ok");
