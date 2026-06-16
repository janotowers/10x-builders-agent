/**
 * Resolves the pending tool_call id backing a `tool_confirmation_pending`
 * notification. Looks first at the live payload data (direct send) and then at
 * the source notification metadata (reminder/escalation re-send), so the
 * actionable approve/reject buttons can be reconstructed without re-running the
 * agent. Kept dependency-free so it is cheap to unit test.
 */
export function resolvePendingToolCallId(
  payloadData: Record<string, unknown> | null | undefined,
  sourceNotificationMetadata: Record<string, unknown> | null | undefined
): string | null {
  const fromPayload = payloadData?.pending_tool_call_id;
  if (typeof fromPayload === "string" && fromPayload.trim()) {
    return fromPayload.trim();
  }
  const fromSource = sourceNotificationMetadata?.pending_tool_call_id;
  if (typeof fromSource === "string" && fromSource.trim()) {
    return fromSource.trim();
  }
  return null;
}
