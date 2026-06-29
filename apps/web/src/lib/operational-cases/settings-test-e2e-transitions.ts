import type { OperationalCaseEvent, ToolCall } from "@agents/types";

export type E2ETransitionGroup = {
  index: number;
  startedAt: string;
  stepKey: string | null;
  stepLabel: string | null;
  events: OperationalCaseEvent[];
  toolCalls: ToolCall[];
};

export type E2ETransitionStepSubgroup = {
  stepKey: string | null;
  stepLabel: string;
  bucket: "authoritative" | "legacy";
  events: OperationalCaseEvent[];
  toolCalls: ToolCall[];
};

export type E2ETransitionTimelineItem =
  | { kind: "event"; id: string; created_at: string; event: OperationalCaseEvent }
  | { kind: "tool"; id: string; created_at: string; call: ToolCall };

function compareActivityChronologically(
  a: { created_at: string; id: string },
  b: { created_at: string; id: string }
): number {
  return (
    new Date(a.created_at).getTime() - new Date(b.created_at).getTime() ||
    a.id.localeCompare(b.id)
  );
}

/** Infer the operational step after a transition window from state change events. */
export function inferE2ETransitionStepAfter(
  group: Pick<E2ETransitionGroup, "stepKey" | "events">
): string | null {
  let stepAfter = group.stepKey;
  const chronological = [...group.events].sort(compareActivityChronologically);
  for (const event of chronological) {
    const payload = event.payload_jsonb as Record<string, unknown> | null;
    if (!payload) continue;
    const to = payload.to;
    if (!to || typeof to !== "object" || Array.isArray(to)) continue;
    const step = (to as Record<string, unknown>).current_step;
    if (typeof step === "string" && step.trim()) {
      stepAfter = step.trim();
    }
  }
  return stepAfter;
}

export function formatE2ETransitionGroupTitle(params: {
  index: number;
  stepBefore: string | null;
  stepAfter: string | null;
  stepLabels?: Record<string, string>;
}): string {
  const label = (key: string | null) => {
    if (!key) return null;
    return params.stepLabels?.[key] ?? key;
  };
  const before = label(params.stepBefore);
  const after = label(params.stepAfter);
  if (before && after && before !== after) {
    return `Transición ${params.index} · ${before} → ${after}`;
  }
  if (before) {
    return `Transición ${params.index} · ${before}`;
  }
  return `Transición ${params.index}`;
}

export function buildE2ETransitionSubgroupTimeline(
  subgroup: E2ETransitionStepSubgroup
): E2ETransitionTimelineItem[] {
  return [
    ...subgroup.events.map(
      (event): E2ETransitionTimelineItem => ({
        kind: "event",
        id: event.id,
        created_at: event.created_at,
        event,
      })
    ),
    ...subgroup.toolCalls.map(
      (call): E2ETransitionTimelineItem => ({
        kind: "tool",
        id: call.id,
        created_at: call.created_at,
        call,
      })
    ),
  ].sort(compareActivityChronologically);
}

export function filterActivitySincePlaythroughAnchor<T extends { created_at: string }>(
  items: T[],
  anchorAt: string | null
): T[] {
  if (!anchorAt) return items;
  const anchorMs = new Date(anchorAt).getTime();
  return items.filter((item) => new Date(item.created_at).getTime() > anchorMs);
}

function isE2EStartedEvent(event: OperationalCaseEvent): boolean {
  const payload = event.payload_jsonb as Record<string, unknown> | null;
  return payload?.kind === "controlled_test_e2e_started";
}

/** Eventos de laboratorio que no pertenecen al efecto de una transición E2E. */
function isLabNoiseEvent(event: OperationalCaseEvent): boolean {
  const payload = event.payload_jsonb as Record<string, unknown> | null;
  const kind = payload?.kind;
  return (
    kind === "controlled_test_lab_cycle_reset" ||
    kind === "controlled_test_cycle_reset"
  );
}

function e2eStepKeyFromEvent(event: OperationalCaseEvent): string | null {
  const payload = event.payload_jsonb as Record<string, unknown> | null;
  const step = payload?.current_step;
  return typeof step === "string" && step.trim() ? step.trim() : null;
}

function authoritativeEventStepKey(event: OperationalCaseEvent): string | null {
  const payload = event.payload_jsonb as Record<string, unknown> | null;
  const step = payload?.step_key;
  return typeof step === "string" && step.trim() ? step.trim() : null;
}

function authoritativeToolCallStepKey(call: ToolCall): string | null {
  const value = call.metadata_jsonb?.operational_step_key;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function subgroupEarliestActivityMs(subgroup: E2ETransitionStepSubgroup): number {
  const times = [
    ...subgroup.events.map((event) => new Date(event.created_at).getTime()),
    ...subgroup.toolCalls.map((call) => new Date(call.created_at).getTime()),
  ].filter(Number.isFinite);
  return times.length > 0 ? Math.min(...times) : Number.POSITIVE_INFINITY;
}

export const UNATTRIBUTED_E2E_STEP_SUBGROUP_LABEL =
  "Actividad sin paso asociado";

/**
 * Within one transition window, subgroups activity by authoritative operational step.
 * Events/tools without authoritative step metadata go to an unclassified bucket.
 */
export function buildE2ETransitionStepSubgroups(params: {
  group: E2ETransitionGroup;
  stepLabels?: Record<string, string>;
}): E2ETransitionStepSubgroup[] {
  const map = new Map<string, E2ETransitionStepSubgroup>();
  const upsert = (stepKey: string | null, bucket: "authoritative" | "legacy") => {
    const normalizedStepKey = stepKey && stepKey.trim() ? stepKey.trim() : null;
    const key = normalizedStepKey ? `step:${normalizedStepKey}` : "legacy";
    const existing = map.get(key);
    if (existing) return existing;
    const stepLabel = normalizedStepKey
      ? (params.stepLabels?.[normalizedStepKey] ?? normalizedStepKey)
      : UNATTRIBUTED_E2E_STEP_SUBGROUP_LABEL;
    const created: E2ETransitionStepSubgroup = {
      stepKey: normalizedStepKey,
      stepLabel,
      bucket,
      events: [],
      toolCalls: [],
    };
    map.set(key, created);
    return created;
  };

  for (const event of params.group.events) {
    const stepKey = authoritativeEventStepKey(event);
    const subgroup = upsert(stepKey, stepKey ? "authoritative" : "legacy");
    subgroup.events.push(event);
  }
  for (const toolCall of params.group.toolCalls) {
    const stepKey = authoritativeToolCallStepKey(toolCall);
    const subgroup = upsert(stepKey, stepKey ? "authoritative" : "legacy");
    subgroup.toolCalls.push(toolCall);
  }

  return Array.from(map.values()).sort((a, b) => {
    const timeDiff = subgroupEarliestActivityMs(a) - subgroupEarliestActivityMs(b);
    if (timeDiff !== 0) return timeDiff;
    if (a.stepLabel === b.stepLabel) return 0;
    return a.stepLabel.localeCompare(b.stepLabel, "es");
  });
}

/**
 * Groups events and tool calls by manual E2E transition (each controlled_test_e2e_started).
 * Items between two starts belong to the earlier transition; items after the last start
 * belong to the final open group.
 */
export function buildE2ETransitionGroups(params: {
  events: OperationalCaseEvent[];
  toolCalls: ToolCall[];
  anchorAt?: string | null;
  /** Arranques E2E desde BD (alineado con el contador del laboratorio). */
  e2eStartEvents?: OperationalCaseEvent[];
  stepLabels?: Record<string, string>;
}): E2ETransitionGroup[] {
  const events = filterActivitySincePlaythroughAnchor(
    params.events,
    params.anchorAt ?? null
  );
  const toolCalls = filterActivitySincePlaythroughAnchor(
    params.toolCalls,
    params.anchorAt ?? null
  );

  const e2eStarts = (
    params.e2eStartEvents?.length
      ? [...params.e2eStartEvents]
      : [...events].filter(isE2EStartedEvent)
  ).sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );

  if (e2eStarts.length === 0) {
    return [];
  }

  const groups: E2ETransitionGroup[] = [];

  for (let i = 0; i < e2eStarts.length; i++) {
    const start = e2eStarts[i]!;
    const nextStart = e2eStarts[i + 1];
    const windowStartMs = new Date(start.created_at).getTime();
    const windowEndMs = nextStart
      ? new Date(nextStart.created_at).getTime()
      : Number.POSITIVE_INFINITY;

    const groupEvents = events.filter((event) => {
      if (isLabNoiseEvent(event)) return false;
      const ms = new Date(event.created_at).getTime();
      return ms >= windowStartMs && ms < windowEndMs;
    });

    const groupTools = toolCalls.filter((call) => {
      const ms = new Date(call.created_at).getTime();
      return ms >= windowStartMs && ms < windowEndMs;
    });

    const stepKey = e2eStepKeyFromEvent(start);
    groups.push({
      index: i + 1,
      startedAt: start.created_at,
      stepKey,
      stepLabel: stepKey
        ? (params.stepLabels?.[stepKey] ?? stepKey)
        : null,
      events: groupEvents.sort(compareActivityChronologically),
      toolCalls: groupTools.sort(compareActivityChronologically),
    });
  }

  return groups;
}

export type LastE2ETransitionOutcome = {
  step_before: string | null;
  step_after: string | null;
  status_before: string | null;
  status_after: string | null;
  step_advanced: boolean;
  response_preview: string | null;
  pending_confirmation: boolean;
};

export function buildLastE2ETransitionOutcome(params: {
  stepBefore: string | null | undefined;
  stepAfter: string | null | undefined;
  statusBefore: string | null | undefined;
  statusAfter: string | null | undefined;
  responsePreview?: string | null;
  pendingConfirmation?: boolean;
}): LastE2ETransitionOutcome {
  const stepBefore = params.stepBefore ?? null;
  const stepAfter = params.stepAfter ?? null;
  return {
    step_before: stepBefore,
    step_after: stepAfter,
    status_before: params.statusBefore ?? null,
    status_after: params.statusAfter ?? null,
    step_advanced: Boolean(
      stepBefore && stepAfter && stepBefore !== stepAfter
    ),
    response_preview: params.responsePreview ?? null,
    pending_confirmation: Boolean(params.pendingConfirmation),
  };
}
