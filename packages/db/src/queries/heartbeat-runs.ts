import type { DbClient } from "../client";
import type { HeartbeatRun } from "@agents/types";

export async function createHeartbeatRun(
  db: DbClient,
  params: { userId: string; sessionId?: string | null }
): Promise<HeartbeatRun> {
  const { data, error } = await db
    .from("heartbeat_runs")
    .insert({
      user_id: params.userId,
      session_id: params.sessionId ?? null,
      status: "running",
    })
    .select("*")
    .single();
  if (error) throw error;
  return data as HeartbeatRun;
}

export async function finishHeartbeatRun(
  db: DbClient,
  params: {
    runId: string;
    status: "completed" | "error";
    payload?: Record<string, unknown>;
    error?: string | null;
  }
): Promise<void> {
  const { error } = await db
    .from("heartbeat_runs")
    .update({
      status: params.status,
      payload: params.payload ?? {},
      error: params.error ?? null,
      finished_at: new Date().toISOString(),
    })
    .eq("id", params.runId);
  if (error) throw error;
}

export async function listHeartbeatRuns(
  db: DbClient,
  userId: string,
  options?: { limit?: number }
): Promise<HeartbeatRun[]> {
  const limit = options?.limit ?? 20;
  const { data, error } = await db
    .from("heartbeat_runs")
    .select("*")
    .eq("user_id", userId)
    .order("started_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as HeartbeatRun[];
}
