/**
 * Helpers UI para `step_decision` (PATTERN_STEP_BRANCH_DECISION).
 * Solo presentación / agrupación; no ejecuta ramas.
 */

import type {
  OperationalCaseFlowStepDecision,
  OperationalCaseFlowStepDecisionBranch,
} from "@agents/types";

export type StepDecisionToolPartition = {
  /** tool_id → labels de ramas donde es primaria */
  byBranch: Map<string, string[]>;
  /** tool_ids compartidos del hito */
  shared: Set<string>;
  /** tool_ids declarados en decision pero no en primary ni shared (no debería; defensivo) */
  unassignedDecisionIds: string[];
};

/**
 * Índice tool_id → ramas / compartidas a partir de `step_decision`.
 * Si no hay decisión, mapas vacíos (UI sin agrupación).
 */
export function partitionToolsByStepDecision(
  decision: OperationalCaseFlowStepDecision | null | undefined
): StepDecisionToolPartition {
  const byBranch = new Map<string, string[]>();
  const shared = new Set<string>();
  if (!decision) {
    return { byBranch, shared, unassignedDecisionIds: [] };
  }

  for (const toolId of decision.shared_tool_ids ?? []) {
    shared.add(toolId);
  }

  for (const branch of decision.branches) {
    for (const toolId of branch.primary_tool_ids ?? []) {
      const labels = byBranch.get(toolId) ?? [];
      if (!labels.includes(branch.label)) labels.push(branch.label);
      byBranch.set(toolId, labels);
    }
  }

  return { byBranch, shared, unassignedDecisionIds: [] };
}

/** Etiqueta corta para badge de tool (rama o compartida). */
export function stepDecisionToolBadgeLabel(
  toolId: string,
  partition: StepDecisionToolPartition
): string | null {
  if (partition.shared.has(toolId)) return "Compartida";
  const branches = partition.byBranch.get(toolId);
  if (!branches?.length) return null;
  return branches.join(" · ");
}

/** Rama(s) que declaran un scenario_id N4. */
export function branchesForScenarioId(
  decision: OperationalCaseFlowStepDecision | null | undefined,
  scenarioId: string
): OperationalCaseFlowStepDecisionBranch[] {
  if (!decision) return [];
  return decision.branches.filter((b) =>
    (b.scenario_ids ?? []).includes(scenarioId)
  );
}

export function scenarioBranchBadgeLabel(
  decision: OperationalCaseFlowStepDecision | null | undefined,
  scenarioId: string
): string | null {
  const branches = branchesForScenarioId(decision, scenarioId);
  if (!branches.length) return null;
  return branches.map((b) => b.label).join(" · ");
}
