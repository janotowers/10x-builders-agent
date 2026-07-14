import assert from "node:assert/strict";
import {
  canSafelyForceRetryProcessMedia,
  isCaseProcessingLeaseActive,
  isSafeProcessMediaNoSideEffectError,
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
  isSafeProcessMediaNoSideEffectError("EasyBroker respondió 422: invalid images"),
  false
);

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
  "any upload tool call means remote side effect may exist"
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

const now = Date.parse("2026-07-14T01:00:00.000Z");
assert.equal(isCaseProcessingLeaseActive(null, now), false);
assert.equal(isCaseProcessingLeaseActive("2026-07-14T00:59:00.000Z", now), false);
assert.equal(isCaseProcessingLeaseActive("2026-07-14T01:05:00.000Z", now), true);

console.log("publication-media-recovery.selftest: ok");
