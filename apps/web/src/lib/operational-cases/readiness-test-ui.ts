/**
 * Reglas UI compartidas para N3/N4 en Preparación operativa.
 * Doc: docs/operational-cases/testing-framework.md §10
 */

export const SKILL_TEST_PRIMARY_BUTTON_CLASS =
  "rounded bg-violet-700 px-2 py-1 font-semibold text-white hover:bg-violet-800 disabled:cursor-not-allowed disabled:bg-violet-300 disabled:text-violet-100 dark:disabled:bg-violet-900/50 dark:disabled:text-violet-300";

export const STEP_TEST_PRIMARY_BUTTON_CLASS =
  "rounded bg-indigo-700 px-2 py-1 font-semibold text-white hover:bg-indigo-800 disabled:cursor-not-allowed disabled:bg-indigo-300 disabled:text-indigo-100 dark:disabled:bg-indigo-900/50 dark:disabled:text-indigo-300";

export type ReadinessStepForGating = {
  test_status?: string;
  step_skills?: Array<{ test_status?: string }>;
};

/** Bloquea N4 cuando el paso o alguna habilidad del paso exige N1 pendiente. */
export function isStepTestBlocked(step: ReadinessStepForGating): boolean {
  if (step.test_status === "blocked") return true;
  return (step.step_skills ?? []).some(
    (skill) => skill.test_status === "blocked_by_tools"
  );
}

export const STEP_TEST_BLOCKED_TITLE =
  "Primero prueba las integraciones y acciones de este paso antes de usar «Probar paso».";

export const SKILL_TEST_BLOCKED_TITLE =
  "Primero prueba las integraciones de esta habilidad antes de «Probar habilidad».";

/** Pills N1 — tool de integración/acción. */
export function toolTestStatusLabel(status?: string) {
  if (status === "tested_ok") return "Probada";
  if (status === "tested_failed") return "Prueba falló";
  return "Sin probar";
}

export type StepTestProgressSummary = {
  scenarios_total: number;
  scenarios_passed: number;
  scenarios_failed?: number;
  scenarios_partial?: number;
  scenarios_pending?: number;
  scenarios?: Array<{
    id: string;
    label?: string;
    status: "tested_ok" | "tested_failed" | "partial" | "pending";
    optional?: boolean;
  }>;
};

/** Texto corto de progreso por escenarios del paso (sin jerga N3/N4). */
export function formatStepScenarioProgress(
  progress?: StepTestProgressSummary | null
): string | null {
  if (!progress || progress.scenarios_total <= 0) return null;
  const { scenarios_passed, scenarios_total, scenarios_failed = 0 } = progress;
  if (scenarios_passed >= scenarios_total) {
    return `${scenarios_total} escenario${scenarios_total === 1 ? "" : "s"} probado${scenarios_total === 1 ? "" : "s"}`;
  }
  if (scenarios_failed > 0) {
    return `${scenarios_passed} de ${scenarios_total} escenarios OK · ${scenarios_failed} con fallo`;
  }
  return `${scenarios_passed} de ${scenarios_total} escenarios probados`;
}

const SCENARIO_STATUS_SYMBOL: Record<string, string> = {
  tested_ok: "✓",
  tested_failed: "✗",
  partial: "~",
  pending: "○",
};

/** Lista compacta por escenario (para el acordeón del paso). */
export function formatStepScenarioChecklist(
  progress?: StepTestProgressSummary | null
): string | null {
  const items = progress?.scenarios;
  if (!items || items.length === 0) return null;
  return items
    .map((item) => {
      const mark = SCENARIO_STATUS_SYMBOL[item.status] ?? "○";
      const name = item.label?.trim() || item.id;
      return `${mark} ${name}`;
    })
    .join(" · ");
}

/** Pills — habilidad del paso (prueba unitaria de la skill). */
export function skillTestStatusLabel(status?: string) {
  if (status === "tested_ok") return "Habilidad probada";
  if (status === "tested_failed") return "Prueba de habilidad falló";
  if (status === "partial") return "Prueba de habilidad parcial";
  if (status === "ready_to_test") return "Lista para probar habilidad";
  if (status === "blocked_by_tools") return "Falta probar integraciones";
  return "Sin estado";
}

/** Badge del resultado de una corrida de un solo escenario (no del hito completo). */
export function stepScenarioRunResultLabel(status?: string) {
  if (status === "tested_ok") return "Escenario probado";
  if (status === "partial") return "Escenario parcial";
  if (status === "tested_failed") return "Escenario falló";
  return "Sin resultado";
}

/**
 * Aclara por qué generate_document puede fallar y el escenario sigue en OK (salida B).
 */
export function contractDraftScenarioOutcomeHint(params: {
  scenarioOk?: boolean;
  scenarioId?: string;
  caseStatus?: string;
  toolCalls?: Array<{ tool_name?: string; status?: string }>;
}): string | null {
  const generateCalls = (params.toolCalls ?? []).filter(
    (call) => call.tool_name === "generate_document_from_template"
  );
  const generateRendered = generateCalls.some((call) => call.status === "executed");
  const generateFailed = generateCalls.some((call) => call.status === "failed");

  if (
    !params.scenarioOk &&
    params.scenarioId === "contract_pending_draft_review" &&
    (params.caseStatus === "paused" || generateFailed || !generateRendered)
  ) {
    return (
      "Salida A exige plantilla DOCX en la cuenta (asset «commission_contract_template» en Paso 5 → " +
      "generate_document_from_template). Sin ella, el coach pausa y avisa — eso valida el escenario " +
      "«Plantilla de contrato no configurada», no este."
    );
  }

  if (!params.scenarioOk) return null;
  if (params.scenarioId === "contract_pending_template_missing") {
    return (
      "Guardrail opcional (Salida B): valida pausa y aviso si falta plantilla; " +
      "no cuenta para «Paso probado» ni sustituye «Borrador de contrato para revisión»."
    );
  }
  if (params.scenarioId === "contract_pending_draft_review") {
    return (
      "Escenario de borrador real (Salida A): requiere generate_document renderizado, " +
      "contract_draft.output_path y enlace corto /documents/contract_draft/download."
    );
  }
  const genFailed = generateFailed;
  if (!genFailed) return null;
  if (params.caseStatus === "paused") {
    return (
      "generate_document_from_template falló; si no era el escenario de plantilla faltante, " +
      "revisa la plantilla DOCX en cuenta."
    );
  }
  return null;
}

export function stepAllSkillsN3Ok(
  skills: Array<{ test_status?: string }> | undefined
): boolean | undefined {
  if (!skills?.length) return undefined;
  return skills.every((skill) => skill.test_status === "tested_ok");
}

/** Pills — hito del paso (todos los escenarios contemplados). */
export function stepTestStatusLabel(
  status?: string,
  progress?: StepTestProgressSummary | null,
  options?: { allSkillsN3Ok?: boolean }
) {
  if (status === "tested_ok") {
    return "Paso probado";
  }
  if (status === "tested_failed") {
    const base = "Última prueba del paso falló";
    const detail = formatStepScenarioProgress(progress);
    return detail ? `${base} · ${detail}` : base;
  }
  if (status === "awaiting_n4") {
    if (options?.allSkillsN3Ok === false) {
      return "Falta probar habilidad y escenarios";
    }
    if (progress && progress.scenarios_total > 0) {
      const pending = progress.scenarios_pending ?? 0;
      if (progress.scenarios_passed === 0 && pending > 0) {
        return "Falta probar escenarios del paso";
      }
    }
    return "Listo para probar escenarios";
  }
  if (status === "partially_tested") {
    const detail = formatStepScenarioProgress(progress);
    return detail ? `En progreso · ${detail}` : "Paso en progreso";
  }
  if (status === "ready_to_test") {
    return "Pendiente de prueba del paso";
  }
  if (status === "blocked") return "Falta probar integraciones del paso";
  return "Sin estado";
}

export type { StepTestExecutionMode } from "./step-test-scenarios";
export type { StepTestScenarioUiCopy } from "./step-test-ui-copy";
export {
  formatStepTestResultMetaLine,
  resolveStepTestExecutionMode,
  resolveStepTestUiCopy,
  type ResolvedStepTestUiCopy,
} from "./step-test-ui-copy";

/** Badge de progreso del flujo (vista resumida / referencia). */
export function flowStepProgressBadgeLabel(status?: string) {
  if (status === "completed") return "Completado";
  if (status === "blocked") return "Pendiente probar tools";
  if (status === "in_progress") return "En curso";
  return "Pendiente";
}
