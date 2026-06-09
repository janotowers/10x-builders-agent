import { createServerClient } from "@agents/db";

type Db = ReturnType<typeof createServerClient>;

function pendingConfirmationFromPayload(payload: unknown):
  | {
      toolCallId?: string;
      checkpointThreadId?: string;
    }
  | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as {
    type?: unknown;
    pendingConfirmation?: unknown;
  };
  if (record.type !== "pending_confirmation") return null;
  const pending = record.pendingConfirmation;
  if (!pending || typeof pending !== "object") return null;
  const pendingRecord = pending as {
    toolCallId?: unknown;
    checkpointThreadId?: unknown;
  };
  return {
    toolCallId:
      typeof pendingRecord.toolCallId === "string"
        ? pendingRecord.toolCallId
        : undefined,
    checkpointThreadId:
      typeof pendingRecord.checkpointThreadId === "string"
        ? pendingRecord.checkpointThreadId
        : undefined,
  };
}

export async function findPendingConfirmationCheckpoint(
  db: Db,
  params: {
    sessionId: string;
    toolCallId: string;
    turnId?: string | null;
  }
): Promise<string | null> {
  const { data } = await db
    .from("agent_messages")
    .select("structured_payload, turn_id, created_at")
    .eq("session_id", params.sessionId)
    .not("structured_payload", "is", null)
    .order("created_at", { ascending: false })
    .limit(100);

  const matches = (data ?? [])
    .map((row) => {
      const pending = pendingConfirmationFromPayload(row.structured_payload);
      if (!pending || pending.toolCallId !== params.toolCallId) return null;
      return {
        checkpointThreadId: pending.checkpointThreadId ?? null,
        turnId:
          typeof row.turn_id === "string" && row.turn_id.length > 0
            ? row.turn_id
            : null,
      };
    })
    .filter(
      (
        row
      ): row is {
        checkpointThreadId: string | null;
        turnId: string | null;
      } => row !== null
    );

  const preferred =
    params.turnId && matches.length > 1
      ? matches.find((row) => row.turnId === params.turnId)
      : null;
  return (preferred ?? matches[0])?.checkpointThreadId ?? null;
}
