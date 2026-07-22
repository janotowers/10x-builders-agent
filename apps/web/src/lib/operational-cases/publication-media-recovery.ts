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
  "watermark_precondition_missing",
  "watermark_persist_failed",
  "watermark_apply_failed",
  "raw_photos_missing",
  "case_not_found",
  "case_id_required",
]);

export type ProcessMediaRecoveryOperation = {
  status: string;
  operation_type: string;
  error_text?: string | null;
};

export type ProcessMediaRecoveryToolCall = {
  tool_name: string;
  status?: string | null;
  result_json?: Record<string, unknown> | null;
};

export function isWatermarkPreconditionUploadError(
  errorText: string | null | undefined
): boolean {
  const error = typeof errorText === "string" ? errorText.trim() : "";
  if (!error) return false;
  if (
    error === "watermark_precondition_missing" ||
    error === "watermark_persist_failed" ||
    error === "watermark_apply_failed"
  ) {
    return true;
  }
  return /^Watermark requerido pero faltan\b/i.test(error);
}

export function isSafeProcessMediaNoSideEffectError(
  errorText: string | null | undefined
): boolean {
  const error = typeof errorText === "string" ? errorText.trim() : "";
  if (!error) return false;
  if (SAFE_PROCESS_MEDIA_NO_SIDE_EFFECT_ERRORS.has(error)) return true;
  if (error.endsWith("_not_called")) return true;
  if (error.includes("easybroker_upload_images_not_called")) return true;
  if (isWatermarkPreconditionUploadError(error)) return true;
  return false;
}

function uploadAttemptHadNoRemoteSideEffect(
  row: ProcessMediaRecoveryToolCall
): boolean {
  const result =
    row.result_json && typeof row.result_json === "object"
      ? row.result_json
      : null;
  if (result?.side_effect_started === false) return true;
  if (result?.side_effect_started === true) return false;
  const status = typeof result?.status === "string" ? result.status : null;
  if (
    status === "watermark_precondition_missing" ||
    status === "watermark_persist_failed" ||
    status === "watermark_apply_failed" ||
    status === "raw_photos_missing" ||
    status === "case_not_found" ||
    status === "case_id_required"
  ) {
    return true;
  }
  const error =
    typeof result?.error === "string"
      ? result.error
      : typeof result?.hint === "string"
        ? result.hint
        : null;
  return isWatermarkPreconditionUploadError(error);
}

/**
 * True only when process_media failed without any EasyBroker image side effect.
 * Allows forceRetry when upload was attempted but blocked by watermark/local
 * preconditions (side_effect_started=false).
 */
export function canSafelyForceRetryProcessMedia(params: {
  operation: ProcessMediaRecoveryOperation;
  uploadToolCalls: ProcessMediaRecoveryToolCall[];
}): boolean {
  if (params.operation.operation_type !== "process_media") return false;
  if (params.operation.status !== "failed") return false;

  const uploadAttempts = params.uploadToolCalls.filter(
    (row) => row.tool_name === "easybroker_upload_images"
  );
  if (uploadAttempts.length === 0) {
    return isSafeProcessMediaNoSideEffectError(params.operation.error_text);
  }

  // Upload tool ran, but every attempt stopped before EasyBroker HTTP.
  return uploadAttempts.every(uploadAttemptHadNoRemoteSideEffect);
}

/**
 * True when Ungga publish failed before CLI side effects (tool not called /
 * agent hallucinated success). Safe to reclaim the ledger and retry publish
 * on the existing CLI GU-ID without creating a new draft.
 */
export function canSafelyForceRetryUnggaPublish(params: {
  operation: ProcessMediaRecoveryOperation;
  publishToolCalls?: ProcessMediaRecoveryToolCall[];
}): boolean {
  if (params.operation.operation_type !== "publish") return false;
  if (params.operation.status !== "failed") return false;
  const error =
    typeof params.operation.error_text === "string"
      ? params.operation.error_text.trim()
      : "";
  if (
    error === "ungga_publish_listing_not_called" ||
    error.endsWith("_not_called") ||
    error.includes("publication_execution_result_missing") ||
    /ungga_publish_button_disabled|element is not enabled|gestiona desde tu portal o crm|open_modal_guid_mismatch|guid_mismatch/i.test(
      error
    ) ||
    (/locator\.click/i.test(error) &&
      (/timeout/i.test(error) || /not enabled/i.test(error)))
  ) {
    return true;
  }
  const attempts = (params.publishToolCalls ?? []).filter(
    (row) => row.tool_name === "ungga_publish_listing"
  );
  if (attempts.length === 0) return Boolean(error);
  return attempts.every((row) => {
    const result =
      row.result_json && typeof row.result_json === "object"
        ? row.result_json
        : null;
    if (result?.side_effect_started === false) return true;
    if (result?.side_effect_started === true) return false;
    const attemptError =
      typeof result?.error === "string"
        ? result.error
        : typeof result?.message === "string"
          ? result.message
          : "";
    if (
      /ungga_publish_button_disabled|element is not enabled|gestiona desde tu portal o crm|open_modal_guid_mismatch/i.test(
        attemptError
      )
    ) {
      return true;
    }
    // No result means the tool never ran.
    return result == null;
  });
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

/**
 * True when a scheduled resume (or null schedule) may proceed.
 * Future timestamps act as debounce/lease; past or null means due.
 */
export function isPublicationResumeDue(
  nextActionAt: string | null | undefined,
  nowMs: number = Date.now()
): boolean {
  if (typeof nextActionAt !== "string" || !nextActionAt.trim()) return true;
  const resumeMs = Date.parse(nextActionAt);
  if (!Number.isFinite(resumeMs)) return true;
  return resumeMs <= nowMs;
}
