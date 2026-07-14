import assert from "node:assert/strict";
import {
  isEasybrokerImagesUploadedInContext,
  isNestedPublicationRunnerTick,
  packageReadyBlocksUnggaApprovalNotify,
  packageReadyNeedsEasybrokerImageUpload,
  packageReadyNeedsUnggaApprovalNotify,
  shouldAutoFollowUpPackageReadyTick,
  shouldDeterministicallyRequestUnggaApproval,
} from "./package-ready-auto-continue";

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

console.log("package-ready-auto-continue.selftest: ok");
