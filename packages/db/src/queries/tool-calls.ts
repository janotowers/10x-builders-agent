import type { DbClient } from "../client";
import type { ToolCall, ToolCallMetadata } from "@agents/types";
import { verifyOwnedSettingsTestCase } from "./notifications";

export async function createToolCall(
  db: DbClient,
  sessionId: string,
  toolName: string,
  args: Record<string, unknown>,
  requiresConfirmation: boolean,
  turnId?: string | null,
  options?: {
    executorKind?: "agent" | "deterministic";
    metadata?: ToolCallMetadata;
  }
) {
  const insert: Record<string, unknown> = {
    session_id: sessionId,
    turn_id: turnId ?? null,
    tool_name: toolName,
    arguments_json: args,
    status: requiresConfirmation ? "pending_confirmation" : "approved",
    requires_confirmation: requiresConfirmation,
    executor_kind: options?.executorKind ?? "agent",
  };
  if (options?.metadata && Object.keys(options.metadata).length > 0) {
    insert.metadata_jsonb = options.metadata;
  }
  const { data, error } = await db
    .from("tool_calls")
    .insert(insert)
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
  if (status === "executed" || status === "failed" || status === "rejected") {
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
    metadata?: ToolCallMetadata;
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
  if (params.metadata && Object.keys(params.metadata).length > 0) {
    insert.metadata_jsonb = params.metadata;
  }

  const { data, error } = await db
    .from("tool_calls")
    .insert(insert)
    .select()
    .single();
  if (error) throw error;
  return data as ToolCall;
}

export async function rejectSettingsTestPendingToolCallsForCase(
  db: DbClient,
  userId: string,
  caseId: string,
  opts: { excludeToolCallIds?: string[] } = {}
): Promise<number> {
  const verified = await verifyOwnedSettingsTestCase(db, userId, caseId);
  if (!verified) return 0;

  const exclude = new Set(opts.excludeToolCallIds ?? []);
  const [argsResult, metaResult] = await Promise.all([
    db
      .from("tool_calls")
      .select("id")
      .eq("status", "pending_confirmation")
      .contains("arguments_json", { case_id: caseId }),
    db
      .from("tool_calls")
      .select("id")
      .eq("status", "pending_confirmation")
      .eq("metadata_jsonb->>case_id", caseId),
  ]);
  if (argsResult.error) throw argsResult.error;
  if (metaResult.error) throw metaResult.error;

  const ids = [...(argsResult.data ?? []), ...(metaResult.data ?? [])]
    .map((row: { id?: unknown }) => row.id)
    .filter(
      (id): id is string =>
        typeof id === "string" && id.length > 0 && !exclude.has(id)
    );
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return 0;

  const finishedAt = new Date().toISOString();
  const { data, error } = await db
    .from("tool_calls")
    .update({
      status: "rejected",
      finished_at: finishedAt,
      result_json: {
        reason: "settings_test_history_cleanup",
        case_id: caseId,
      },
    })
    .in("id", uniqueIds)
    .eq("status", "pending_confirmation")
    .select("id");
  if (error) throw error;
  return data?.length ?? 0;
}
