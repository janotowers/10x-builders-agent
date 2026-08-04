// Work plane (flexible-workflows plan, Phase 2 / Slices 2.1-2.2;
// Technical Plan §7/§10). Executable work owned by an operational case.
// Vocabulary is deliberately generic and NEVER mixes with case vocabulary
// (standing rule 6). Claim-liveness terms never use the word "heartbeat"
// (standing rule 4): use liveness update / lease renewal / stale claim.

export const WORK_ITEM_STATUSES = [
  "todo",
  "ready",
  "running",
  "blocked",
  "review",
  "done",
  "cancelled",
] as const;

export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];

/**
 * Provenance of a work item (implementation-plan finding 17).
 * Dispatch/readiness/claim logic never branches on this value; it exists for
 * audit, replay equivalence, and to keep the schema from assuming
 * template-only creation.
 */
export const WORK_ITEM_ORIGINS = [
  "definition_template",
  "impact_repair",
  "agent_proposed",
  "human",
] as const;

export type WorkItemOrigin = (typeof WORK_ITEM_ORIGINS)[number];

export const WORK_ITEM_ATTEMPT_STATUSES = [
  "running",
  "succeeded",
  "failed",
  "claim_expired",
  "cancelled",
] as const;

export type WorkItemAttemptStatus =
  (typeof WORK_ITEM_ATTEMPT_STATUSES)[number];

/**
 * Event vocabulary for `work_item_events`. The DB column has no closed CHECK
 * (finding 9 lesson); this union is the canonical vocabulary. A liveness
 * update and a lease renewal are distinct events — never collapse them
 * (Technical Plan §10).
 */
export const WORK_ITEM_EVENT_TYPES = [
  "created",
  "ready",
  "claimed",
  "liveness_updated",
  "claim_renewed",
  "claim_expired",
  "attempt_failed",
  "verified",
  "blocked",
  "done",
  "cancelled",
] as const;

export type WorkItemEventType = (typeof WORK_ITEM_EVENT_TYPES)[number];

export type WorkItemEventActor = "system" | "agent" | "user" | "external";

/**
 * Executor kinds (Technical Plan §9). All first-class in vocabulary; only
 * main_agent, deterministic_service, specialized_agent and human have
 * runtime executors in Phase 3 — the rest stay declared-but-unimplemented.
 */
export const WORKER_EXECUTION_MODES = [
  "main_agent",
  "deterministic_service",
  "specialized_agent",
  "ephemeral_subagent",
  "durable_worker",
  "external_service",
  "human",
] as const;

export type WorkerExecutionMode = (typeof WORKER_EXECUTION_MODES)[number];

/**
 * Model policy per worker profile (Technical Plan §9.1). The alias resolves
 * through a central map in code — profiles never hardcode vendor model ids.
 */
export interface WorkerModelPolicy {
  role?: string;
  model_alias?: string;
  fallback_aliases?: string[];
  max_output_tokens?: number;
  temperature?: number;
  max_cost_cents_per_run?: number;
}

/**
 * Worker profile (Slice 3.4-1; Technical Plan §9). `user_id` null = global
 * catalog profile; execution is always tenant-scoped (inherits the work
 * item's user_id). Profiles NEVER embed credentials (§21).
 */
export interface WorkerProfile {
  id: string;
  user_id: string | null;
  slug: string;
  capabilities: string[];
  execution_mode: WorkerExecutionMode;
  allowed_tools: string[];
  allowed_data_scopes: string[];
  model_policy_jsonb: WorkerModelPolicy & Record<string, unknown>;
  approval_policy_jsonb: Record<string, unknown>;
  timeout_seconds: number;
  retry_policy_jsonb: Record<string, unknown>;
  verification_contract_jsonb: Record<string, unknown>;
  max_concurrency: number;
  cost_ceiling_cents: number | null;
  created_at: string;
  updated_at: string;
}

export interface WorkItem {
  id: string;
  case_id: string;
  user_id: string;
  workflow_definition_version: number;
  work_type: string;
  origin: WorkItemOrigin;
  status: WorkItemStatus;
  priority: number;
  required_capability: string;
  assigned_worker_profile_id: string | null;
  not_before: string | null;
  due_at: string | null;
  attempt_count: number;
  max_attempts: number;
  current_attempt_id: string | null;
  blocked_reason: string | null;
  input_contract_jsonb: Record<string, unknown>;
  output_contract_jsonb: Record<string, unknown>;
  verification_contract_jsonb: Record<string, unknown>;
  result_jsonb: Record<string, unknown> | null;
  idempotency_key: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface WorkItemAttempt {
  id: string;
  work_item_id: string;
  user_id: string;
  attempt_number: number;
  executor_kind: string;
  executor_ref: string | null;
  worker_profile_id: string | null;
  status: WorkItemAttemptStatus;
  claimed_at: string;
  claim_expires_at: string;
  /**
   * Most recent liveness update from the executor processing this attempt.
   * Unrelated to the Gu OS Heartbeat proactive-execution feature.
   */
  last_liveness_at: string | null;
  last_progress_at: string | null;
  completed_at: string | null;
  error_jsonb: Record<string, unknown> | null;
  evidence_jsonb: Record<string, unknown> | null;
  created_at: string;
}

export interface WorkItemDependency {
  work_item_id: string;
  depends_on_id: string;
  user_id: string;
  dependency_kind: "finish_to_start";
  created_at: string;
}

export interface WorkItemEvent {
  id: string;
  work_item_id: string;
  attempt_id: string | null;
  user_id: string;
  event_type: WorkItemEventType;
  actor: WorkItemEventActor;
  payload_jsonb: Record<string, unknown>;
  created_at: string;
}

/**
 * Input for instantiating work items from a definition's `work_templates`
 * (`on_enter_state`) or from the impact engine's repair templates (Phase 3).
 *
 * Contract-writing discipline (finding 18): `input_contract` carries the
 * objective, `verification_contract` carries the exit criteria; templates
 * never script step-by-step procedures.
 *
 * `depends_on` references sibling templates by `work_type` within the same
 * instantiation batch (resolved to work-item ids at creation).
 */
export interface WorkItemTemplateSpec {
  work_type: string;
  required_capability: string;
  priority?: number;
  not_before?: string | null;
  due_at?: string | null;
  max_attempts?: number;
  input_contract?: Record<string, unknown>;
  output_contract?: Record<string, unknown>;
  verification_contract?: Record<string, unknown>;
  depends_on?: string[];
  /**
   * Defaults to `<on_enter_state>:<work_type>` at the call site so the same
   * state entry never duplicates items (unique (case_id, idempotency_key)).
   */
  idempotency_key?: string;
}
