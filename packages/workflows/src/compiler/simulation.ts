/**
 * Gate de simulación (Slice 4.2-3; Technical Plan §15 + Phase 5 fixes):
 * ejecuta el borrador contra casos sintéticos usando el harness de replay.
 *
 * Fixes Phase 5:
 *   - Happy path apunta a terminal de éxito (no al más cercano / cancelled).
 *   - Eventos sintéticos usan un proposer autorizado por transición.
 *   - Aprobaciones: sintetiza actor user cuando approval_required.
 *   - Propaga reason del evaluador a outcomes.
 */

import { registerBuiltinGuards } from "../guards/builtins";
import { replayCaseThroughDefinition, type ReplayEvent } from "../replay";
import type { WorkflowGraph, WorkflowTransitionProposer } from "@agents/types";
import type { CompilerGateResult } from "./validation-gates";

export type TerminalOutcomeKind = "success" | "cancelled" | "failed";

export interface SimulationScenario {
  key: string;
  label: string;
  events: ReplayEvent[];
  finalStep: string | null;
  finalContext?: Record<string, unknown> | null;
  initialStep?: string | null;
}

export interface SimulationScenarioOutcome {
  scenario: string;
  ok: boolean;
  terminalStep: string | null;
  expectedTerminalStep: string | null;
  divergences: Array<{
    from: string | null;
    to: string;
    verdict: string;
    reason?: string;
    failedGuards: string[];
  }>;
}

const CANCELLED_TERMINAL_PATTERN =
  /(descartad|cancel|abort|reject|rechaz|no_show|noshow|failed|fallid)/i;

export function classifyTerminalOutcome(stateKey: string): TerminalOutcomeKind {
  if (CANCELLED_TERMINAL_PATTERN.test(stateKey)) {
    if (/fail|fallid/i.test(stateKey)) return "failed";
    return "cancelled";
  }
  return "success";
}

function actorForProposer(
  proposer: WorkflowTransitionProposer
): "system" | "user" | "agent" {
  if (proposer === "runtime") return "system";
  if (proposer === "decision_handler") return "user";
  return "agent";
}

function pickAuthorizedProposer(
  proposers: WorkflowTransitionProposer[]
): WorkflowTransitionProposer {
  if (proposers.includes("runtime")) return "runtime";
  if (proposers.includes("model")) return "model";
  if (proposers.includes("decision_handler")) return "decision_handler";
  return "runtime";
}

function stepEvent(
  from: string | null,
  to: string,
  proposer: WorkflowTransitionProposer
): ReplayEvent {
  return {
    event_type: "case_updated",
    actor: actorForProposer(proposer),
    payload_jsonb: {
      ...(from ? { from: { current_step: from } } : {}),
      to: { current_step: to },
    },
  };
}

type Hop = {
  from: string;
  to: string;
  guards: string[];
  proposers: WorkflowTransitionProposer[];
  approvalRequired: string | null;
};

/** BFS del estado inicial a un terminal preferido (éxito > cualquier otro). */
function shortestPathToTerminal(
  graph: WorkflowGraph,
  preferSuccess: boolean
): Hop[] | null {
  const initial = graph.states[0]?.key;
  if (!initial) return null;
  const terminals = new Set([
    ...graph.completion.terminal_states,
    ...graph.states.filter((s) => s.kind === "terminal").map((s) => s.key),
  ]);
  const successTerminals = [...terminals].filter(
    (key) => classifyTerminalOutcome(key) === "success"
  );
  const targetSet =
    preferSuccess && successTerminals.length > 0
      ? new Set(successTerminals)
      : terminals;

  const cameFrom = new Map<string, Hop>();
  const queue = [initial];
  const seen = new Set([initial]);
  let reached: string | null = targetSet.has(initial) ? initial : null;
  while (queue.length > 0 && !reached) {
    const node = queue.shift() as string;
    for (const transition of graph.transitions) {
      if (transition.from !== node || seen.has(transition.to)) continue;
      seen.add(transition.to);
      cameFrom.set(transition.to, {
        from: node,
        to: transition.to,
        guards: transition.guards,
        proposers: transition.authorized_proposers,
        approvalRequired: transition.approval_required,
      });
      if (targetSet.has(transition.to)) {
        reached = transition.to;
        break;
      }
      queue.push(transition.to);
    }
  }
  if (!reached) {
    // Fallback: any terminal if no success path.
    if (preferSuccess) return shortestPathToTerminal(graph, false);
    return null;
  }
  const path: Hop[] = [];
  let cursor: string = reached;
  while (cursor !== initial) {
    const hop = cameFrom.get(cursor);
    if (!hop) return null;
    path.unshift(hop);
    cursor = hop.from;
  }
  return path;
}

/**
 * Escenario sintético de camino feliz hacia terminal de éxito.
 */
export function buildSyntheticHappyPathScenario(
  graph: WorkflowGraph
): SimulationScenario | null {
  const path = shortestPathToTerminal(graph, true);
  if (!path || path.length === 0) return null;

  const events: ReplayEvent[] = [];
  let needsComparablesContext = false;
  for (const hop of path) {
    if (hop.guards.includes("external_response_exists")) {
      events.push({
        event_type: "external_response",
        actor: "external_contact",
      });
    }
    if (hop.guards.includes("defensible_comparables_sample")) {
      needsComparablesContext = true;
    }
    let proposer = pickAuthorizedProposer(hop.proposers);
    if (hop.approvalRequired) {
      // Simulate human approval then the approved transition via decision_handler.
      events.push({
        event_type: "human_decision",
        actor: "user",
        payload_jsonb: {
          kind: hop.approvalRequired,
          decision: "approved",
        },
      });
      if (hop.proposers.includes("decision_handler")) {
        proposer = "decision_handler";
      }
    }
    events.push(stepEvent(hop.from, hop.to, proposer));
  }

  const finalStep = path[path.length - 1].to;
  return {
    key: "synthetic_happy_path",
    label: "Camino feliz sintético (inicial → terminal de éxito)",
    events,
    finalStep,
    initialStep: path[0].from,
    finalContext: needsComparablesContext
      ? {
          comparables_analysis: {
            data_quality: { unique_comparable_count: 3 },
          },
        }
      : null,
  };
}

export interface SimulationGateResult {
  gate: CompilerGateResult;
  outcomes: SimulationScenarioOutcome[];
}

export function runSimulationGate(params: {
  graph: WorkflowGraph;
  caseType: string;
  scenarios?: SimulationScenario[];
}): SimulationGateResult {
  registerBuiltinGuards();

  const scenarios =
    params.scenarios && params.scenarios.length > 0
      ? params.scenarios
      : (() => {
          const synthetic = buildSyntheticHappyPathScenario(params.graph);
          return synthetic ? [synthetic] : [];
        })();

  const outcomes: SimulationScenarioOutcome[] = [];
  const failures: string[] = [];

  if (scenarios.length === 0) {
    failures.push("sin escenarios simulables: no hay ruta inicial→terminal");
  }

  for (const scenario of scenarios) {
    const result = replayCaseThroughDefinition({
      graph: params.graph,
      caseType: params.caseType,
      events: scenario.events,
      finalStep: scenario.finalStep,
      finalContext: scenario.finalContext ?? null,
      initialStep: scenario.initialStep ?? null,
    });
    // requires_approval after we already synthesized a decision is still a fail;
    // legal is the only success verdict.
    const ok = result.ok && result.divergences.length === 0;
    outcomes.push({
      scenario: scenario.key,
      ok,
      terminalStep: result.terminalStep,
      expectedTerminalStep: result.expectedTerminalStep,
      divergences: result.divergences.map((d) => ({
        from: d.from,
        to: d.to,
        verdict: d.verdict,
        reason: d.reason,
        failedGuards: d.failedGuards,
      })),
    });
    if (!ok) {
      failures.push(
        `escenario "${scenario.key}": terminal=${result.terminalStep ?? "null"} ` +
          `esperado=${scenario.finalStep ?? "null"}, divergencias=${result.divergences.length}`
      );
    }
  }

  return {
    gate: {
      gate: "simulation",
      result: failures.length === 0 ? "pass" : "fail",
      detail: {
        ...(failures.length > 0 ? { failures } : {}),
        scenarios: outcomes.map((o) => ({ scenario: o.scenario, ok: o.ok })),
      },
    },
    outcomes,
  };
}
