import type { OperationalCaseTestRun } from "@agents/types";
import type { DbClient } from "../client";

export async function createOperationalCaseTestRun(
  db: DbClient,
  input: {
    userId: string;
    caseId: string;
    caseTypeId: string;
    level: OperationalCaseTestRun["level"];
    stepKey?: string | null;
    skillSlug?: string | null;
    scenarioId?: string | null;
    rootSkillSlug?: string | null;
    request?: Record<string, unknown>;
  }
): Promise<OperationalCaseTestRun> {
  const { data, error } = await db
    .from("operational_case_test_runs")
    .insert({
      user_id: input.userId,
      case_id: input.caseId,
      case_type_id: input.caseTypeId,
      level: input.level,
      step_key: input.stepKey ?? null,
      skill_slug: input.skillSlug ?? null,
      scenario_id: input.scenarioId ?? null,
      root_skill_slug: input.rootSkillSlug ?? null,
      request_jsonb: input.request ?? {},
      status: "queued",
    })
    .select("*")
    .single();
  if (error) throw error;
  return data as OperationalCaseTestRun;
}

export async function getOperationalCaseTestRun(
  db: DbClient,
  runId: string
): Promise<OperationalCaseTestRun | null> {
  const { data, error } = await db
    .from("operational_case_test_runs")
    .select("*")
    .eq("id", runId)
    .maybeSingle();
  if (error) throw error;
  return (data as OperationalCaseTestRun | null) ?? null;
}

export async function markOperationalCaseTestRunRunning(
  db: DbClient,
  runId: string,
  params?: { turnId?: string | null }
): Promise<void> {
  const { error } = await db
    .from("operational_case_test_runs")
    .update({
      status: "running",
      started_at: new Date().toISOString(),
      turn_id: params?.turnId ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", runId);
  if (error) throw error;
}

export async function finishOperationalCaseTestRun(
  db: DbClient,
  params: {
    runId: string;
    status: Extract<OperationalCaseTestRun["status"], "completed" | "failed" | "timed_out">;
    result?: Record<string, unknown>;
    error?: string | null;
    turnId?: string | null;
  }
): Promise<void> {
  const { error } = await db
    .from("operational_case_test_runs")
    .update({
      status: params.status,
      result_jsonb: params.result ?? {},
      error: params.error ?? null,
      turn_id: params.turnId ?? null,
      finished_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.runId);
  if (error) throw error;
}
