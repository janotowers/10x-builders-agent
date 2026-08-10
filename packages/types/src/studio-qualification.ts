export const STUDIO_QUALIFICATION_ARTIFACT_KINDS = [
  "case_workflow",
  "reusable_skill",
  "durable_task",
  "schedule",
] as const;

export type StudioQualificationArtifactKind =
  (typeof STUDIO_QUALIFICATION_ARTIFACT_KINDS)[number];

export const STUDIO_QUALIFICATION_RUN_STATUSES = [
  "pending",
  "running",
  "passed",
  "failed",
  "stale",
  "non_convergent",
] as const;

export type StudioQualificationRunStatus =
  (typeof STUDIO_QUALIFICATION_RUN_STATUSES)[number];

/**
 * Durable Studio operational-test run. Costs mirror ai_usage_events: provider
 * reported and local estimates are separate and are observability, not billing.
 */
export interface StudioQualificationRun {
  id: string;
  user_id: string;
  artifact_kind: StudioQualificationArtifactKind;
  artifact_id: string;
  artifact_version: number | null;
  artifact_hash: string;
  status: StudioQualificationRunStatus;
  qualification_fingerprint: string;
  resolved_models_jsonb: Record<string, string>;
  judge_model_id: string;
  scenario_set_id: string;
  scenario_set_version: string;
  scenario_set_hash: string;
  rubric_id: string;
  rubric_version: string;
  rubric_hash: string;
  sandbox_policy_id: string;
  sandbox_policy_version: string;
  sandbox_policy_hash: string;
  runner_version: string;
  result_jsonb: Record<string, unknown>;
  error_jsonb: Record<string, unknown> | null;
  repair_iteration: number;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  reported_cost_micro_usd: number | null;
  estimated_cost_micro_usd: number | null;
  currency: string;
  pricing_version: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

export type StudioSkillRepairProposalStatus =
  | "generating"
  | "proposed"
  | "failed";

/**
 * Review-only output of one explicit repair request. It is deliberately not
 * an account_skill: applying, retesting, and publishing remain separate human
 * actions.
 */
export interface StudioSkillRepairProposal {
  id: string;
  user_id: string;
  source_skill_id: string;
  source_run_id: string;
  source_fingerprint: string;
  source_skill_version: number;
  repair_iteration: number;
  idempotency_key: string;
  status: StudioSkillRepairProposalStatus;
  proposed_body_md: string | null;
  proposed_metadata_jsonb: Record<string, unknown> | null;
  compiler_model_id: string | null;
  failure_jsonb: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}
