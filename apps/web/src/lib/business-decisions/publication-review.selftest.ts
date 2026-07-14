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

console.log("publication-review.selftest: ok");
