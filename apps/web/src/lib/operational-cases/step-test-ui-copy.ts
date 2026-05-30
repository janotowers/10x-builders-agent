/**
 * Copy genérico del panel N4 + overrides por escenario.
 * Patrón: PATTERN_STEP_TEST_BUSINESS_DECISION
 */

import {
  businessDecisionHandler,
  type BusinessDecisionKind,
} from "@/lib/business-decisions/registry";
import type { StepTestExecutionMode } from "./step-test-scenarios";

export type StepTestScenarioUiCopy = {
  panel_intro?: string;
  running_hint?: string;
  success_summary?: string;
  failure_summary?: string;
  preview_label?: string;
  /** Sufijo en línea de meta (ej. "decisión HITL de precio"). */
  execution_detail?: string;
};

export type ResolvedStepTestUiCopy = {
  panelIntro: string;
  runningHint: string;
  successSummary: string;
  failureSummary: string;
  previewLabel: string;
  resultMetaSuffix: string;
};

const AGENT_COPY: ResolvedStepTestUiCopy = {
  panelIntro:
    "Prueba un escenario del paso con la habilidad raíz del caso (flujo real de producción).",
  runningHint:
    "La prueba corre en segundo plano. Puedes dejar este panel abierto; el resultado aparecerá aquí cuando termine.",
  successSummary: "Este escenario dejó el caso en el estado esperado.",
  failureSummary:
    "Este escenario no cumplió lo esperado; revisa estado, eventos y contexto.",
  previewLabel: "Ver respuesta del agente (preview)",
  resultMetaSuffix: "Escenario con habilidad raíz",
};

function businessDecisionLabel(kind?: string) {
  if (!kind) return "negocio";
  try {
    return businessDecisionHandler(kind as BusinessDecisionKind).label.toLocaleLowerCase("es");
  } catch {
    return kind.replace(/_/g, " ");
  }
}

function defaultBusinessDecisionCopy(kind?: string): ResolvedStepTestUiCopy {
  const detail = businessDecisionLabel(kind);
  return {
    panelIntro: `Simula la respuesta del asesor (${detail}) con el mismo flujo que Telegram e inbox. No ejecuta la habilidad raíz del agente.`,
    runningHint: "Aplicando la decisión del asesor en el caso de prueba…",
    successSummary: "La decisión del asesor dejó el caso en el estado esperado.",
    failureSummary:
      "La decisión del asesor no dejó el caso en el estado esperado; revisa contexto, paso y eventos.",
    previewLabel: "Ver mensaje de la decisión",
    resultMetaSuffix: `decisión del asesor (${detail})`,
  };
}

function mergeCopy(
  base: ResolvedStepTestUiCopy,
  overrides?: StepTestScenarioUiCopy
): ResolvedStepTestUiCopy {
  if (!overrides) return base;
  return {
    panelIntro: overrides.panel_intro ?? base.panelIntro,
    runningHint: overrides.running_hint ?? base.runningHint,
    successSummary: overrides.success_summary ?? base.successSummary,
    failureSummary: overrides.failure_summary ?? base.failureSummary,
    previewLabel: overrides.preview_label ?? base.previewLabel,
    resultMetaSuffix: overrides.execution_detail ?? base.resultMetaSuffix,
  };
}

export function resolveStepTestUiCopy(params: {
  execution?: StepTestExecutionMode;
  business_decision_kind?: string;
  ui?: StepTestScenarioUiCopy;
}): ResolvedStepTestUiCopy {
  const base =
    params.execution === "business_decision"
      ? defaultBusinessDecisionCopy(params.business_decision_kind)
      : AGENT_COPY;
  return mergeCopy(base, params.ui);
}

export function formatStepTestResultMetaLine(params: {
  execution: StepTestExecutionMode;
  scenarioLabel: string;
  rootSkillSlug: string;
  ui: ResolvedStepTestUiCopy;
}): string {
  if (params.execution === "business_decision") {
    return `Escenario: ${params.scenarioLabel} · Ejecución: ${params.ui.resultMetaSuffix}`;
  }
  return `Escenario: ${params.scenarioLabel} · ${params.ui.resultMetaSuffix}: ${params.rootSkillSlug}`;
}

export function resolveStepTestExecutionMode(params: {
  scenarioExecution?: StepTestExecutionMode;
  responseExecution?: string;
}): StepTestExecutionMode {
  if (
    params.responseExecution === "business_decision" ||
    params.responseExecution === "price_approval_decision"
  ) {
    return "business_decision";
  }
  if (params.scenarioExecution === "business_decision") {
    return "business_decision";
  }
  return "agent";
}
