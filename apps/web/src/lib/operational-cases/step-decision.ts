/**
 * Normalización y validación warn-only de `step_decision` en el flow.
 * PATTERN_STEP_BRANCH_DECISION — metadata explicativa; no motor de ejecución.
 */

import type {
  OperationalCaseFlowStep,
  OperationalCaseFlowStepDecision,
  OperationalCaseFlowStepDecisionBranch,
  OperationalCaseStatus,
} from "@agents/types";

const STATUS_VALUES: OperationalCaseStatus[] = [
  "active",
  "waiting_internal",
  "waiting_external",
  "paused",
  "completed",
  "failed",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function cleanIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const id = cleanText(item);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function normalizeBranch(
  value: unknown
): OperationalCaseFlowStepDecisionBranch | null {
  if (!isRecord(value)) return null;
  const branchValue = cleanText(value.value);
  const label = cleanText(value.label);
  if (!branchValue || !label) return null;
  const statusRaw = cleanText(value.expected_status);
  const expected_status = STATUS_VALUES.includes(statusRaw as OperationalCaseStatus)
    ? (statusRaw as OperationalCaseStatus)
    : undefined;
  return {
    value: branchValue,
    label,
    description: cleanText(value.description) || undefined,
    expected_status,
    primary_tool_ids: cleanIdList(value.primary_tool_ids),
    scenario_ids: cleanIdList(value.scenario_ids),
  };
}

/**
 * Parsea `step_decision` desde JSON del flow. Devuelve undefined si falta o
 * es inválido (sin id/label/branches). Nunca lanza.
 */
export function normalizeStepDecision(
  value: unknown
): OperationalCaseFlowStepDecision | undefined {
  if (!isRecord(value)) return undefined;
  const id = cleanText(value.id);
  const label = cleanText(value.label);
  if (!id || !label) return undefined;
  const branches = Array.isArray(value.branches)
    ? value.branches.map(normalizeBranch).filter((b): b is OperationalCaseFlowStepDecisionBranch => b != null)
    : [];
  if (branches.length === 0) return undefined;
  return {
    id,
    label,
    description: cleanText(value.description) || undefined,
    context_key: cleanText(value.context_key) || undefined,
    decided_by_hint: cleanText(value.decided_by_hint) || undefined,
    branches,
    shared_tool_ids: cleanIdList(value.shared_tool_ids),
  };
}

export type StepDecisionWarning = {
  step_key: string;
  code:
    | "unknown_primary_tool"
    | "unknown_shared_tool"
    | "unknown_scenario_id"
    | "duplicate_branch_value";
  message: string;
};

function toolIdsDeclaredInStep(step: OperationalCaseFlowStep): Set<string> {
  const ids = new Set<string>();
  for (const tool of step.step_tools ?? []) {
    if (tool.tool_id) ids.add(tool.tool_id);
  }
  for (const skill of step.step_skills ?? []) {
    for (const tool of skill.skill_tools ?? []) {
      if (tool.tool_id) ids.add(tool.tool_id);
    }
  }
  return ids;
}

/**
 * Validación suave (warn-only): no bloquea guardado ni readiness.
 * `knownScenarioIds` opcional — si se omite, no valida scenario_ids.
 */
export function collectStepDecisionWarnings(params: {
  step: OperationalCaseFlowStep;
  knownScenarioIds?: ReadonlySet<string> | readonly string[];
}): StepDecisionWarning[] {
  const { step } = params;
  const decision = step.step_decision;
  if (!decision) return [];

  const warnings: StepDecisionWarning[] = [];
  const declaredTools = toolIdsDeclaredInStep(step);
  const knownScenarios = params.knownScenarioIds
    ? params.knownScenarioIds instanceof Set
      ? params.knownScenarioIds
      : new Set(params.knownScenarioIds)
    : null;

  const seenValues = new Set<string>();
  for (const branch of decision.branches) {
    if (seenValues.has(branch.value)) {
      warnings.push({
        step_key: step.step_key,
        code: "duplicate_branch_value",
        message: `Rama duplicada value="${branch.value}" en step_decision.`,
      });
    }
    seenValues.add(branch.value);

    for (const toolId of branch.primary_tool_ids ?? []) {
      if (!declaredTools.has(toolId)) {
        warnings.push({
          step_key: step.step_key,
          code: "unknown_primary_tool",
          message: `primary_tool_id "${toolId}" (rama ${branch.value}) no está en skill_tools/step_tools del paso.`,
        });
      }
    }
    if (knownScenarios) {
      for (const scenarioId of branch.scenario_ids ?? []) {
        if (!knownScenarios.has(scenarioId)) {
          warnings.push({
            step_key: step.step_key,
            code: "unknown_scenario_id",
            message: `scenario_id "${scenarioId}" (rama ${branch.value}) no está en el registry N4 del paso.`,
          });
        }
      }
    }
  }

  for (const toolId of decision.shared_tool_ids ?? []) {
    if (!declaredTools.has(toolId)) {
      warnings.push({
        step_key: step.step_key,
        code: "unknown_shared_tool",
        message: `shared_tool_id "${toolId}" no está en skill_tools/step_tools del paso.`,
      });
    }
  }

  return warnings;
}
