/**
 * Safe recovery predicates for EasyBroker process_media when the ledger failed
 * before any remote image side effect.
 */

const SAFE_PROCESS_MEDIA_NO_SIDE_EFFECT_ERRORS = new Set([
  "publication_execution_result_missing",
  "expected_publication_tool_not_executed",
  "publication_pending_action_persist_failed",
  "publication_executor_missing",
  "no_tool_for_action",
]);

export type ProcessMediaRecoveryOperation = {
  status: string;
  operation_type: string;
  error_text?: string | null;
};

export type ProcessMediaRecoveryToolCall = {
  tool_name: string;
  status?: string | null;
};

export function isSafeProcessMediaNoSideEffectError(
  errorText: string | null | undefined
): boolean {
  const error = typeof errorText === "string" ? errorText.trim() : "";
  if (!error) return false;
  if (SAFE_PROCESS_MEDIA_NO_SIDE_EFFECT_ERRORS.has(error)) return true;
  if (error.endsWith("_not_called")) return true;
  return error.includes("easybroker_upload_images_not_called");
}

/**
 * True only when process_media failed without ever calling
 * easybroker_upload_images — safe to forceRetry the ledger row.
 */
export function canSafelyForceRetryProcessMedia(params: {
  operation: ProcessMediaRecoveryOperation;
  uploadToolCalls: ProcessMediaRecoveryToolCall[];
}): boolean {
  if (params.operation.operation_type !== "process_media") return false;
  if (params.operation.status !== "failed") return false;
  if (!isSafeProcessMediaNoSideEffectError(params.operation.error_text)) {
    return false;
  }
  const hasUploadAttempt = params.uploadToolCalls.some(
    (row) => row.tool_name === "easybroker_upload_images"
  );
  return !hasUploadAttempt;
}

/**
 * True when next_action_at is a future lease held by markCaseProcessing /
 * an in-flight runner (not a due-now schedule).
 */
export function isCaseProcessingLeaseActive(
  nextActionAt: string | null | undefined,
  nowMs: number = Date.now()
): boolean {
  if (typeof nextActionAt !== "string" || !nextActionAt.trim()) return false;
  const leaseMs = Date.parse(nextActionAt);
  if (!Number.isFinite(leaseMs)) return false;
  return leaseMs > nowMs;
}
