import assert from "node:assert/strict";
import {
  isEasybrokerImagesUploadedInContext,
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
assert.equal(packageReadyNeedsUnggaApprovalNotify(baseContext), true);
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
  true
);
assert.equal(
  shouldDeterministicallyRequestUnggaApproval({
    context: {
      publish_approvals: { easybroker: "approved", ungga: "pending" },
      published: { easybroker: { listing_id: "EB-1" } },
      // sin fotos → no bloquea Ungga
    },
    pendingConfirmation: false,
    uploadedImagesThisTurn: false,
  }),
  true
);

console.log("package-ready-auto-continue.selftest: ok");
