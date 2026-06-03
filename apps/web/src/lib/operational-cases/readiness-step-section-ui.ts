/**
 * Estado visual de secciones «Prueba de habilidad» / «Prueba de paso» en el laboratorio.
 * Reutiliza las mismas reglas de gating que `tool-readiness/route.ts` (sin duplicar negocio).
 */

import { isReadinessVisibleTool } from "./tool-surface-classification";

function isStepTestBlocked(step: ReadinessFlowStepLike): boolean {
  if (step.test_status === "blocked") return true;
  return (step.step_skills ?? []).some(
    (skill) => skill.test_status === "blocked_by_tools"
  );
}

function stepAllSkillsN3Ok(
  skills: ReadinessFlowSkillLike[] | undefined
): boolean | undefined {
  if (!skills?.length) return undefined;
  return skills.every((skill) => skill.test_status === "tested_ok");
}

export type ReadinessTestSectionState =
  | "collapsedLocked"
  | "expandedReady"
  | "expandedDone";

export type ReadinessFlowToolLike = {
  tool_id: string;
  test_status?: string;
  readiness?: { status?: string; blocking?: boolean } | null;
};

export type ReadinessFlowSkillLike = {
  test_status?: string;
  skill_tools?: ReadinessFlowToolLike[];
};

export type ReadinessFlowStepLike = {
  test_status?: string;
  step_skills?: ReadinessFlowSkillLike[];
  step_tools?: ReadinessFlowToolLike[];
  step_test_progress?: {
    scenarios_total?: number;
    scenarios_passed?: number;
    scenarios_pending?: number;
  };
};

export type SkillN1Progress = {
  total: number;
  testedOk: number;
  pendingIds: string[];
  allTested: boolean;
};

export function skillN1GatingTools(
  skill: ReadinessFlowSkillLike
): ReadinessFlowToolLike[] {
  return (skill.skill_tools ?? []).filter((tool) =>
    isReadinessVisibleTool(tool.tool_id)
  );
}

export function skillN1Progress(skill: ReadinessFlowSkillLike): SkillN1Progress {
  const tools = skillN1GatingTools(skill);
  const total = tools.length;
  const testedOk = tools.filter((tool) => tool.test_status === "tested_ok").length;
  const pendingIds = tools
    .filter((tool) => tool.test_status !== "tested_ok")
    .map((tool) => tool.tool_id);
  return {
    total,
    testedOk,
    pendingIds,
    allTested: total === 0 || testedOk === total,
  };
}

export function skillTestSectionState(
  skill: ReadinessFlowSkillLike
): ReadinessTestSectionState {
  if (skill.test_status === "blocked_by_tools") return "collapsedLocked";
  if (
    skill.test_status === "tested_ok" ||
    skill.test_status === "tested_failed" ||
    skill.test_status === "partial"
  ) {
    return "expandedDone";
  }
  return "expandedReady";
}

/** Abierto al montar salvo bloqueado o ya probada con éxito (`tested_ok`). */
export function skillTestSectionDefaultOpen(
  skill: ReadinessFlowSkillLike
): boolean {
  const state = skillTestSectionState(skill);
  if (state === "collapsedLocked") return false;
  if (skill.test_status === "tested_ok") return false;
  return true;
}

const SKILL_STATUSES_KEEP_OPEN_AFTER_TEST = new Set([
  "ready_to_test",
  "tested_failed",
  "partial",
]);

/**
 * Tras hidratar `test_status` desde el API: colapsar si ya estaba probada,
 * sin cerrar si el usuario acaba de pasar de listo → probado con la sección abierta.
 */
export function skillTestSectionCollapseWhenAlreadyProven(
  previousStatus: string | undefined,
  nextStatus: string | undefined
): boolean {
  if (nextStatus !== "tested_ok") return false;
  if (previousStatus === "tested_ok") return false;
  if (
    previousStatus != null &&
    SKILL_STATUSES_KEEP_OPEN_AFTER_TEST.has(previousStatus)
  ) {
    return false;
  }
  return true;
}

/**
 * Pill en la fila del botón «Probar …» / «Volver a probar».
 * Oculto en éxito estable (`tested_ok`): el encabezado del paso/habilidad ya es la fuente de verdad.
 */
export function readinessTestShowActionRowStatusPill(
  testStatus?: string
): boolean {
  return testStatus !== "tested_ok";
}

export function skillTestSectionSummary(skill: ReadinessFlowSkillLike): string {
  const state = skillTestSectionState(skill);
  if (state === "collapsedLocked") {
    const progress = skillN1Progress(skill);
    if (progress.total === 0) {
      return "Completa las integraciones de abajo";
    }
    if (progress.pendingIds.length > 0) {
      return `Integraciones ${progress.testedOk}/${progress.total} probadas`;
    }
    return "Falta probar integraciones";
  }
  if (skill.test_status === "tested_ok") {
    return "Completada";
  }
  if (skill.test_status === "tested_failed") {
    return "Última prueba falló";
  }
  if (skill.test_status === "partial") {
    return "Prueba parcial — revisar antes de continuar";
  }
  return "Lista para ejecutar la prueba";
}

export function listUntestedReadinessToolIdsForStep(
  step: ReadinessFlowStepLike
): string[] {
  const pending = new Set<string>();
  const consider = (tool: ReadinessFlowToolLike) => {
    if (!tool.tool_id || !isReadinessVisibleTool(tool.tool_id)) return;
    if (tool.test_status !== "tested_ok") pending.add(tool.tool_id);
  };
  for (const tool of step.step_tools ?? []) consider(tool);
  for (const skill of step.step_skills ?? []) {
    for (const tool of skill.skill_tools ?? []) consider(tool);
  }
  return [...pending];
}

export function stepTestSectionState(
  step: ReadinessFlowStepLike
): ReadinessTestSectionState {
  if (isStepTestBlocked(step)) return "collapsedLocked";
  if (step.test_status === "tested_ok" || step.test_status === "tested_failed") {
    return "expandedDone";
  }
  if (step.test_status === "partially_tested") return "expandedDone";
  return "expandedReady";
}

/** Abierto al montar salvo bloqueado o paso ya probado con éxito (`tested_ok`). */
export function stepTestSectionDefaultOpen(
  step: ReadinessFlowStepLike
): boolean {
  const state = stepTestSectionState(step);
  if (state === "collapsedLocked") return false;
  if (step.test_status === "tested_ok") return false;
  return true;
}

const STEP_STATUSES_KEEP_OPEN_AFTER_TEST = new Set([
  "ready_to_test",
  "awaiting_n4",
  "tested_failed",
  "partially_tested",
]);

export function stepTestSectionCollapseWhenAlreadyProven(
  previousStatus: string | undefined,
  nextStatus: string | undefined
): boolean {
  if (nextStatus !== "tested_ok") return false;
  if (previousStatus === "tested_ok") return false;
  if (
    previousStatus != null &&
    STEP_STATUSES_KEEP_OPEN_AFTER_TEST.has(previousStatus)
  ) {
    return false;
  }
  return true;
}

function stepScenarioProgressBrief(step: ReadinessFlowStepLike): string | null {
  const progress = step.step_test_progress;
  if (!progress?.scenarios_total) return null;
  const passed = progress.scenarios_passed ?? 0;
  const total = progress.scenarios_total;
  return `${passed}/${total} escenarios probados`;
}

export function stepTestSectionSummary(step: ReadinessFlowStepLike): string {
  const state = stepTestSectionState(step);
  if (state !== "collapsedLocked") {
    const scenarioLine = stepScenarioProgressBrief(step);
    if (step.test_status === "tested_ok") {
      return scenarioLine ?? "Paso completado";
    }
    if (step.test_status === "tested_failed") {
      return scenarioLine
        ? `Última prueba falló · ${scenarioLine}`
        : "Última prueba del paso falló";
    }
    if (step.test_status === "partially_tested") {
      return scenarioLine ?? "Paso en progreso";
    }
    if (step.test_status === "awaiting_n4") {
      return scenarioLine
        ? `Falta cerrar escenarios · ${scenarioLine}`
        : "Falta probar escenarios del paso";
    }
    return "Listo para probar escenarios con la raíz del caso";
  }

  if (step.test_status === "blocked") {
    const pending = listUntestedReadinessToolIdsForStep(step);
    if (pending.length > 0) {
      return `Integraciones pendientes (${pending.length})`;
    }
    return "Falta probar integraciones del paso";
  }

  const skillsNeedingN1 = (step.step_skills ?? []).filter(
    (skill) => skill.test_status === "blocked_by_tools"
  );
  if (skillsNeedingN1.length > 0) {
    return "Falta probar habilidad en este paso";
  }

  const allSkillsOk = stepAllSkillsN3Ok(step.step_skills);
  if (allSkillsOk === false) {
    return "Falta probar habilidad";
  }

  return "Completa integraciones y habilidad";
}
