/**
 * Gate de simulación (Slice 4.2-3; Technical Plan §15): ejecuta el borrador
 * contra casos sintéticos usando el harness de replay de 1.6 — el MISMO
 * evaluador de transiciones que corre en producción, no una re-implementación
 * (paridad §17).
 *
 * Escenarios: el llamador puede aportar una suite propia (derivada de los
 * acceptance_scenarios del business spec); si no, se sintetiza el camino
 * feliz caminando el grafo del estado inicial al terminal más cercano. Para
 * guards conocidos dependientes de historia/contexto se sintetizan las
 * precondiciones (evento `external_response`, contexto de comparables), de
 * modo que un grafo bien formado simule limpio sin fixtures manuales.
 */

import { registerBuiltinGuards } from "../guards/builtins";
import { replayCaseThroughDefinition, type ReplayEvent } from "../replay";
import type { WorkflowGraph } from "@agents/types";
import type { CompilerGateResult } from "./validation-gates";

export interface SimulationScenario {
  key: string;
  label: string;
  events: ReplayEvent[];
  /** Estado terminal esperado al final del replay. */
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
    failedGuards: string[];
  }>;
}

/** Evento sintético de avance con el shape que el replay sabe leer. */
function stepEvent(from: string | null, to: string): ReplayEvent {
  return {
    event_type: "case_updated",
    actor: "system",
    payload_jsonb: {
      ...(from ? { from: { current_step: from } } : {}),
      to: { current_step: to },
    },
  };
}

/** BFS del estado inicial (states[0]) al terminal más cercano. */
function shortestHappyPath(
  graph: WorkflowGraph
): Array<{ from: string; to: string; guards: string[] }> | null {
  const initial = graph.states[0]?.key;
  if (!initial) return null;
  const terminals = new Set([
    ...graph.completion.terminal_states,
    ...graph.states.filter((s) => s.kind === "terminal").map((s) => s.key),
  ]);
  type Hop = { from: string; to: string; guards: string[] };
  const cameFrom = new Map<string, Hop>();
  const queue = [initial];
  const seen = new Set([initial]);
  let reached: string | null = terminals.has(initial) ? initial : null;
  while (queue.length > 0 && !reached) {
    const node = queue.shift() as string;
    for (const transition of graph.transitions) {
      if (transition.from !== node || seen.has(transition.to)) continue;
      seen.add(transition.to);
      cameFrom.set(transition.to, {
        from: node,
        to: transition.to,
        guards: transition.guards,
      });
      if (terminals.has(transition.to)) {
        reached = transition.to;
        break;
      }
      queue.push(transition.to);
    }
  }
  if (!reached) return null;
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
 * Escenario sintético de camino feliz. Devuelve null cuando no existe ruta
 * inicial→terminal (eso ya lo reporta el gate de alcanzabilidad).
 */
export function buildSyntheticHappyPathScenario(
  graph: WorkflowGraph
): SimulationScenario | null {
  const path = shortestHappyPath(graph);
  if (!path || path.length === 0) return null;

  const events: ReplayEvent[] = [];
  let needsComparablesContext = false;
  for (const hop of path) {
    // Precondiciones sintetizadas para guards dependientes de historia.
    if (hop.guards.includes("external_response_exists")) {
      events.push({ event_type: "external_response", actor: "external_contact" });
    }
    if (hop.guards.includes("defensible_comparables_sample")) {
      needsComparablesContext = true;
    }
    events.push(stepEvent(hop.from, hop.to));
  }

  const finalStep = path[path.length - 1].to;
  return {
    key: "synthetic_happy_path",
    label: "Camino feliz sintético (inicial → terminal)",
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

/**
 * Corre la suite (o el camino feliz sintético por defecto) y produce el
 * resultado del gate `simulation`. Falla cuando algún escenario no llega al
 * terminal esperado o registra divergencias (transiciones ilegales según el
 * evaluador de producción).
 */
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
