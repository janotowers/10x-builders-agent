import assert from "node:assert/strict";
import {
  isEasybrokerImagesUploadedInContext,
  isNestedPublicationRunnerTick,
  packageReadyBlocksUnggaApprovalNotify,
  packageReadyNeedsEasybrokerImageUpload,
  packageReadyNeedsUnggaApprovalNotify,
  shouldAutoFollowUpPackageReadyTick,
  shouldDeterministicallyRequestUnggaApproval,
  shouldLabObserverWakePublicationRunner,
} from "./package-ready-auto-continue";
import {
  applyPublicationEvent,
  emptyPublicationState,
} from "./publication-workflow";

const baseContext = {
  publish_approvals: { easybroker: "approved", ungga: "pending" },
  published: {
    easybroker: {
      listing_id: "EB-WL4498",
      status: "created",
    },
  },
  raw_photos: ["case-documents:a.jpg", "case-documents:b.jpg"],
};

assert.equal(packageReadyNeedsEasybrokerImageUpload(baseContext), true);
assert.equal(
  packageReadyNeedsEasybrokerImageUpload({
    ...baseContext,
    published: {
      easybroker: {
        listing_id: "EB-WL4498",
        images_uploaded: true,
        image_count: 5,
      },
    },
  }),
  false
);
assert.equal(
  packageReadyNeedsEasybrokerImageUpload({
    ...baseContext,
    published: {
      easybroker: {
        listing_id: "EB-WL4498",
        images_status: "failed",
        images_error: "url too long",
      },
    },
  }),
  false,
  "failed upload must stop auto-retry"
);
assert.equal(isEasybrokerImagesUploadedInContext(baseContext), false);
assert.equal(
  packageReadyNeedsUnggaApprovalNotify(baseContext),
  false,
  "draft EasyBroker must not unlock Ungga notify"
);
assert.equal(packageReadyBlocksUnggaApprovalNotify(baseContext), true);

assert.equal(
  shouldAutoFollowUpPackageReadyTick({
    context: baseContext,
    pendingConfirmation: false,
    uploadedImagesThisTurn: false,
    autoFollowUpDepth: 0,
  }),
  true
);
assert.equal(
  shouldAutoFollowUpPackageReadyTick({
    context: baseContext,
    pendingConfirmation: false,
    uploadedImagesThisTurn: false,
    uploadFailedThisTurn: true,
    autoFollowUpDepth: 0,
  }),
  false,
  "failed upload this turn must not chain"
);
assert.equal(
  shouldAutoFollowUpPackageReadyTick({
    context: baseContext,
    pendingConfirmation: false,
    uploadedImagesThisTurn: true,
    autoFollowUpDepth: 0,
  }),
  false
);
assert.equal(isNestedPublicationRunnerTick("publication_runner:create_draft"), true);
assert.equal(
  isNestedPublicationRunnerTick("package_ready_auto_follow_up:process_media"),
  true
);
assert.equal(
  isNestedPublicationRunnerTick("package_ready_lab_auto_continue:process_media"),
  true
);
assert.equal(isNestedPublicationRunnerTick("publish_destination_easybroker_approved"), false);
// Structural ownership: approval/review/cron sources without legacy prefix.
assert.equal(
  isNestedPublicationRunnerTick("publish_destination_ungga_approved:publish", {
    publicationRunnerOwned: true,
  }),
  true
);
assert.equal(
  isNestedPublicationRunnerTick("cron_publication:publish", {
    publicationRunnerOwned: true,
  }),
  true
);
assert.equal(
  shouldAutoFollowUpPackageReadyTick({
    context: baseContext,
    pendingConfirmation: false,
    uploadedImagesThisTurn: false,
    autoFollowUpDepth: 0,
    source: "publish_destination_ungga_approved:publish",
    publicationRunnerOwned: true,
  }),
  false
);
assert.equal(
  shouldAutoFollowUpPackageReadyTick({
    context: baseContext,
    pendingConfirmation: false,
    uploadedImagesThisTurn: false,
    autoFollowUpDepth: 0,
    source: "publication_runner:create_draft",
  }),
  false,
  "nested runner ticks must not schedule a second fire-and-forget runner"
);
assert.equal(
  shouldAutoFollowUpPackageReadyTick({
    context: baseContext,
    pendingConfirmation: false,
    uploadedImagesThisTurn: false,
    autoFollowUpDepth: 0,
    source: "publish_destination_easybroker_approved:create_draft",
  }),
  true,
  "outer destination-approval ticks may still schedule follow-up when needed"
);
assert.equal(
  shouldDeterministicallyRequestUnggaApproval({
    context: baseContext,
    pendingConfirmation: false,
    uploadedImagesThisTurn: false,
  }),
  false,
  "no pedir Ungga mientras falten fotos"
);
assert.equal(
  shouldDeterministicallyRequestUnggaApproval({
    context: {
      ...baseContext,
      published: {
        easybroker: {
          listing_id: "EB-WL4498",
          images_status: "failed",
        },
      },
    },
    pendingConfirmation: false,
    uploadedImagesThisTurn: false,
  }),
  false,
  "no pedir Ungga si el upload falló"
);
assert.equal(
  shouldDeterministicallyRequestUnggaApproval({
    context: {
      ...baseContext,
      published: {
        easybroker: {
          listing_id: "EB-WL4498",
          images_uploaded: true,
        },
      },
    },
    pendingConfirmation: false,
    uploadedImagesThisTurn: false,
  }),
  false,
  "draft + images uploaded is not enough for Ungga"
);
assert.equal(
  shouldDeterministicallyRequestUnggaApproval({
    context: {
      ...baseContext,
      published: {
        easybroker: {
          listing_id: "EB-WL4498",
          images_uploaded: true,
          status: "published",
        },
      },
    },
    pendingConfirmation: false,
    uploadedImagesThisTurn: false,
  }),
  true,
  "publicly published EasyBroker may request Ungga"
);
assert.equal(
  shouldDeterministicallyRequestUnggaApproval({
    context: {
      publish_approvals: { easybroker: "approved", ungga: "pending" },
      published: { easybroker: { listing_id: "EB-1" } },
      // sin fotos → no bloquea por fotos, pero sí por draft-only
    },
    pendingConfirmation: false,
    uploadedImagesThisTurn: false,
  }),
  false,
  "listing_id alone without public publish must not request Ungga"
);
assert.equal(
  shouldDeterministicallyRequestUnggaApproval({
    context: {
      publish_approvals: { easybroker: "skipped", ungga: "pending" },
    },
    pendingConfirmation: false,
    uploadedImagesThisTurn: false,
  }),
  true,
  "skipped EasyBroker may request Ungga"
);

const approvedListingContext = {
  listing_description_approved: {
    description: "Casa lista para publicar.",
    headline: "Casa en Zapopan",
  },
  publication_workflow_v1: true,
  publication: {
    mode: "active",
    version: 1,
    feature_enabled: true,
    destinations: {
      easybroker: {
        approval: "approved",
        phase: "media_processing",
        media: {
          required: true,
          submitted: true,
          verified: false,
          expected_count: 6,
          remote_count: 0,
          last_checked_at: null,
        },
        artifact: { listing_id: "EB-WL9056" },
        preflight: null,
        last_error: null,
        updated_at: null,
        operation_key: null,
        review_reason: null,
      },
      ungga: {
        approval: "pending",
        phase: "awaiting_approval",
        media: {
          required: true,
          submitted: false,
          verified: false,
          expected_count: 6,
          remote_count: null,
          last_checked_at: null,
        },
        artifact: {},
        preflight: null,
        last_error: null,
        updated_at: null,
        operation_key: null,
        review_reason: null,
      },
    },
  },
  publish_approvals: { easybroker: "approved", ungga: "pending" },
  published: {
    easybroker: {
      listing_id: "EB-WL9056",
      images_uploaded: true,
      images_status: "submitted",
      image_count: 0,
      status: "created",
    },
  },
};

const now = Date.parse("2026-07-14T14:30:00.000Z");
assert.equal(
  shouldLabObserverWakePublicationRunner({
    context: approvedListingContext,
    currentStep: "package_ready",
    nextActionAt: null,
    blockingActionsCount: 0,
    nowMs: now,
  }),
  true,
  "submitted but unverified media must wake wait_remote_media"
);
assert.equal(
  packageReadyNeedsEasybrokerImageUpload(approvedListingContext),
  false,
  "legacy upload predicate must stay false after images_status=submitted"
);
assert.equal(
  shouldLabObserverWakePublicationRunner({
    context: approvedListingContext,
    currentStep: "package_ready",
    nextActionAt: "2026-07-14T14:31:00.000Z",
    blockingActionsCount: 0,
    nowMs: now,
  }),
  false,
  "future resume/lease must not wake yet"
);
assert.equal(
  shouldLabObserverWakePublicationRunner({
    context: approvedListingContext,
    currentStep: "package_ready",
    nextActionAt: "2026-07-14T14:29:00.000Z",
    blockingActionsCount: 0,
    nowMs: now,
  }),
  true,
  "past resume timestamp must wake"
);
assert.equal(
  shouldLabObserverWakePublicationRunner({
    context: approvedListingContext,
    currentStep: "package_ready",
    nextActionAt: null,
    blockingActionsCount: 1,
    nowMs: now,
  }),
  false,
  "blocking HITL must not wake"
);
assert.equal(
  shouldLabObserverWakePublicationRunner({
    context: {
      ...approvedListingContext,
      package_ready_machine_work_in_flight: true,
    },
    currentStep: "package_ready",
    nextActionAt: null,
    blockingActionsCount: 0,
    nowMs: now,
  }),
  false,
  "in-flight machine work must not wake"
);

let verifiedState = applyPublicationEvent(emptyPublicationState(), {
  type: "approval_decided",
  destination: "easybroker",
  approval: "approved",
});
verifiedState = applyPublicationEvent(verifiedState, {
  type: "draft_created",
  destination: "easybroker",
  artifact: { listing_id: "EB-1" },
});
verifiedState = applyPublicationEvent(verifiedState, {
  type: "media_submitted",
  destination: "easybroker",
  expected_count: 6,
});
verifiedState = applyPublicationEvent(verifiedState, {
  type: "media_verified",
  destination: "easybroker",
  remote_count: 6,
});
assert.equal(
  shouldLabObserverWakePublicationRunner({
    context: {
      listing_description_approved: {
        description: "Casa lista para publicar.",
      },
      publication_workflow_v1: true,
      publication: { ...verifiedState, mode: "active", feature_enabled: true },
      publish_approvals: { easybroker: "approved", ungga: "pending" },
    },
    currentStep: "package_ready",
    nextActionAt: null,
    blockingActionsCount: 0,
    nowMs: now,
  }),
  true,
  "media_verified must wake validate"
);

console.log("package-ready-auto-continue.selftest: ok");
