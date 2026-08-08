/**
 * AI usage metering types (flexible-workflows plan, Slice 0.4 / Technical
 * Plan §23.1).
 *
 * Scope: INTERNAL observability of AI-model usage only. One append-only event
 * per model call, tenant-scoped. Explicitly NOT billing: no customer prices,
 * credits, quotas, balances or invoices.
 */

/** What kind of provider resource the event meters. v1: AI models only. */
export type AiUsageResourceType = "ai_model";

export type AiUsageOperation =
  | "chat_completion"
  | "embedding"
  | "vision"
  | "extraction"
  | "classification";

/**
 * Logical role of the call. Mirrors the `*_MODEL_ID` env-role inventory
 * (docs/tools-design/model-providers.md); new roles may be introduced by
 * later phases (e.g. workflow verifiers), so this stays an open string with
 * well-known constants below.
 */
export type AiUsageModelRole = string;

export const AI_USAGE_MODEL_ROLES = {
  MAIN_AGENT: "main_agent",
  COMPACTION: "compaction",
  SKILL_SELECTOR: "skill_selector",
  BUSINESS_BRAIN_REVIEWER: "business_brain_reviewer",
  OPERATIONAL_CONVERSATION_CLASSIFIER: "operational_conversation_classifier",
  PENDING_DECISION_UNCLEAR_CLASSIFIER: "pending_decision_unclear_classifier",
  LISTING_DESCRIPTION_CHANGE_CLASSIFIER: "listing_description_change_classifier",
  CONTRACT_COMMERCIAL_EXTRACTION: "contract_commercial_extraction",
  OWNER_CHARACTERISTICS_EXTRACTION: "owner_characteristics_extraction",
  IMAGE_VISION: "image_vision",
  LISTING_COPY: "listing_copy",
  PREDIAL_EXTRACTION: "predial_extraction",
  EMBEDDINGS: "embeddings",
  HEARTBEAT: "heartbeat",
  /** Verificador independiente de valuación (Slice 3.4; §9.1). */
  VALUATION_VERIFIER: "valuation_verifier",
  /** Descomposición conservadora de intents por turno (Slice 4.1; §12). */
  INTENT_DECOMPOSER: "intent_decomposer",
  /** Compilador NL → business/implementation spec + grafo (Slice 4.2; §15). */
  WORKFLOW_COMPILER: "workflow_compiler",
} as const;

export type AiUsageStatus = "ok" | "error";

/** Token counts per category. `null`/absent = provider did not report it. */
export interface AiUsageTokenBreakdown {
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  /** Provider-reported cached/read-from-cache input tokens. */
  cachedInputTokens?: number | null;
  /** Provider-reported reasoning tokens (o-series / thinking models). */
  reasoningTokens?: number | null;
}

/**
 * Costs in integer micro-USD (1 USD = 1_000_000). Reported (provider-billed)
 * and estimated (versioned price catalog) are preserved separately and never
 * overwrite each other.
 */
export interface AiUsageCostBreakdown {
  reportedCostMicroUsd?: number | null;
  estimatedCostMicroUsd?: number | null;
  currency?: string;
  /** Version tag of the price catalog used for the estimate. */
  pricingVersion?: string | null;
}

/**
 * Ambient attribution for a model call. Established at the channel entry
 * points (web chat, Telegram webhook, crons, Gu OS Heartbeat) and enriched by
 * `runAgent` (turn/session/case ids) so every downstream call is attributable.
 */
export interface AiUsageContext {
  userId: string;
  channel?:
    | "web"
    | "telegram"
    | "cron"
    | "heartbeat"
    | "case_runner"
    | "settings"
    /** Local live evals / walkthrough scripts (OpenRouter still billed). */
    | "cli"
    | null;
  sessionId?: string | null;
  turnId?: string | null;
  operationalCaseId?: string | null;
  /** Future correlation ids (work plane, Phase 2+). No FKs yet. */
  workflowDefinitionId?: string | null;
  workItemId?: string | null;
  workItemAttemptId?: string | null;
}

/** Input for one append-only `ai_usage_events` row. */
export interface AiUsageEventInput extends AiUsageTokenBreakdown, AiUsageCostBreakdown {
  userId: string;
  provider?: string;
  resourceType?: AiUsageResourceType;
  operation: AiUsageOperation;
  /** Requested model id (OpenRouter slug). */
  modelId: string;
  modelRole: AiUsageModelRole;
  channel?: AiUsageContext["channel"];
  latencyMs?: number | null;
  status?: AiUsageStatus;
  errorCode?: string | null;
  /** 0 for the first attempt; retries append NEW events with ordinal+1. */
  retryOrdinal?: number;
  providerRequestId?: string | null;
  sessionId?: string | null;
  turnId?: string | null;
  operationalCaseId?: string | null;
  workflowDefinitionId?: string | null;
  workItemId?: string | null;
  workItemAttemptId?: string | null;
  occurredAt?: string;
  /**
   * Allowlisted, non-content metadata (e.g. worker profile). NEVER prompts,
   * responses, tool arguments or secrets.
   */
  metadata?: Record<string, string | number | boolean | null>;
}

/** Persisted row shape (snake_case, mirrors the table). */
export interface AiUsageEvent {
  id: string;
  user_id: string;
  occurred_at: string;
  provider: string;
  resource_type: AiUsageResourceType;
  operation: AiUsageOperation;
  model_id: string;
  model_role: string;
  channel: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  cached_input_tokens: number | null;
  reasoning_tokens: number | null;
  reported_cost_micro_usd: number | null;
  estimated_cost_micro_usd: number | null;
  currency: string;
  pricing_version: string | null;
  latency_ms: number | null;
  status: AiUsageStatus;
  error_code: string | null;
  retry_ordinal: number;
  provider_request_id: string | null;
  session_id: string | null;
  turn_id: string | null;
  operational_case_id: string | null;
  workflow_definition_id: string | null;
  work_item_id: string | null;
  work_item_attempt_id: string | null;
  metadata_jsonb: Record<string, unknown>;
  created_at: string;
}
