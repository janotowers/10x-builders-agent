/**
 * AI usage ledger queries (flexible-workflows plan, Slice 0.4 / 0.4.1).
 *
 * Writes are service-role only (metering runs in server routes/crons).
 * Reads are internal: tenant-scoped helpers take a required `userId`;
 * admin-wide reads require an explicit `adminWide: true` that callers may
 * only set after verifying `profiles.is_ungga_admin` (same pattern as other
 * admin surfaces). Rollups are pure functions over fetched rows so they are
 * unit-testable without a database.
 *
 * Accounted cost invariant (never double-count):
 *   accounted = reported_cost_micro_usd ?? estimated_cost_micro_usd ?? 0
 */
import type { DbClient } from "../client";
import type { AiUsageEvent, AiUsageEventInput } from "@agents/types";

function intOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(value)
    : null;
}

/**
 * Inserts one append-only usage event. Throws on failure — callers that must
 * never fail a user turn (the meter) catch and count drops themselves.
 */
export async function insertAiUsageEvent(
  db: DbClient,
  input: AiUsageEventInput
): Promise<AiUsageEvent> {
  const { data, error } = await db
    .from("ai_usage_events")
    .insert({
      user_id: input.userId,
      ...(input.occurredAt ? { occurred_at: input.occurredAt } : {}),
      provider: input.provider ?? "openrouter",
      resource_type: input.resourceType ?? "ai_model",
      operation: input.operation,
      model_id: input.modelId,
      model_role: input.modelRole,
      channel: input.channel ?? null,
      input_tokens: intOrNull(input.inputTokens),
      output_tokens: intOrNull(input.outputTokens),
      total_tokens: intOrNull(input.totalTokens),
      cached_input_tokens: intOrNull(input.cachedInputTokens),
      reasoning_tokens: intOrNull(input.reasoningTokens),
      reported_cost_micro_usd: intOrNull(input.reportedCostMicroUsd),
      estimated_cost_micro_usd: intOrNull(input.estimatedCostMicroUsd),
      currency: input.currency ?? "USD",
      pricing_version: input.pricingVersion ?? null,
      latency_ms: intOrNull(input.latencyMs),
      status: input.status ?? "ok",
      error_code: input.errorCode ?? null,
      retry_ordinal: input.retryOrdinal ?? 0,
      provider_request_id: input.providerRequestId ?? null,
      session_id: input.sessionId ?? null,
      turn_id: input.turnId ?? null,
      operational_case_id: input.operationalCaseId ?? null,
      workflow_definition_id: input.workflowDefinitionId ?? null,
      work_item_id: input.workItemId ?? null,
      work_item_attempt_id: input.workItemAttemptId ?? null,
      metadata_jsonb: input.metadata ?? {},
    })
    .select("*")
    .single();
  if (error) throw error;
  return data as AiUsageEvent;
}

export interface ListAiUsageEventsParams {
  /** Required tenant scope unless `adminWide` is set. */
  userId: string;
  /**
   * Admin-wide read across tenants. Callers MUST verify
   * `profiles.is_ungga_admin` for `userId` before setting this.
   */
  adminWide?: boolean;
  sinceIso?: string;
  untilIso?: string;
  limit?: number;
}

export async function listAiUsageEvents(
  db: DbClient,
  params: ListAiUsageEventsParams
): Promise<AiUsageEvent[]> {
  if (!params.userId) throw new Error("listAiUsageEvents: userId is required");
  let query = db
    .from("ai_usage_events")
    .select("*")
    .order("occurred_at", { ascending: false })
    .limit(Math.min(Math.max(params.limit ?? 2000, 1), 10_000));
  if (!params.adminWide) query = query.eq("user_id", params.userId);
  if (params.sinceIso) query = query.gte("occurred_at", params.sinceIso);
  if (params.untilIso) query = query.lt("occurred_at", params.untilIso);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as AiUsageEvent[];
}

// ============================================================
// Pure rollup helpers (unit-testable; no IO)
// ============================================================

export interface AiUsageRollupBucket {
  key: string;
  events: number;
  errorEvents: number;
  retryEvents: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Sum of provider-reported costs (component; do not add to estimated for totals). */
  reportedCostMicroUsd: number;
  /** Sum of catalog estimates (component; may coexist with reported on dual-cost rows). */
  estimatedCostMicroUsd: number;
  /** Σ of per-event accounted cost (`reported ?? estimated ?? 0`). */
  effectiveCostMicroUsd: number;
  /** Events carrying a provider-reported cost. */
  reportedCostEvents: number;
  /** Events carrying a catalog estimate. */
  estimatedCostEvents: number;
  /** Events with both reported and estimated (comparison set). */
  comparableCostEvents: number;
}

export type AiUsageRollupDimension =
  | "day"
  | "tenant"
  | "provider"
  | "model"
  | "role"
  | "channel"
  | "turn"
  | "case"
  | "workflow_definition";

function rollupKey(event: AiUsageEvent, dimension: AiUsageRollupDimension): string {
  switch (dimension) {
    case "day":
      return event.occurred_at.slice(0, 10);
    case "tenant":
      return event.user_id;
    case "provider":
      return event.provider || "(none)";
    case "model":
      return event.model_id;
    case "role":
      return event.model_role;
    case "channel":
      return event.channel ?? "(none)";
    case "turn":
      return event.turn_id ?? "(none)";
    case "case":
      return event.operational_case_id ?? "(none)";
    case "workflow_definition":
      return event.workflow_definition_id ?? "(none)";
  }
}

/** Best-known / accounted cost of one event: reported wins, else estimate, else 0. */
export function effectiveCostMicroUsd(event: AiUsageEvent): number {
  return event.reported_cost_micro_usd ?? event.estimated_cost_micro_usd ?? 0;
}

export function rollupAiUsage(
  events: readonly AiUsageEvent[],
  dimension: AiUsageRollupDimension
): AiUsageRollupBucket[] {
  const buckets = new Map<string, AiUsageRollupBucket>();
  for (const event of events) {
    const key = rollupKey(event, dimension);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        key,
        events: 0,
        errorEvents: 0,
        retryEvents: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        reportedCostMicroUsd: 0,
        estimatedCostMicroUsd: 0,
        effectiveCostMicroUsd: 0,
        reportedCostEvents: 0,
        estimatedCostEvents: 0,
        comparableCostEvents: 0,
      };
      buckets.set(key, bucket);
    }
    bucket.events += 1;
    if (event.status === "error") bucket.errorEvents += 1;
    if (event.retry_ordinal > 0) bucket.retryEvents += 1;
    bucket.inputTokens += event.input_tokens ?? 0;
    bucket.outputTokens += event.output_tokens ?? 0;
    bucket.totalTokens += event.total_tokens ?? 0;
    if (event.reported_cost_micro_usd != null) {
      bucket.reportedCostMicroUsd += event.reported_cost_micro_usd;
      bucket.reportedCostEvents += 1;
    }
    if (event.estimated_cost_micro_usd != null) {
      bucket.estimatedCostMicroUsd += event.estimated_cost_micro_usd;
      bucket.estimatedCostEvents += 1;
    }
    if (
      event.reported_cost_micro_usd != null &&
      event.estimated_cost_micro_usd != null
    ) {
      bucket.comparableCostEvents += 1;
    }
    // Accounted cost is per-event; never sum reported+estimated columns.
    bucket.effectiveCostMicroUsd += effectiveCostMicroUsd(event);
  }
  return [...buckets.values()].sort(
    (a, b) => b.effectiveCostMicroUsd - a.effectiveCostMicroUsd
  );
}

/** Σ of accounted cost across events (never double-counts reported+estimated). */
export function totalEffectiveCostMicroUsd(
  events: readonly AiUsageEvent[]
): number {
  let total = 0;
  for (const event of events) total += effectiveCostMicroUsd(event);
  return total;
}

/**
 * Split of accounted cost for UI: how much came from provider vs catalog
 * fallback. Per-event: reported XOR estimated contributes to accounted.
 */
export function effectiveCostSplitMicroUsd(events: readonly AiUsageEvent[]): {
  fromReported: number;
  fromEstimated: number;
} {
  let fromReported = 0;
  let fromEstimated = 0;
  for (const event of events) {
    if (event.reported_cost_micro_usd != null) {
      fromReported += event.reported_cost_micro_usd;
    } else if (event.estimated_cost_micro_usd != null) {
      fromEstimated += event.estimated_cost_micro_usd;
    }
  }
  return { fromReported, fromEstimated };
}

export interface AiUsageCostComparison {
  reported: number;
  estimated: number;
  delta: number;
  /** (reported - estimated) / estimated; null when estimated is 0. */
  deltaPct: number | null;
}

/** Comparison only when both costs are present on the same event. */
export function costComparisonMicroUsd(
  event: AiUsageEvent
): AiUsageCostComparison | null {
  if (
    event.reported_cost_micro_usd == null ||
    event.estimated_cost_micro_usd == null
  ) {
    return null;
  }
  const reported = event.reported_cost_micro_usd;
  const estimated = event.estimated_cost_micro_usd;
  const delta = reported - estimated;
  return {
    reported,
    estimated,
    delta,
    deltaPct: estimated === 0 ? null : delta / estimated,
  };
}

/** Aggregate comparison across dual-cost events only. */
export function aggregateCostComparisonMicroUsd(
  events: readonly AiUsageEvent[]
): {
  comparableEvents: number;
  reported: number;
  estimated: number;
  delta: number;
  deltaPct: number | null;
} | null {
  let comparableEvents = 0;
  let reported = 0;
  let estimated = 0;
  for (const event of events) {
    const cmp = costComparisonMicroUsd(event);
    if (!cmp) continue;
    comparableEvents += 1;
    reported += cmp.reported;
    estimated += cmp.estimated;
  }
  if (comparableEvents === 0) return null;
  const delta = reported - estimated;
  return {
    comparableEvents,
    reported,
    estimated,
    delta,
    deltaPct: estimated === 0 ? null : delta / estimated,
  };
}

/** Top N most expensive calls (accounted cost). */
export function mostExpensiveAiUsageEvents(
  events: readonly AiUsageEvent[],
  limit = 10
): AiUsageEvent[] {
  return [...events]
    .sort((a, b) => effectiveCostMicroUsd(b) - effectiveCostMicroUsd(a))
    .slice(0, Math.max(1, limit));
}

/** Fraction of events with a provider-reported cost (0..1; null if empty). */
export function reportedCostCoverage(
  events: readonly AiUsageEvent[]
): number | null {
  if (events.length === 0) return null;
  const covered = events.filter(
    (event) => event.reported_cost_micro_usd != null
  ).length;
  return covered / events.length;
}

/** Count of events with provider-reported cost. */
export function reportedCostEventCount(events: readonly AiUsageEvent[]): number {
  return events.filter((event) => event.reported_cost_micro_usd != null).length;
}

/** Count of events with a catalog estimate stamped. */
export function estimatedCostEventCount(events: readonly AiUsageEvent[]): number {
  return events.filter((event) => event.estimated_cost_micro_usd != null).length;
}

/** Fraction of events with a catalog estimate (0..1; null if empty). */
export function estimatedCostCoverage(
  events: readonly AiUsageEvent[]
): number | null {
  if (events.length === 0) return null;
  return estimatedCostEventCount(events) / events.length;
}

/**
 * Events missing a catalog estimate despite having enough signal to expect
 * one (model call with tokens). Useful for dashboard gap alerts.
 */
export function eventsMissingCatalogEstimate(
  events: readonly AiUsageEvent[]
): AiUsageEvent[] {
  return events.filter((event) => {
    if (event.estimated_cost_micro_usd != null) return false;
    const hasTokens =
      event.input_tokens != null || event.output_tokens != null;
    return hasTokens;
  });
}

/**
 * Fraction of accounted cost that came from provider-reported figures
 * (0..1; null when accounted total is 0).
 */
export function reportedCostMoneyCoverage(
  events: readonly AiUsageEvent[]
): number | null {
  const total = totalEffectiveCostMicroUsd(events);
  if (total <= 0) return null;
  return effectiveCostSplitMicroUsd(events).fromReported / total;
}

/**
 * Formats integer micro-USD for display. Tiny non-zero amounts keep more
 * decimals so embeddings (~$0.000001) do not render as `$0.0000`.
 */
export function formatUsdFromMicro(microUsd: number): string {
  if (!Number.isFinite(microUsd) || microUsd === 0) return "$0";
  const usd = microUsd / 1_000_000;
  const abs = Math.abs(usd);
  if (abs >= 0.0001) return `$${usd.toFixed(4)}`;
  if (abs >= 0.000001) return `$${usd.toFixed(6)}`;
  return `<$0.000001`;
}

export type AiUsageOccurredAtPrecision = "minute" | "second";

/**
 * Formats an ISO timestamp in an IANA timezone as `yyyy-mm-dd HH:mm`
 * (or `yyyy-mm-dd HH:mm:ss` when `precision: "second"`).
 * Invalid/empty timezone falls back to UTC.
 */
export function formatAiUsageOccurredAt(
  iso: string,
  timeZone: string | null | undefined,
  options?: { precision?: AiUsageOccurredAtPrecision }
): string {
  const precision = options?.precision ?? "minute";
  const tz =
    typeof timeZone === "string" && timeZone.trim() ? timeZone.trim() : "UTC";
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso;
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      ...(precision === "second" ? { second: "2-digit" as const } : {}),
      hour12: false,
    }).formatToParts(date);
    const get = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((p) => p.type === type)?.value ?? "";
    const hour = get("hour") === "24" ? "00" : get("hour");
    const base = `${get("year")}-${get("month")}-${get("day")} ${hour}:${get("minute")}`;
    return precision === "second" ? `${base}:${get("second")}` : base;
  } catch {
    return formatAiUsageOccurredAt(iso, "UTC", options);
  }
}

/** One AI-function slice inside an execution or uncorrelated group. */
export interface AiUsageFunctionBreakdown {
  modelRole: string;
  provider: string;
  modelId: string;
  operation: string;
  events: number;
  inputTokens: number;
  outputTokens: number;
  effectiveCostMicroUsd: number;
  reportedCostMicroUsd: number;
  estimatedCostMicroUsd: number;
}

/**
 * Correlated unit keyed by `turn_id` (UI: "ejecución"). Includes every model
 * call sharing that id — not only `main_agent`.
 */
export interface AiUsageExecutionSummary {
  turnId: string;
  userId: string;
  channel: string | null;
  operationalCaseId: string | null;
  /** Earliest event timestamp (ISO, full precision). */
  startedAt: string;
  /** Latest event timestamp (ISO, full precision). */
  lastOccurredAt: string;
  events: number;
  inputTokens: number;
  outputTokens: number;
  effectiveCostMicroUsd: number;
  reportedCostMicroUsd: number;
  estimatedCostMicroUsd: number;
  byFunction: AiUsageFunctionBreakdown[];
}

export interface AiUsageCaseSummary {
  operationalCaseId: string;
  userId: string;
  events: number;
  executionCount: number;
  firstOccurredAt: string;
  lastOccurredAt: string;
  effectiveCostMicroUsd: number;
  reportedCostMicroUsd: number;
  estimatedCostMicroUsd: number;
}

/** Events with `turn_id = null` for a tenant (background / uncorrelated). */
export interface AiUsageUncorrelatedGroup {
  events: number;
  inputTokens: number;
  outputTokens: number;
  effectiveCostMicroUsd: number;
  reportedCostMicroUsd: number;
  estimatedCostMicroUsd: number;
  byFunction: AiUsageFunctionBreakdown[];
  byChannel: AiUsageRollupBucket[];
}

export interface AiUsageTenantSection {
  userId: string;
  summary: AiUsageRollupBucket;
  executions: AiUsageExecutionSummary[];
  cases: AiUsageCaseSummary[];
  uncorrelated: AiUsageUncorrelatedGroup | null;
}

function emptyRollupBucket(key: string): AiUsageRollupBucket {
  return {
    key,
    events: 0,
    errorEvents: 0,
    retryEvents: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    reportedCostMicroUsd: 0,
    estimatedCostMicroUsd: 0,
    effectiveCostMicroUsd: 0,
    reportedCostEvents: 0,
    estimatedCostEvents: 0,
    comparableCostEvents: 0,
  };
}

function functionBreakdownKey(event: AiUsageEvent): string {
  return [
    event.model_role,
    event.provider || "(none)",
    event.model_id,
    event.operation,
  ].join("\0");
}

export function summarizeAiUsageByFunction(
  events: readonly AiUsageEvent[]
): AiUsageFunctionBreakdown[] {
  const map = new Map<
    string,
    AiUsageFunctionBreakdown & { _key: string }
  >();
  for (const event of events) {
    const key = functionBreakdownKey(event);
    let row = map.get(key);
    if (!row) {
      row = {
        _key: key,
        modelRole: event.model_role,
        provider: event.provider || "(none)",
        modelId: event.model_id,
        operation: event.operation,
        events: 0,
        inputTokens: 0,
        outputTokens: 0,
        effectiveCostMicroUsd: 0,
        reportedCostMicroUsd: 0,
        estimatedCostMicroUsd: 0,
      };
      map.set(key, row);
    }
    row.events += 1;
    row.inputTokens += event.input_tokens ?? 0;
    row.outputTokens += event.output_tokens ?? 0;
    row.effectiveCostMicroUsd += effectiveCostMicroUsd(event);
    row.reportedCostMicroUsd += event.reported_cost_micro_usd ?? 0;
    row.estimatedCostMicroUsd += event.estimated_cost_micro_usd ?? 0;
  }
  return [...map.values()]
    .map(({ _key: _ignored, ...rest }) => rest)
    .sort((a, b) => b.effectiveCostMicroUsd - a.effectiveCostMicroUsd);
}

function pickChannel(channels: Set<string>): string | null {
  if (channels.size === 1) return [...channels][0]!;
  if (channels.size > 1) return "mixed";
  return null;
}

function pickCaseId(caseIds: Set<string>): string | null {
  return caseIds.size === 1 ? [...caseIds][0]! : null;
}

/**
 * Full list of correlated executions (no truncation — paginate in UI).
 * Default sort: most recent `lastOccurredAt` first (ISO/epoch full precision).
 */
export function summarizeAiUsageExecutions(
  events: readonly AiUsageEvent[]
): AiUsageExecutionSummary[] {
  const byTurn = new Map<
    string,
    {
      userId: string;
      channels: Set<string>;
      caseIds: Set<string>;
      startedAt: string;
      lastOccurredAt: string;
      events: AiUsageEvent[];
    }
  >();
  for (const event of events) {
    const turnId = event.turn_id;
    if (!turnId) continue;
    let row = byTurn.get(turnId);
    if (!row) {
      row = {
        userId: event.user_id,
        channels: new Set(),
        caseIds: new Set(),
        startedAt: event.occurred_at,
        lastOccurredAt: event.occurred_at,
        events: [],
      };
      byTurn.set(turnId, row);
    }
    row.events.push(event);
    if (event.channel) row.channels.add(event.channel);
    if (event.operational_case_id) row.caseIds.add(event.operational_case_id);
    if (event.occurred_at < row.startedAt) row.startedAt = event.occurred_at;
    if (event.occurred_at > row.lastOccurredAt) {
      row.lastOccurredAt = event.occurred_at;
    }
  }
  return [...byTurn.entries()]
    .map(([turnId, row]) => {
      let effective = 0;
      let reported = 0;
      let estimated = 0;
      let inputTokens = 0;
      let outputTokens = 0;
      for (const event of row.events) {
        effective += effectiveCostMicroUsd(event);
        reported += event.reported_cost_micro_usd ?? 0;
        estimated += event.estimated_cost_micro_usd ?? 0;
        inputTokens += event.input_tokens ?? 0;
        outputTokens += event.output_tokens ?? 0;
      }
      return {
        turnId,
        userId: row.userId,
        channel: pickChannel(row.channels),
        operationalCaseId: pickCaseId(row.caseIds),
        startedAt: row.startedAt,
        lastOccurredAt: row.lastOccurredAt,
        events: row.events.length,
        inputTokens,
        outputTokens,
        effectiveCostMicroUsd: effective,
        reportedCostMicroUsd: reported,
        estimatedCostMicroUsd: estimated,
        byFunction: summarizeAiUsageByFunction(row.events),
      };
    })
    .sort((a, b) => {
      const byTime = b.lastOccurredAt.localeCompare(a.lastOccurredAt);
      if (byTime !== 0) return byTime;
      return b.effectiveCostMicroUsd - a.effectiveCostMicroUsd;
    });
}

/** Full list of operational-case instances (no truncation). */
export function summarizeAiUsageCases(
  events: readonly AiUsageEvent[]
): AiUsageCaseSummary[] {
  const byCase = new Map<
    string,
    {
      userId: string;
      events: number;
      turnIds: Set<string>;
      firstOccurredAt: string;
      lastOccurredAt: string;
      effectiveCostMicroUsd: number;
      reportedCostMicroUsd: number;
      estimatedCostMicroUsd: number;
    }
  >();
  for (const event of events) {
    const caseId = event.operational_case_id;
    if (!caseId) continue;
    let row = byCase.get(caseId);
    if (!row) {
      row = {
        userId: event.user_id,
        events: 0,
        turnIds: new Set(),
        firstOccurredAt: event.occurred_at,
        lastOccurredAt: event.occurred_at,
        effectiveCostMicroUsd: 0,
        reportedCostMicroUsd: 0,
        estimatedCostMicroUsd: 0,
      };
      byCase.set(caseId, row);
    }
    row.events += 1;
    row.effectiveCostMicroUsd += effectiveCostMicroUsd(event);
    row.reportedCostMicroUsd += event.reported_cost_micro_usd ?? 0;
    row.estimatedCostMicroUsd += event.estimated_cost_micro_usd ?? 0;
    if (event.turn_id) row.turnIds.add(event.turn_id);
    if (event.occurred_at < row.firstOccurredAt) {
      row.firstOccurredAt = event.occurred_at;
    }
    if (event.occurred_at > row.lastOccurredAt) {
      row.lastOccurredAt = event.occurred_at;
    }
  }
  return [...byCase.entries()]
    .map(([operationalCaseId, row]) => ({
      operationalCaseId,
      userId: row.userId,
      events: row.events,
      executionCount: row.turnIds.size,
      firstOccurredAt: row.firstOccurredAt,
      lastOccurredAt: row.lastOccurredAt,
      effectiveCostMicroUsd: row.effectiveCostMicroUsd,
      reportedCostMicroUsd: row.reportedCostMicroUsd,
      estimatedCostMicroUsd: row.estimatedCostMicroUsd,
    }))
    .sort((a, b) => {
      const byTime = b.lastOccurredAt.localeCompare(a.lastOccurredAt);
      if (byTime !== 0) return byTime;
      return b.effectiveCostMicroUsd - a.effectiveCostMicroUsd;
    });
}

export function summarizeAiUsageUncorrelated(
  events: readonly AiUsageEvent[]
): AiUsageUncorrelatedGroup | null {
  const uncorrelated = events.filter((event) => !event.turn_id);
  if (uncorrelated.length === 0) return null;
  let effective = 0;
  let reported = 0;
  let estimated = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const event of uncorrelated) {
    effective += effectiveCostMicroUsd(event);
    reported += event.reported_cost_micro_usd ?? 0;
    estimated += event.estimated_cost_micro_usd ?? 0;
    inputTokens += event.input_tokens ?? 0;
    outputTokens += event.output_tokens ?? 0;
  }
  return {
    events: uncorrelated.length,
    inputTokens,
    outputTokens,
    effectiveCostMicroUsd: effective,
    reportedCostMicroUsd: reported,
    estimatedCostMicroUsd: estimated,
    byFunction: summarizeAiUsageByFunction(uncorrelated),
    byChannel: rollupAiUsage(uncorrelated, "channel"),
  };
}

/**
 * Groups events by tenant: account summary, full execution/case lists, and
 * uncorrelated (`turn_id` null) group. No truncation — paginate in UI.
 */
export function buildAiUsageTenantSections(
  events: readonly AiUsageEvent[]
): AiUsageTenantSection[] {
  const byUser = new Map<string, AiUsageEvent[]>();
  for (const event of events) {
    const list = byUser.get(event.user_id);
    if (list) list.push(event);
    else byUser.set(event.user_id, [event]);
  }

  const sections: AiUsageTenantSection[] = [];
  for (const [userId, tenantEvents] of byUser) {
    const tenantBuckets = rollupAiUsage(tenantEvents, "tenant");
    sections.push({
      userId,
      summary: tenantBuckets[0] ?? emptyRollupBucket(userId),
      executions: summarizeAiUsageExecutions(tenantEvents),
      cases: summarizeAiUsageCases(tenantEvents),
      uncorrelated: summarizeAiUsageUncorrelated(tenantEvents),
    });
  }

  return sections.sort(
    (a, b) => b.summary.effectiveCostMicroUsd - a.summary.effectiveCostMicroUsd
  );
}

export type AiUsageCostSort = "cost" | "events" | "name";
export type AiUsageRecencySort = "recent" | "cost";

export function sortRollupBuckets(
  buckets: readonly AiUsageRollupBucket[],
  sort: AiUsageCostSort
): AiUsageRollupBucket[] {
  const copy = [...buckets];
  switch (sort) {
    case "events":
      return copy.sort(
        (a, b) => b.events - a.events || a.key.localeCompare(b.key)
      );
    case "name":
      return copy.sort((a, b) => a.key.localeCompare(b.key));
    case "cost":
    default:
      return copy.sort(
        (a, b) =>
          b.effectiveCostMicroUsd - a.effectiveCostMicroUsd ||
          a.key.localeCompare(b.key)
      );
  }
}

export function sortExecutions(
  executions: readonly AiUsageExecutionSummary[],
  sort: AiUsageRecencySort
): AiUsageExecutionSummary[] {
  const copy = [...executions];
  if (sort === "cost") {
    return copy.sort(
      (a, b) =>
        b.effectiveCostMicroUsd - a.effectiveCostMicroUsd ||
        b.lastOccurredAt.localeCompare(a.lastOccurredAt)
    );
  }
  return copy.sort(
    (a, b) =>
      b.lastOccurredAt.localeCompare(a.lastOccurredAt) ||
      b.effectiveCostMicroUsd - a.effectiveCostMicroUsd
  );
}

export function sortCases(
  cases: readonly AiUsageCaseSummary[],
  sort: AiUsageRecencySort
): AiUsageCaseSummary[] {
  const copy = [...cases];
  if (sort === "cost") {
    return copy.sort(
      (a, b) =>
        b.effectiveCostMicroUsd - a.effectiveCostMicroUsd ||
        b.lastOccurredAt.localeCompare(a.lastOccurredAt)
    );
  }
  return copy.sort(
    (a, b) =>
      b.lastOccurredAt.localeCompare(a.lastOccurredAt) ||
      b.effectiveCostMicroUsd - a.effectiveCostMicroUsd
  );
}

export interface AiUsagePageSlice<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export function paginateItems<T>(
  items: readonly T[],
  page: number,
  pageSize: number
): AiUsagePageSlice<T> {
  const size = [10, 25, 50].includes(pageSize) ? pageSize : 10;
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / size) || 1);
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * size;
  return {
    items: items.slice(start, start + size),
    total,
    page: safePage,
    pageSize: size,
    totalPages,
  };
}

/** Client-side filter over ledger rows (period is applied server-side). */
export interface AiUsageEventFilters {
  userId?: string | null;
  provider?: string | null;
  channel?: string | null;
  modelRole?: string | null;
  modelId?: string | null;
  status?: string | null;
}

export function filterAiUsageEvents(
  events: readonly AiUsageEvent[],
  filters: AiUsageEventFilters
): AiUsageEvent[] {
  return events.filter((event) => {
    if (filters.userId && event.user_id !== filters.userId) return false;
    if (filters.provider && event.provider !== filters.provider) return false;
    if (filters.channel) {
      const channel = event.channel ?? "(none)";
      if (channel !== filters.channel) return false;
    }
    if (filters.modelRole && event.model_role !== filters.modelRole) {
      return false;
    }
    if (filters.modelId && event.model_id !== filters.modelId) return false;
    if (filters.status && event.status !== filters.status) return false;
    return true;
  });
}
