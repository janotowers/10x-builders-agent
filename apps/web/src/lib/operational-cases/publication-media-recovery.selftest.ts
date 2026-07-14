import assert from "node:assert/strict";
import {
  canSafelyForceRetryProcessMedia,
  canSafelyForceRetryUnggaPublish,
  isCaseProcessingLeaseActive,
  isPublicationResumeDue,
  isSafeProcessMediaNoSideEffectError,
  isWatermarkPreconditionUploadError,
} from "./publication-media-recovery";

assert.equal(
  isSafeProcessMediaNoSideEffectError("publication_execution_result_missing"),
  true
);
assert.equal(
  isSafeProcessMediaNoSideEffectError("easybroker_upload_images_not_called"),
  true
);
assert.equal(
  isSafeProcessMediaNoSideEffectError("publication_pending_action_persist_failed"),
  true
);
assert.equal(
  isSafeProcessMediaNoSideEffectError("watermark_persist_failed"),
  true
);
assert.equal(
  isSafeProcessMediaNoSideEffectError(
    "Watermark requerido pero faltan 6 fotos: case-documents:a.jpg"
  ),
  true
);
assert.equal(
  isSafeProcessMediaNoSideEffectError("EasyBroker respondió 422: invalid images"),
  false
);

assert.equal(
  isWatermarkPreconditionUploadError("watermark_apply_failed"),
  true
);
assert.equal(
  isWatermarkPreconditionUploadError("Watermark requerido pero faltan 2 fotos: x"),
  true
);
assert.equal(isWatermarkPreconditionUploadError("timeout"), false);

assert.equal(
  canSafelyForceRetryProcessMedia({
    operation: {
      status: "failed",
      operation_type: "process_media",
      error_text: "publication_execution_result_missing",
    },
    uploadToolCalls: [],
  }),
  true
);
assert.equal(
  canSafelyForceRetryProcessMedia({
    operation: {
      status: "failed",
      operation_type: "process_media",
      error_text: "publication_execution_result_missing",
    },
    uploadToolCalls: [{ tool_name: "easybroker_upload_images", status: "failed" }],
  }),
  false,
  "upload without side_effect_started=false must not force-retry"
);
assert.equal(
  canSafelyForceRetryProcessMedia({
    operation: {
      status: "failed",
      operation_type: "process_media",
      error_text: "Watermark requerido pero faltan 6 fotos: a.jpg",
    },
    uploadToolCalls: [
      {
        tool_name: "easybroker_upload_images",
        status: "failed",
        result_json: {
          ok: false,
          status: "watermark_apply_failed",
          side_effect_started: false,
          error: "Watermark requerido pero faltan 6 fotos: a.jpg",
        },
      },
    ],
  }),
  true,
  "watermark gate before EasyBroker is safe to force-retry"
);
assert.equal(
  canSafelyForceRetryProcessMedia({
    operation: {
      status: "failed",
      operation_type: "process_media",
      error_text: "EasyBroker 422",
    },
    uploadToolCalls: [
      {
        tool_name: "easybroker_upload_images",
        status: "failed",
        result_json: {
          ok: false,
          side_effect_started: true,
          error: "EasyBroker 422",
        },
      },
    ],
  }),
  false,
  "remote side effect started is not safe"
);
assert.equal(
  canSafelyForceRetryProcessMedia({
    operation: {
      status: "failed",
      operation_type: "create_draft",
      error_text: "publication_execution_result_missing",
    },
    uploadToolCalls: [],
  }),
  false
);
assert.equal(
  canSafelyForceRetryProcessMedia({
    operation: {
      status: "succeeded",
      operation_type: "process_media",
      error_text: null,
    },
    uploadToolCalls: [],
  }),
  false
);

assert.equal(
  canSafelyForceRetryUnggaPublish({
    operation: {
      status: "failed",
      operation_type: "publish",
      error_text: "ungga_publish_listing_not_called",
    },
  }),
  true
);
assert.equal(
  canSafelyForceRetryUnggaPublish({
    operation: {
      status: "failed",
      operation_type: "publish",
      error_text: "publication_execution_result_missing",
    },
  }),
  true
);
assert.equal(
  canSafelyForceRetryUnggaPublish({
    operation: {
      status: "failed",
      operation_type: "publish",
      error_text: "timeout after publish click",
    },
    publishToolCalls: [
      {
        tool_name: "ungga_publish_listing",
        result_json: { side_effect_started: true, ok: false },
      },
    ],
  }),
  false
);

const now = Date.parse("2026-07-14T01:00:00.000Z");
assert.equal(isCaseProcessingLeaseActive(null, now), false);
assert.equal(isCaseProcessingLeaseActive("2026-07-14T00:59:00.000Z", now), false);
assert.equal(isCaseProcessingLeaseActive("2026-07-14T01:05:00.000Z", now), true);
assert.equal(isPublicationResumeDue(null, now), true);
assert.equal(isPublicationResumeDue("2026-07-14T00:59:00.000Z", now), true);
assert.equal(isPublicationResumeDue("2026-07-14T01:05:00.000Z", now), false);

console.log("publication-media-recovery.selftest: ok");
