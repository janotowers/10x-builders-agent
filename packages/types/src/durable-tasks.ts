// Durable task roots (flexible-workflows plan, Phase 5 / Slice 5.1;
// Technical Plan §7.0). Independent of operational_cases: batch jobs and
// long-running work hang from durable_tasks → work_runs → work_items.
// Studio authoring sessions (Slice 5.3 seam) persist NL→artifact router state.

export const DURABLE_TASK_STATUSES = [
  "draft",
  "active",
  "paused",
  "completed",
  "cancelled",
  "failed",
] as const;

export type DurableTaskStatus = (typeof DURABLE_TASK_STATUSES)[number];

export const WORK_RUN_STATUSES = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;

export type WorkRunStatus = (typeof WORK_RUN_STATUSES)[number];

export const STUDIO_AUTHORING_SESSION_STATUSES = [
  "active",
  "clarifying",
  "materializing",
  "compiled",
  "abandoned",
  "redirected",
] as const;

export type StudioAuthoringSessionStatus =
  (typeof STUDIO_AUTHORING_SESSION_STATUSES)[number];

/**
 * Raíz durable (no expediente comercial). Vocabulario de ejecución, no de
 * caso — standing rule 6.
 */
export interface DurableTask {
  id: string;
  user_id: string;
  title: string;
  objective: string;
  status: DurableTaskStatus;
  retention_policy_jsonb: Record<string, unknown>;
  input_contract_jsonb: Record<string, unknown>;
  spec_jsonb: Record<string, unknown>;
  acceptance_criteria_jsonb: unknown[];
  work_templates_jsonb: unknown[];
  result_contract_jsonb: Record<string, unknown>;
  result_jsonb: Record<string, unknown> | null;
  schedule_ref: string | null;
  provenance_jsonb: Record<string, unknown>;
  version: number;
  created_at: string;
  updated_at: string;
}

/**
 * Una corrida de una durable_task. Los work_items cuelgan de work_run_id
 * (XOR con case_id en work_items).
 */
export interface WorkRun {
  id: string;
  durable_task_id: string;
  user_id: string;
  status: WorkRunStatus;
  started_at: string | null;
  finished_at: string | null;
  result_ref: string | null;
  result_jsonb: Record<string, unknown> | null;
  error_jsonb: Record<string, unknown> | null;
  input_jsonb: Record<string, unknown>;
  retention_expires_at: string | null;
  scheduled_task_id: string | null;
  created_at: string;
  updated_at: string;
}

/** Input con scope de tarea/run; nunca se mezcla con account_assets. */
export interface DurableTaskInput {
  id: string;
  user_id: string;
  durable_task_id: string;
  work_run_id: string | null;
  input_key: string;
  display_name: string;
  value_jsonb: unknown | null;
  storage_bucket: string | null;
  storage_path: string | null;
  content_type: string | null;
  file_size_bytes: number | null;
  expires_at: string | null;
  created_at: string;
}

/**
 * Estado del router de autoría del Studio (Slice 5.3). Persiste clarificaciones
 * y el artefacto sugerido; no es el workflow compilado en sí.
 */
export interface StudioAuthoringSession {
  id: string;
  user_id: string;
  status: StudioAuthoringSessionStatus;
  description_nl: string;
  title: string | null;
  suggested_slug: string | null;
  router_kind: string | null;
  router_output_jsonb: Record<string, unknown>;
  clarification_round: number;
  messages_jsonb: unknown[];
  progress_jsonb: unknown[];
  artifact_kind: string | null;
  artifact_ref: Record<string, unknown>;
  model_id: string | null;
  provenance_jsonb: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}
