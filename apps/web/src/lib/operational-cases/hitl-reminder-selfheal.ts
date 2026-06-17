const TOOL_CONFIRMATION_PENDING_KIND = "tool_confirmation_pending";

export function notificationMetadataPendingToolCallId(
  metadata: Record<string, unknown> | null | undefined
): string | null {
  const value = metadata?.pending_tool_call_id;
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

export function hasCaseContextLine(body: string): boolean {
  return body.includes("Caso:");
}

export function shouldRefreshToolConfirmationNotification(params: {
  kind: string;
  body: string;
  metadata: Record<string, unknown> | null | undefined;
  pendingToolCallId: string;
}): boolean {
  if (params.kind !== TOOL_CONFIRMATION_PENDING_KIND) return false;
  const currentPendingToolCallId = notificationMetadataPendingToolCallId(
    params.metadata
  );
  if (currentPendingToolCallId !== params.pendingToolCallId) return true;
  if (!hasCaseContextLine(params.body)) return true;
  return false;
}

export function buildToolConfirmationEscalationText(params: {
  title: string;
  body: string;
}): string {
  return `Escalación: sigue pendiente «${params.title}».\n\n${params.body}`;
}
