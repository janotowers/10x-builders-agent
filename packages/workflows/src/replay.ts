import type { WorkflowGraph, WorkflowTransitionProposer } from "@agents/types";
import { evaluateTransition } from "./transition-evaluator";

/**
 * Historical replay (Slice 1.6 / Technical Plan §25): walks a case's
 * append-only event stream, re-evaluates every recorded step transition
 * against the pinned definition, and asserts the terminal state matches.
 *
 * History is truth: transitions are applied even when the evaluator marks
 * them illegal (those become divergences to triage), so the terminal-state
 * assertion is exact. Context facts are approximated with the case's final
 * context (intermediate snapshots are not persisted) — guards that read
 * context may report false divergences on early transitions; guards driven
 * by event history (external_response) replay exactly.
 */

export type ReplayEvent = {
  event_type: string;
  actor?: string | null;
  payload_jsonb?: unknown;
  created_at?: string;
};

export type ReplayTransition = {
  index: number;
  from: string | null;
  to: string;
  verdict: "legal" | "illegal" | "requires_approval";
  reason?: string;
  failedGuards: string[];
};

export type ReplayResult = {
  ok: boolean;
  terminalStep: string | null;
  expectedTerminalStep: string | null;
  transitions: ReplayTransition[];
  divergences: ReplayTransition[];
  /**
   * Times the recorded `from` step disagreed with the tracked state: the
   * event stream skipped recording one or more transitions (not every write
   * path appends from/to state events — §X hallazgo del replay histórico).
   */
  unrecordedGaps: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function proposerFromActor(actor: string | null | undefined): WorkflowTransitionProposer {
  if (actor === "user") return "decision_handler";
  if (actor === "system") return "runtime";
  return "model"; // "agent" and unknown actors
}

/** Extract the recorded step transition from an event payload, if any. */
function extractStep(payload: unknown, side: "from" | "to"): string | null {
  if (!isRecord(payload)) return null;
  const part = payload[side];
  if (
    isRecord(part) &&
    typeof part.current_step === "string" &&
    part.current_step
  ) {
    return part.current_step;
  }
  return null;
}

const EVENT_WINDOW = 30; // mirrors getRecentOperationalCaseEvents usage

export function replayCaseThroughDefinition(params: {
  graph: WorkflowGraph;
  caseType: string;
  events: ReplayEvent[];
  finalStep: string | null;
  finalContext?: Record<string, unknown> | null;
  initialStep?: string | null;
}): ReplayResult {
  const { graph, caseType, events } = params;
  let currentStep: string | null = params.initialStep ?? null;
  const windowTypes: string[] = [];
  const transitions: ReplayTransition[] = [];

  let unrecordedGaps = 0;
  events.forEach((event, index) => {
    const toStep = extractStep(event.payload_jsonb, "to");
    const fromStep = extractStep(event.payload_jsonb, "from");
    // Not every write path records from/to state events; when the recorded
    // `from` disagrees with the tracked state, re-anchor on the recorded
    // value so we only evaluate transitions the stream actually captured.
    if (fromStep && fromStep !== currentStep) {
      if (currentStep !== null) unrecordedGaps += 1;
      currentStep = fromStep;
    }
    if (toStep && toStep !== currentStep) {
      const verdict = evaluateTransition({
        graph,
        caseType,
        caseState: { currentStep, status: null },
        proposal: {
          toStep,
          // Status intent is not reliably recorded per event; omit it so the
          // completion_pairing guard evaluates only explicit published moves.
          toStatus: toStep === "published" ? "completed" : undefined,
          proposer: proposerFromActor(event.actor),
        },
        facts: {
          context: params.finalContext ?? {},
          recentEventTypes: windowTypes.slice(-EVENT_WINDOW),
        },
      });
      transitions.push({
        index,
        from: currentStep,
        to: toStep,
        verdict: verdict.verdict,
        reason: verdict.reason,
        failedGuards: verdict.guardResults
          .filter((guard) => !guard.pass)
          .map((guard) => guard.guard),
      });
      currentStep = toStep; // history is truth
    }
    windowTypes.push(event.event_type);
  });

  const divergences = transitions.filter((t) => t.verdict !== "legal");
  return {
    ok: currentStep === (params.finalStep ?? null),
    terminalStep: currentStep,
    expectedTerminalStep: params.finalStep ?? null,
    transitions,
    divergences,
    unrecordedGaps,
  };
}
