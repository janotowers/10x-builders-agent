import type { DbClient } from "../client";
import type { ToolCall } from "@agents/types";

export async function createToolCall(
  db: DbClient,
  sessionId: string,
  toolName: string,
  args: Record<string, unknown>,
  requiresConfirmation: boolean,
  turnId?: string | null,
  options?: { executorKind?: "agent" | "deterministic" }
) {
  const { data, error } = await db
    .from("tool_calls")
    .insert({
      session_id: sessionId,
      turn_id: turnId ?? null,
      tool_name: toolName,
      arguments_json: args,
      status: requiresConfirmation ? "pending_confirmation" : "approved",
      requires_confirmation: requiresConfirmation,
      executor_kind: options?.executorKind ?? "agent",
    })
    .select()
    .single();
  if (error) throw error;
  return data as ToolCall;
}

export async function updateToolCallStatus(
  db: DbClient,
  toolCallId: string,
  status: ToolCall["status"],
  resultJson?: Record<string, unknown>
) {
  const update: Record<string, unknown> = { status };
  if (resultJson) update.result_json = resultJson;
  if (status === "executed" || status === "failed") {
    update.finished_at = new Date().toISOString();
  }
  const { error } = await db
    .from("tool_calls")
    .update(update)
    .eq("id", toolCallId);
  if (error) throw error;
}

export async function getPendingToolCall(db: DbClient, toolCallId: string) {
  const { data } = await db
    .from("tool_calls")
    .select("*")
    .eq("id", toolCallId)
    .eq("status", "pending_confirmation")
    .single();
  return data as ToolCall | null;
}

export async function findExistingPendingToolCall(
  db: DbClient,
  sessionId: string,
  toolName: string,
  args?: Record<string, unknown>,
  turnId?: string | null
) {
  let query = db
    .from("tool_calls")
    .select("*")
    .eq("session_id", sessionId)
    .eq("tool_name", toolName)
    .eq("status", "pending_confirmation")
    .order("created_at", { ascending: false })
    .limit(1);
  if (turnId) query = query.eq("turn_id", turnId);
  const { data } = await query.maybeSingle();
  const row = (data as ToolCall | null) ?? null;
  if (!row || !args) return row;
  return JSON.stringify(row.arguments_json ?? {}) === JSON.stringify(args)
    ? row
    : null;
}

/**
 * Persist a system-issued tool read (e.g. a Heartbeat prefetcher) directly
 * with its terminal status. Skips the agent's two-step `pending → executed`
 * lifecycle because the read already happened deterministically before any
 * LLM call. Returns the row so callers can correlate with prompt content.
 */
export async function recordDeterministicToolCall(
  db: DbClient,
  params: {
    sessionId: string;
    turnId?: string | null;
    toolName: string;
    args: Record<string, unknown>;
    status: "executed" | "failed";
    result?: Record<string, unknown>;
  }
): Promise<ToolCall> {
  const finishedAt = new Date().toISOString();
  const insert: Record<string, unknown> = {
    session_id: params.sessionId,
    turn_id: params.turnId ?? null,
    tool_name: params.toolName,
    arguments_json: params.args,
    status: params.status,
    requires_confirmation: false,
    executor_kind: "deterministic",
    finished_at: finishedAt,
  };
  if (params.result) insert.result_json = params.result;

  const { data, error } = await db
    .from("tool_calls")
    .insert(insert)
    .select()
    .single();
  if (error) throw error;
  return data as ToolCall;
}
