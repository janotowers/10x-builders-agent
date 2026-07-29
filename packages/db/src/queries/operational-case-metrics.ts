/**
 * Read-only operational-case metrics (flexible-workflows plan, Slice 0.4
 * task 1). Derives step durations and volumes from the timestamps that
 * `operational_case_events` already records — no schema changes, no writes.
 *
 * Tenancy: every IO helper takes a required `userId`; admin-wide reads
 * require an explicit `adminWide: true` that callers may only set after
 * verifying `profiles.is_ungga_admin`.
 */
import type { DbClient } from "../client";

export interface CaseStepTimelineEvent {
  case_id: string;
  event_type: string;
  step_key: string | null;
  created_at: string;
  payload_jsonb?: Record<string, unknown> | null;
}

export interface StepDurationSample {
  caseId: string;
  stepKey: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
}

export interface StepDurationRollup {
  stepKey: string;
  samples: number;
  totalMs: number;
  meanMs: number;
  minMs: number;
  maxMs: number;
}

/**
 * Pure: turns one case's ordered event stream into per-step duration samples.
 * A step "starts" at the first event that lands on a new `step_key` (state
 * changes and step completions carry it) and "ends" when a later event lands
 * on a different one.
 */
export function deriveStepDurationSamples(
  events: readonly CaseStepTimelineEvent[]
): StepDurationSample[] {
  const byCase = new Map<string, CaseStepTimelineEvent[]>();
  for (const event of events) {
    if (!event.step_key) continue;
    const list = byCase.get(event.case_id) ?? [];
    list.push(event);
    byCase.set(event.case_id, list);
  }
  const samples: StepDurationSample[] = [];
  for (const [caseId, caseEvents] of byCase) {
    const ordered = [...caseEvents].sort((a, b) =>
      a.created_at.localeCompare(b.created_at)
    );
    let currentStep: string | null = null;
    let currentStart: string | null = null;
    for (const event of ordered) {
      const step = event.step_key!;
      if (step === currentStep) continue;
      if (currentStep && currentStart) {
        const durationMs =
          new Date(event.created_at).getTime() - new Date(currentStart).getTime();
        if (durationMs >= 0) {
          samples.push({
            caseId,
            stepKey: currentStep,
            startedAt: currentStart,
            endedAt: event.created_at,
            durationMs,
          });
        }
      }
      currentStep = step;
      currentStart = event.created_at;
    }
  }
  return samples;
}

/** Pure: aggregates duration samples per step. */
export function rollupStepDurations(
  samples: readonly StepDurationSample[]
): StepDurationRollup[] {
  const byStep = new Map<string, StepDurationSample[]>();
  for (const sample of samples) {
    const list = byStep.get(sample.stepKey) ?? [];
    list.push(sample);
    byStep.set(sample.stepKey, list);
  }
  return [...byStep.entries()]
    .map(([stepKey, stepSamples]) => {
      const totalMs = stepSamples.reduce((sum, s) => sum + s.durationMs, 0);
      return {
        stepKey,
        samples: stepSamples.length,
        totalMs,
        meanMs: Math.round(totalMs / stepSamples.length),
        minMs: Math.min(...stepSamples.map((s) => s.durationMs)),
        maxMs: Math.max(...stepSamples.map((s) => s.durationMs)),
      };
    })
    .sort((a, b) => b.totalMs - a.totalMs);
}

export interface CaseMetricsParams {
  userId: string;
  /** Requires a prior `is_ungga_admin` check by the caller. */
  adminWide?: boolean;
  sinceIso?: string;
  limit?: number;
}

/**
 * Fetches the step-bearing event timeline for the tenant's cases (join via
 * `operational_cases.user_id` — events carry no tenant column of their own).
 */
export async function listCaseStepTimelineEvents(
  db: DbClient,
  params: CaseMetricsParams
): Promise<CaseStepTimelineEvent[]> {
  if (!params.userId) {
    throw new Error("listCaseStepTimelineEvents: userId is required");
  }
  let query = db
    .from("operational_case_events")
    .select(
      "case_id, event_type, payload_jsonb, created_at, operational_cases!inner(user_id)"
    )
    .order("created_at", { ascending: true })
    .limit(Math.min(Math.max(params.limit ?? 5000, 1), 20_000));
  if (!params.adminWide) {
    query = query.eq("operational_cases.user_id", params.userId);
  }
  if (params.sinceIso) query = query.gte("created_at", params.sinceIso);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).map((row) => {
    const record = row as Record<string, unknown>;
    // `step_key` autoritativo vive en payload_jsonb.step_key (ver
    // insertOperationalCaseEvent); no hay columna dedicada.
    const payload =
      record.payload_jsonb && typeof record.payload_jsonb === "object"
        ? (record.payload_jsonb as Record<string, unknown>)
        : null;
    const stepKey =
      payload && typeof payload.step_key === "string" && payload.step_key.trim()
        ? payload.step_key.trim()
        : null;
    return {
      case_id: record.case_id as string,
      event_type: record.event_type as string,
      step_key: stepKey,
      created_at: record.created_at as string,
    };
  });
}

/** Convenience: step-duration rollup for a tenant (or admin-wide). */
export async function getStepDurationRollup(
  db: DbClient,
  params: CaseMetricsParams
): Promise<StepDurationRollup[]> {
  const events = await listCaseStepTimelineEvents(db, params);
  return rollupStepDurations(deriveStepDurationSamples(events));
}
