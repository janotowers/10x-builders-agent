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

export async function countPendingToolCallsForCase(
  db: DbClient,
  caseId: string
): Promise<number> {
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
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  return new Set(ids).size;
}

async function listPendingToolCallIdsForCase(
  db: DbClient,
  caseId: string
): Promise<string[]> {
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

  return [
    ...new Set(
      [...(argsResult.data ?? []), ...(metaResult.data ?? [])]
        .map((row: { id?: unknown }) => row.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0)
    ),
  ];
}

export async function rejectPendingToolCallsForCase(
  db: DbClient,
  caseId: string,
  reason = "pending_inbox_cleanup"
): Promise<number> {
  const uniqueIds = await listPendingToolCallIdsForCase(db, caseId);
  if (uniqueIds.length === 0) return 0;

  const finishedAt = new Date().toISOString();
  const { data, error } = await db
    .from("tool_calls")
    .update({
      status: "rejected",
      finished_at: finishedAt,
      result_json: {
        reason,
        case_id: caseId,
      },
    })
    .in("id", uniqueIds)
    .eq("status", "pending_confirmation")
    .select("id");
  if (error) throw error;
  return data?.length ?? 0;
}

/**
 * Al cancelar un HITL técnico, cierra también otros pending del mismo tool
 * para el mismo caso (reintentos / mensajes Telegram duplicados).
 */
export async function rejectSiblingPendingToolCallsForCase(
  db: DbClient,
  params: {
    caseId: string;
    toolName: string;
    excludeToolCallId?: string | null;
    reason?: string;
  }
): Promise<number> {
  const pendingIds = await listPendingToolCallIdsForCase(db, params.caseId);
  const exclude = params.excludeToolCallId?.trim() || null;
  const candidateIds = pendingIds.filter((id) => id !== exclude);
  if (candidateIds.length === 0) return 0;

  const { data: rows, error: selectError } = await db
    .from("tool_calls")
    .select("id, tool_name")
    .in("id", candidateIds)
    .eq("status", "pending_confirmation");
  if (selectError) throw selectError;

  const matchingIds = (rows ?? [])
    .filter(
      (row: { id?: unknown; tool_name?: unknown }) =>
        typeof row.id === "string" &&
        row.tool_name === params.toolName
    )
    .map((row: { id: string }) => row.id);
  if (matchingIds.length === 0) return 0;

  const finishedAt = new Date().toISOString();
  const { data, error } = await db
    .from("tool_calls")
    .update({
      status: "rejected",
      finished_at: finishedAt,
      result_json: {
        reason: params.reason ?? "sibling_tool_confirmation_rejected",
        case_id: params.caseId,
        tool_name: params.toolName,
      },
    })
    .in("id", matchingIds)
    .eq("status", "pending_confirmation")
    .select("id");
  if (error) throw error;
  return data?.length ?? 0;
}

/**
 * Cierra pending_confirmation que ya fueron superados por un intento más
 * reciente del mismo tool en el mismo caso (approved/failed/rejected/executed).
 */
export async function rejectSupersededPendingToolCallsForCase(
  db: DbClient,
  caseId: string,
  reason = "superseded_by_newer_tool_attempt"
): Promise<number> {
  const pendingIds = await listPendingToolCallIdsForCase(db, caseId);
  if (pendingIds.length === 0) return 0;

  const { data: pendingRows, error: pendingError } = await db
    .from("tool_calls")
    .select("id, tool_name, created_at")
    .in("id", pendingIds)
    .eq("status", "pending_confirmation");
  if (pendingError) throw pendingError;
  if (!pendingRows || pendingRows.length === 0) return 0;

  const toolNames = [
    ...new Set(
      (pendingRows as Array<{ tool_name?: unknown }>)
        .map((row) => row.tool_name)
        .filter((name): name is string => typeof name === "string" && name.length > 0)
    ),
  ];
  if (toolNames.length === 0) return 0;

  const [argsResult, metaResult] = await Promise.all([
    db
      .from("tool_calls")
      .select("id, tool_name, status, created_at")
      .in("tool_name", toolNames)
      .in("status", ["approved", "executed", "failed", "rejected"])
      .contains("arguments_json", { case_id: caseId })
      .order("created_at", { ascending: false })
      .limit(100),
    db
      .from("tool_calls")
      .select("id, tool_name, status, created_at")
      .in("tool_name", toolNames)
      .in("status", ["approved", "executed", "failed", "rejected"])
      .eq("metadata_jsonb->>case_id", caseId)
      .order("created_at", { ascending: false })
      .limit(100),
  ]);
  if (argsResult.error) throw argsResult.error;
  if (metaResult.error) throw metaResult.error;

  const newerByTool = new Map<string, number>();
  for (const row of [...(argsResult.data ?? []), ...(metaResult.data ?? [])] as Array<{
    tool_name?: unknown;
    created_at?: unknown;
  }>) {
    if (typeof row.tool_name !== "string" || typeof row.created_at !== "string") {
      continue;
    }
    const createdMs = new Date(row.created_at).getTime();
    if (!Number.isFinite(createdMs)) continue;
    const prev = newerByTool.get(row.tool_name);
    if (prev == null || createdMs > prev) newerByTool.set(row.tool_name, createdMs);
  }

  const supersededIds = (pendingRows as Array<{
    id: string;
    tool_name: string;
    created_at: string;
  }>)
    .filter((pending) => {
      const newestMs = newerByTool.get(pending.tool_name);
      if (newestMs == null) return false;
      const pendingMs = new Date(pending.created_at).getTime();
      return Number.isFinite(pendingMs) && newestMs > pendingMs;
    })
    .map((pending) => pending.id);

  if (supersededIds.length === 0) return 0;

  const finishedAt = new Date().toISOString();
  const { data, error } = await db
    .from("tool_calls")
    .update({
      status: "rejected",
      finished_at: finishedAt,
      result_json: {
        reason,
        case_id: caseId,
      },
    })
    .in("id", supersededIds)
    .eq("status", "pending_confirmation")
    .select("id");
  if (error) throw error;
  return data?.length ?? 0;
}
