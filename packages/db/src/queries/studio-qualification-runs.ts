import type {
  AiUsageEvent,
  StudioQualificationArtifactKind,
  StudioQualificationRun,
  StudioQualificationRunStatus,
  StudioSkillRepairProposal,
} from "@agents/types";
import type { DbClient } from "../client";

export interface CreateStudioQualificationRunInput {
  userId: string;
  artifactKind: StudioQualificationArtifactKind;
  artifactId: string;
  artifactVersion?: number | null;
  artifactHash: string;
  qualificationFingerprint: string;
  resolvedModels: Record<string, string>;
  judgeModelId: string;
  scenarioSet: { id: string; version: string; hash: string };
  rubric: { id: string; version: string; hash: string };
  sandboxPolicy: { id: string; version: string; hash: string };
  runnerVersion: string;
  repairIteration?: number;
}

export async function createStudioQualificationRun(
  db: DbClient,
  input: CreateStudioQualificationRunInput
): Promise<StudioQualificationRun> {
  const { data, error } = await db
    .from("studio_qualification_runs")
    .insert({
      user_id: input.userId,
      artifact_kind: input.artifactKind,
      artifact_id: input.artifactId,
      artifact_version: input.artifactVersion ?? null,
      artifact_hash: input.artifactHash,
      status: "pending" satisfies StudioQualificationRunStatus,
      qualification_fingerprint: input.qualificationFingerprint,
      resolved_models_jsonb: input.resolvedModels,
      judge_model_id: input.judgeModelId,
      scenario_set_id: input.scenarioSet.id,
      scenario_set_version: input.scenarioSet.version,
      scenario_set_hash: input.scenarioSet.hash,
      rubric_id: input.rubric.id,
      rubric_version: input.rubric.version,
      rubric_hash: input.rubric.hash,
      sandbox_policy_id: input.sandboxPolicy.id,
      sandbox_policy_version: input.sandboxPolicy.version,
      sandbox_policy_hash: input.sandboxPolicy.hash,
      runner_version: input.runnerVersion,
      repair_iteration: input.repairIteration ?? 0,
    })
    .select("*")
    .single();
  if (error) throw error;
  return data as StudioQualificationRun;
}

export async function getStudioQualificationRun(
  db: DbClient,
  params: { userId: string; runId: string }
): Promise<StudioQualificationRun | null> {
  const { data, error } = await db
    .from("studio_qualification_runs")
    .select("*")
    .eq("user_id", params.userId)
    .eq("id", params.runId)
    .maybeSingle();
  if (error) throw error;
  return (data as StudioQualificationRun | null) ?? null;
}

export async function listStudioQualificationRunsForArtifact(
  db: DbClient,
  params: {
    userId: string;
    artifactKind: StudioQualificationArtifactKind;
    artifactId: string;
    limit?: number;
  }
): Promise<StudioQualificationRun[]> {
  const { data, error } = await db
    .from("studio_qualification_runs")
    .select("*")
    .eq("user_id", params.userId)
    .eq("artifact_kind", params.artifactKind)
    .eq("artifact_id", params.artifactId)
    .order("created_at", { ascending: false })
    .limit(Math.max(1, Math.min(params.limit ?? 20, 100)));
  if (error) throw error;
  return (data ?? []) as StudioQualificationRun[];
}

export async function listAiUsageEventsForStudioQualificationRun(
  db: DbClient,
  params: { userId: string; runId: string }
): Promise<AiUsageEvent[]> {
  const { data, error } = await db
    .from("ai_usage_events")
    .select("*")
    .eq("user_id", params.userId)
    .eq("studio_qualification_run_id", params.runId)
    .order("occurred_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as AiUsageEvent[];
}

/** CAS claim: only a pending run can become running. */
export async function markStudioQualificationRunRunning(
  db: DbClient,
  params: { userId: string; runId: string }
): Promise<StudioQualificationRun | null> {
  const { data, error } = await db
    .from("studio_qualification_runs")
    .update({
      status: "running" satisfies StudioQualificationRunStatus,
      started_at: new Date().toISOString(),
    })
    .eq("user_id", params.userId)
    .eq("id", params.runId)
    .eq("status", "pending")
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return (data as StudioQualificationRun | null) ?? null;
}

export interface FinishStudioQualificationRunInput {
  userId: string;
  runId: string;
  status: Extract<
    StudioQualificationRunStatus,
    "passed" | "failed" | "non_convergent"
  >;
  result?: Record<string, unknown>;
  error?: Record<string, unknown> | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  reportedCostMicroUsd?: number | null;
  estimatedCostMicroUsd?: number | null;
  currency?: string;
  pricingVersion?: string | null;
}

/** CAS completion: late completions cannot overwrite a stale/terminal run. */
export async function finishStudioQualificationRun(
  db: DbClient,
  input: FinishStudioQualificationRunInput
): Promise<StudioQualificationRun | null> {
  const { data, error } = await db
    .from("studio_qualification_runs")
    .update({
      status: input.status,
      result_jsonb: input.result ?? {},
      error_jsonb: input.error ?? null,
      input_tokens: input.inputTokens ?? null,
      output_tokens: input.outputTokens ?? null,
      total_tokens: input.totalTokens ?? null,
      reported_cost_micro_usd: input.reportedCostMicroUsd ?? null,
      estimated_cost_micro_usd: input.estimatedCostMicroUsd ?? null,
      currency: input.currency ?? "USD",
      pricing_version: input.pricingVersion ?? null,
      finished_at: new Date().toISOString(),
    })
    .eq("user_id", input.userId)
    .eq("id", input.runId)
    .eq("status", "running")
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return (data as StudioQualificationRun | null) ?? null;
}

/**
 * Persist staleness for historical results whose full input fingerprint no
 * longer matches the current artifact/runtime configuration.
 */
export async function markStudioQualificationRunsStale(
  db: DbClient,
  params: {
    userId: string;
    artifactKind: StudioQualificationArtifactKind;
    artifactId: string;
    currentFingerprint: string;
  }
): Promise<StudioQualificationRun[]> {
  const now = new Date().toISOString();
  const { data, error } = await db
    .from("studio_qualification_runs")
    .update({ status: "stale", finished_at: now })
    .eq("user_id", params.userId)
    .eq("artifact_kind", params.artifactKind)
    .eq("artifact_id", params.artifactId)
    .neq("qualification_fingerprint", params.currentFingerprint)
    .in("status", ["pending", "running", "passed", "failed", "non_convergent"])
    .select("*");
  if (error) throw error;
  return (data ?? []) as StudioQualificationRun[];
}

export interface ClaimStudioSkillRepairProposalInput {
  userId: string;
  sourceSkillId: string;
  sourceRunId: string;
  sourceFingerprint: string;
  sourceSkillVersion: number;
  repairIteration: number;
  idempotencyKey: string;
}

export interface StudioSkillRepairProposalClaim {
  proposal: StudioSkillRepairProposal;
  claimed: boolean;
}

/**
 * Idempotency claim. The unique source-run/key constraints are the final
 * concurrency authority; a retry receives the existing proposal.
 */
export async function claimStudioSkillRepairProposal(
  db: DbClient,
  input: ClaimStudioSkillRepairProposalInput
): Promise<StudioSkillRepairProposalClaim> {
  const { data, error } = await db
    .from("studio_skill_repair_proposals")
    .insert({
      user_id: input.userId,
      source_skill_id: input.sourceSkillId,
      source_run_id: input.sourceRunId,
      source_fingerprint: input.sourceFingerprint,
      source_skill_version: input.sourceSkillVersion,
      repair_iteration: input.repairIteration,
      idempotency_key: input.idempotencyKey,
      status: "generating",
    })
    .select("*")
    .maybeSingle();
  if (!error && data) {
    return { proposal: data as StudioSkillRepairProposal, claimed: true };
  }

  const existing = await getStudioSkillRepairProposalForRun(db, {
    userId: input.userId,
    sourceRunId: input.sourceRunId,
  });
  if (existing) return { proposal: existing, claimed: false };
  if (error) throw error;
  throw new Error("Studio skill repair proposal claim returned no row");
}

export async function getStudioSkillRepairProposalForRun(
  db: DbClient,
  params: { userId: string; sourceRunId: string }
): Promise<StudioSkillRepairProposal | null> {
  const { data, error } = await db
    .from("studio_skill_repair_proposals")
    .select("*")
    .eq("user_id", params.userId)
    .eq("source_run_id", params.sourceRunId)
    .maybeSingle();
  if (error) throw error;
  return (data as StudioSkillRepairProposal | null) ?? null;
}

export async function finishStudioSkillRepairProposal(
  db: DbClient,
  input: {
    userId: string;
    proposalId: string;
    bodyMd: string;
    metadata: Record<string, unknown>;
    compilerModelId: string;
  }
): Promise<StudioSkillRepairProposal | null> {
  const { data, error } = await db
    .from("studio_skill_repair_proposals")
    .update({
      status: "proposed",
      proposed_body_md: input.bodyMd,
      proposed_metadata_jsonb: input.metadata,
      compiler_model_id: input.compilerModelId,
    })
    .eq("user_id", input.userId)
    .eq("id", input.proposalId)
    .eq("status", "generating")
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return (data as StudioSkillRepairProposal | null) ?? null;
}

export async function failStudioSkillRepairProposal(
  db: DbClient,
  input: {
    userId: string;
    proposalId: string;
    failure: Record<string, unknown>;
    compilerModelId?: string | null;
  }
): Promise<StudioSkillRepairProposal | null> {
  const { data, error } = await db
    .from("studio_skill_repair_proposals")
    .update({
      status: "failed",
      failure_jsonb: input.failure,
      compiler_model_id: input.compilerModelId ?? null,
    })
    .eq("user_id", input.userId)
    .eq("id", input.proposalId)
    .eq("status", "generating")
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return (data as StudioSkillRepairProposal | null) ?? null;
}
