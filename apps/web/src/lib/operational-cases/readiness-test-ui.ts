/**
 * Reglas UI compartidas para N3/N4 en Preparación operativa.
 * Doc: docs/operational-cases/testing-framework.md §10
 */

export const SKILL_TEST_PRIMARY_BUTTON_CLASS =
  "rounded bg-violet-700 px-2 py-1 font-semibold text-white hover:bg-violet-800 disabled:cursor-not-allowed disabled:bg-violet-300 disabled:text-violet-100 dark:disabled:bg-violet-900/50 dark:disabled:text-violet-300";

export const STEP_TEST_PRIMARY_BUTTON_CLASS =
  "rounded bg-indigo-700 px-2 py-1 font-semibold text-white hover:bg-indigo-800 disabled:cursor-not-allowed disabled:bg-indigo-300 disabled:text-indigo-100 dark:disabled:bg-indigo-900/50 dark:disabled:text-indigo-300";

/** Clases Tailwind para pills de estado N1–N4 en el laboratorio. */
export function readinessTestStatusPillClass(status?: string): string {
  if (status === "tested_ok" || status === "ready_for_e2e") {
    return "bg-emerald-50 text-emerald-800";
  }
  if (status === "tested_failed") {
    return "bg-red-50 text-red-800";
  }
  if (status === "blocked" || status === "blocked_by_tools") {
    return "bg-amber-50 text-amber-800";
  }
  if (status === "partial" || status === "partially_tested") {
    return "bg-amber-50 text-amber-800";
  }
  if (status === "ready_to_test" || status === "awaiting_n4") {
    return "bg-neutral-100 text-neutral-700";
  }
  return "bg-neutral-100 text-neutral-700";
}

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

/** Hint del summary colapsable «Prueba de herramienta» (solo expandir panel N1). */
export function toolTestSectionSummaryHint(testStatus?: string): string {
  if (testStatus === "tested_ok") return "Completada";
  if (testStatus === "tested_failed") return "Última prueba falló";
  return "Lista para validar y ejecutar";
}

/** Toggle de fila: configurar assets de cuenta (operación real), no el laboratorio N1. */
export const ACCOUNT_RESOURCES_TOGGLE_OPEN_LABEL = "Recursos de cuenta";
export const ACCOUNT_RESOURCES_TOGGLE_CLOSE_LABEL = "Cerrar recursos de cuenta";

export const ACCOUNT_RESOURCES_PANEL_HINT =
  "Plantillas y activos de la cuenta para operación real; la prueba de herramienta los usa como prerequisito.";

export const TEST_ASSETS_PANEL_HINT =
  "Solo para validar esta tool en el laboratorio; no sustituyen los recursos de cuenta.";

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

export type StepScenarioBucketCounts = {
  milestoneTotal: number;
  milestonePassed: number;
  milestoneFailed: number;
  milestonePartial: number;
  milestonePending: number;
  optionalTotal: number;
  optionalPassed: number;
  optionalFailed: number;
  optionalPartial: number;
  optionalPending: number;
  hasOptional: boolean;
};

/** Separa escenarios del hito (milestone) vs opcionales (p. ej. guardrails). */
export function stepScenarioBucketCounts(
  progress?: StepTestProgressSummary | null
): StepScenarioBucketCounts | null {
  if (!progress || progress.scenarios_total <= 0) return null;
  const items = progress.scenarios ?? [];
  const optionalItems = items.filter((item) => item.optional);

  const milestoneTotal = progress.scenarios_total;
  const milestonePassed = progress.scenarios_passed ?? 0;
  const milestoneFailed = progress.scenarios_failed ?? 0;
  const milestonePartial = progress.scenarios_partial ?? 0;
  const milestonePending =
    progress.scenarios_pending ??
    Math.max(
      0,
      milestoneTotal - milestonePassed - milestoneFailed - milestonePartial
    );

  const optionalTotal = optionalItems.length;
  const optionalPassed = optionalItems.filter(
    (item) => item.status === "tested_ok"
  ).length;
  const optionalFailed = optionalItems.filter(
    (item) => item.status === "tested_failed"
  ).length;
  const optionalPartial = optionalItems.filter(
    (item) => item.status === "partial"
  ).length;
  const optionalPending = optionalItems.filter(
    (item) => item.status === "pending"
  ).length;

  return {
    milestoneTotal,
    milestonePassed,
    milestoneFailed,
    milestonePartial,
    milestonePending,
    optionalTotal,
    optionalPassed,
    optionalFailed,
    optionalPartial,
    optionalPending,
    hasOptional: optionalTotal > 0,
  };
}

function milestoneScenarioNoun(counts: StepScenarioBucketCounts): string {
  return counts.hasOptional ? "escenarios del hito" : "escenarios";
}

function formatOptionalScenarioSuffix(counts: StepScenarioBucketCounts): string {
  if (!counts.hasOptional) return "";
  const { optionalTotal, optionalPassed, optionalFailed, optionalPending } =
    counts;
  const label = (n: number) =>
    `${n} escenario${n === 1 ? "" : "s"} opcional${n === 1 ? "" : "es"}`;

  if (optionalFailed > 0 && optionalPassed === 0 && optionalPending === 0) {
    return ` · ${label(optionalFailed)} con fallo`;
  }
  if (optionalPassed === optionalTotal) {
    return ` · ${label(optionalTotal)} probado${optionalTotal === 1 ? "" : "s"}`;
  }
  if (optionalPending === optionalTotal) {
    return ` · ${label(optionalTotal)} sin probar`;
  }
  const done = optionalPassed + counts.optionalPartial;
  return ` · ${done}/${optionalTotal} escenario${optionalTotal === 1 ? "" : "s"} opcional${optionalTotal === 1 ? "" : "es"}`;
}

/** Texto corto de progreso por escenarios del paso (sin jerga N3/N4). */
export function formatStepScenarioProgress(
  progress?: StepTestProgressSummary | null
): string | null {
  const counts = stepScenarioBucketCounts(progress);
  if (!counts || counts.milestoneTotal <= 0) return null;

  const noun = milestoneScenarioNoun(counts);
  const {
    milestonePassed,
    milestoneTotal,
    milestoneFailed,
    milestonePartial,
  } = counts;
  const suffix = formatOptionalScenarioSuffix(counts);

  if (milestonePassed >= milestoneTotal) {
    return `${milestonePassed}/${milestoneTotal} ${noun} probados${suffix}`;
  }
  if (milestoneFailed > 0) {
    return `${milestonePassed}/${milestoneTotal} ${noun} OK · ${milestoneFailed} con fallo${suffix}`;
  }
  if (milestonePartial > 0 && milestonePassed + milestonePartial < milestoneTotal) {
    return `${milestonePassed}/${milestoneTotal} ${noun} probados · ${milestonePartial} parcial${milestonePartial === 1 ? "" : "es"}${suffix}`;
  }
  return `${milestonePassed}/${milestoneTotal} ${noun} probados${suffix}`;
}

/** Misma línea que `formatStepScenarioProgress` (summary de «Prueba de paso»). */
export function formatStepScenarioProgressBrief(
  progress?: StepTestProgressSummary | null
): string | null {
  return formatStepScenarioProgress(progress);
}

const SCENARIO_STATUS_SYMBOL: Record<string, string> = {
  tested_ok: "✓",
  tested_failed: "✗",
  partial: "~",
  pending: "○",
};

function formatScenarioChecklistItems(
  items: NonNullable<StepTestProgressSummary["scenarios"]>
): string {
  return items
    .map((item) => {
      const mark = SCENARIO_STATUS_SYMBOL[item.status] ?? "○";
      const name = item.label?.trim() || item.id;
      return `${mark} ${name}`;
    })
    .join(" · ");
}

/** Lista compacta por escenario (hito primero; opcionales agrupados al final). */
export function formatStepScenarioChecklist(
  progress?: StepTestProgressSummary | null
): string | null {
  const items = progress?.scenarios;
  if (!items || items.length === 0) return null;

  const milestoneItems = items.filter((item) => !item.optional);
  const optionalItems = items.filter((item) => item.optional);
  const parts: string[] = [];

  if (milestoneItems.length > 0) {
    parts.push(formatScenarioChecklistItems(milestoneItems));
  }
  if (optionalItems.length > 0) {
    const optionalLine = formatScenarioChecklistItems(optionalItems);
    parts.push(
      optionalItems.length === 1
        ? `Opcional: ${optionalLine}`
        : `Opcionales: ${optionalLine}`
    );
  }

  return parts.join(" · ");
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

/** Badge del resumen runtime del caso de prueba (no confundir con «Paso probado» del lab). */
export function flowProgressRuntimeBadgeLabel(status?: string) {
  if (status === "completed") return "Con actividad registrada";
  if (status === "in_progress") return "Paso actual del caso";
  if (status === "blocked") return "Bloqueado";
  return "Sin actividad atribuida";
}

export function flowProgressRuntimeBadgeTitle(status?: string): string {
  if (status === "completed") {
    return "Hay eventos o tools registrados y atribuidos a este paso del flujo.";
  }
  if (status === "in_progress") {
    return "El caso operativo está en este paso ahora (no confundir con las tarjetas del laboratorio).";
  }
  if (status === "blocked") return "Este paso aparece bloqueado según la telemetría.";
  return "No hay actividad atribuida a este paso; no implica que nunca se haya recorrido.";
}

export type FlowStepEvidenceSummary = {
  eventCount: number;
  toolExecuted: number;
  toolPending: number;
  toolFailed: number;
  toolRejected: number;
  uniqueTools: string[];
};

/** Resume evidencia cruda de flowProgress para UI operativa. */
export function summarizeFlowStepEvidence(
  evidence: string[]
): FlowStepEvidenceSummary {
  let eventCount = 0;
  let toolExecuted = 0;
  let toolPending = 0;
  let toolFailed = 0;
  let toolRejected = 0;
  const toolNames = new Set<string>();

  for (const item of evidence) {
    if (item.startsWith("event:")) {
      eventCount += 1;
      continue;
    }
    if (!item.startsWith("tool:")) continue;
    const lastColon = item.lastIndexOf(":");
    if (lastColon <= 5) continue;
    const status = item.slice(lastColon + 1);
    const toolName = item.slice(5, lastColon);
    toolNames.add(toolName);
    if (status === "executed") toolExecuted += 1;
    else if (status === "pending_confirmation") toolPending += 1;
    else if (status === "failed") toolFailed += 1;
    else if (status === "rejected") toolRejected += 1;
  }

  return {
    eventCount,
    toolExecuted,
    toolPending,
    toolFailed,
    toolRejected,
    uniqueTools: [...toolNames].sort((a, b) => a.localeCompare(b)),
  };
}

export function formatFlowStepEvidenceSummaryLine(
  summary: FlowStepEvidenceSummary,
  options?: { cycleScoped?: boolean }
): string {
  const parts: string[] = [];
  if (summary.eventCount > 0) {
    parts.push(
      `${summary.eventCount} evento${summary.eventCount === 1 ? "" : "s"}`
    );
  }
  if (summary.toolExecuted > 0) {
    parts.push(
      `${summary.toolExecuted} tool${summary.toolExecuted === 1 ? "" : "s"} ejecutada${summary.toolExecuted === 1 ? "" : "s"}`
    );
  }
  if (summary.toolPending > 0) {
    parts.push(
      `${summary.toolPending} pendiente${summary.toolPending === 1 ? "" : "s"} de confirmación`
    );
  }
  if (summary.toolFailed > 0) {
    parts.push(`${summary.toolFailed} fallida${summary.toolFailed === 1 ? "" : "s"}`);
  }
  if (summary.toolRejected > 0) {
    parts.push(
      `${summary.toolRejected} rechazada${summary.toolRejected === 1 ? "" : "s"}`
    );
  }
  if (parts.length === 0) {
    return options?.cycleScoped
      ? "Sin actividad registrada en este recorrido E2E."
      : "Sin actividad atribuida a este paso.";
  }
  return parts.join(" · ");
}
