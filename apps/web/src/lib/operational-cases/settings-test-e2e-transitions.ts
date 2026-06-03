import type { OperationalCaseEvent, ToolCall } from "@agents/types";

export type E2ETransitionGroup = {
  index: number;
  startedAt: string;
  stepKey: string | null;
  stepLabel: string | null;
  events: OperationalCaseEvent[];
  toolCalls: ToolCall[];
};

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
      events: groupEvents.sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      ),
      toolCalls: groupTools.sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      ),
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
