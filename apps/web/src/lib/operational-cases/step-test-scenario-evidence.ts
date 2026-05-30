/**
 * Evidencia N4 por escenario (paso) y resolución del pill del hito.
 * Patrón: PATTERN_STEP_STATUS_N3_VS_N4 (todos los escenarios requeridos).
 */

import {
  stepTestMilestoneScenariosFor,
  stepTestScenarioCountsTowardMilestone,
  stepTestScenarioDefsFor,
} from "./step-test-scenarios";

export type StepScenarioOutcome = "tested_ok" | "tested_failed" | "partial";

export type StepScenarioEvidenceEntry = {
  status: StepScenarioOutcome;
  testedAt: string;
};

/** Último resultado por scenario_id dentro de un step_key. */
export type StepN4ScenarioEvidence = {
  byScenarioId: Map<string, StepScenarioEvidenceEntry>;
};

export type StepTestProgress = {
  scenarios_total: number;
  scenarios_passed: number;
  scenarios_failed: number;
  scenarios_partial: number;
  scenarios_pending: number;
  /** Por escenario (último resultado conocido). */
  scenarios?: Array<{
    id: string;
    label?: string;
    status: StepScenarioOutcome | "pending";
    /** Guardrail opcional: no cuenta en scenarios_total del hito. */
    optional?: boolean;
  }>;
};

export type StepTestStatusForUi =
  | "blocked"
  | "ready_to_test"
  | "partially_tested"
  | "awaiting_n4"
  | "tested_ok"
  | "tested_failed";

type OperationalCaseEventLike = {
  payload_jsonb: unknown;
  created_at: string;
};

type OperationalCaseTestRunLike = {
  level?: string | null;
  status?: string | null;
  step_key?: string | null;
  scenario_id?: string | null;
  result_jsonb?: unknown;
  finished_at?: string | null;
  created_at?: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeScenarioOutcome(raw: unknown): StepScenarioOutcome {
  if (raw === "tested_ok" || raw === "partial") return raw;
  return "tested_failed";
}

/** Agrupa step_test_completed por paso y escenario (último evento gana por escenario). */
export function parseStepScenarioEvidenceFromEvents(
  events: OperationalCaseEventLike[]
): Map<string, StepN4ScenarioEvidence> {
  const byStep = new Map<string, Map<string, StepScenarioEvidenceEntry>>();

  for (const event of events) {
    const payload = event.payload_jsonb;
    if (!isRecord(payload) || payload.kind !== "step_test_completed") continue;
    const stepKey =
      typeof payload.step_key === "string" ? payload.step_key.trim() : "";
    if (!stepKey) continue;

    const scenarioId =
      typeof payload.scenario_id === "string" ? payload.scenario_id.trim() : "";
    const status = normalizeScenarioOutcome(payload.status);
    const entry: StepScenarioEvidenceEntry = {
      status,
      testedAt: event.created_at,
    };

    let scenarios = byStep.get(stepKey);
    if (!scenarios) {
      scenarios = new Map();
      byStep.set(stepKey, scenarios);
    }

    if (scenarioId) {
      scenarios.set(scenarioId, entry);
      continue;
    }

    // Compatibilidad: pruebas antiguas sin scenario_id cuentan como único escenario del paso.
    scenarios.set("__legacy_step_test__", entry);
  }

  const result = new Map<string, StepN4ScenarioEvidence>();
  for (const [stepKey, byScenarioId] of byStep) {
    result.set(stepKey, { byScenarioId });
  }
  return result;
}

/** Fuente principal: operational_case_test_runs (run durable por escenario). */
export function parseStepScenarioEvidenceFromRuns(
  runs: OperationalCaseTestRunLike[]
): Map<string, StepN4ScenarioEvidence> {
  const byStep = new Map<string, Map<string, StepScenarioEvidenceEntry>>();

  for (const run of runs) {
    if (run.level !== "n4") continue;
    if (run.status !== "completed" && run.status !== "failed") continue;
    const stepKey = typeof run.step_key === "string" ? run.step_key.trim() : "";
    if (!stepKey) continue;

    const scenarioId =
      typeof run.scenario_id === "string" ? run.scenario_id.trim() : "";
    const result = run.result_jsonb;
    const resultStatus =
      isRecord(result) && typeof result.status === "string"
        ? result.status
        : run.status === "completed"
          ? "tested_failed"
          : "tested_failed";
    const entry: StepScenarioEvidenceEntry = {
      status: normalizeScenarioOutcome(resultStatus),
      testedAt: run.finished_at ?? run.created_at ?? "",
    };

    let scenarios = byStep.get(stepKey);
    if (!scenarios) {
      scenarios = new Map();
      byStep.set(stepKey, scenarios);
    }
    scenarios.set(scenarioId || "__legacy_step_test__", entry);
  }

  const result = new Map<string, StepN4ScenarioEvidence>();
  for (const [stepKey, byScenarioId] of byStep) {
    result.set(stepKey, { byScenarioId });
  }
  return result;
}

/** Combina evidencia: `primary` (test_runs) gana por scenario_id sobre `secondary` (eventos). */
export function mergeStepScenarioEvidenceMaps(
  primary: Map<string, StepN4ScenarioEvidence>,
  secondary: Map<string, StepN4ScenarioEvidence>
): Map<string, StepN4ScenarioEvidence> {
  const merged = new Map<string, StepN4ScenarioEvidence>();

  for (const [stepKey, evidence] of secondary) {
    merged.set(stepKey, {
      byScenarioId: new Map(evidence.byScenarioId),
    });
  }
  for (const [stepKey, evidence] of primary) {
    const existing = merged.get(stepKey);
    const byScenarioId = new Map(existing?.byScenarioId);
    for (const [scenarioId, entry] of evidence.byScenarioId) {
      byScenarioId.set(scenarioId, entry);
    }
    merged.set(stepKey, { byScenarioId });
  }
  return merged;
}

function scenarioOutcomeForStep(
  evidence: StepN4ScenarioEvidence | undefined,
  scenarioId: string
): StepScenarioEvidenceEntry | undefined {
  return evidence?.byScenarioId.get(scenarioId);
}

export function buildStepTestProgress(params: {
  catalogSlug: string;
  stepKey: string;
  scenarioEvidence?: StepN4ScenarioEvidence;
}): StepTestProgress | null {
  const allScenarios = stepTestScenarioDefsFor(params.catalogSlug, params.stepKey);
  const milestoneScenarios = stepTestMilestoneScenariosFor(
    params.catalogSlug,
    params.stepKey
  );
  if (allScenarios.length === 0) return null;

  const legacyEntry = params.scenarioEvidence?.byScenarioId.get(
    "__legacy_step_test__"
  );
  const hasExplicitScenarioEvidence =
    params.scenarioEvidence != null &&
    [...params.scenarioEvidence.byScenarioId.keys()].some(
      (id) => id !== "__legacy_step_test__"
    );

  let passed = 0;
  let failed = 0;
  let partial = 0;

  if (legacyEntry && !hasExplicitScenarioEvidence) {
    // Prueba antigua sin scenario_id: nunca cerrar el paso completo si hay 2+ escenarios.
    if (legacyEntry.status === "tested_ok") {
      passed = milestoneScenarios.length === 1 ? 1 : 0;
      if (milestoneScenarios.length > 1) {
        partial = 1;
      }
    } else if (legacyEntry.status === "partial") {
      partial = 1;
    } else {
      failed = 1;
    }
  } else {
    for (const scenario of milestoneScenarios) {
      const entry = scenarioOutcomeForStep(params.scenarioEvidence, scenario.id);
      if (!entry) continue;
      if (entry.status === "tested_ok") passed += 1;
      else if (entry.status === "partial") partial += 1;
      else failed += 1;
    }
  }

  const total = milestoneScenarios.length;
  const pending = Math.max(0, total - passed - failed - partial);

  const scenarios = allScenarios.map((scenario) => {
    const entry = scenarioOutcomeForStep(params.scenarioEvidence, scenario.id);
    const status: StepScenarioOutcome | "pending" = entry?.status ?? "pending";
    return {
      id: scenario.id,
      label: scenario.label,
      status,
      optional: !stepTestScenarioCountsTowardMilestone(scenario),
    };
  });

  return {
    scenarios_total: total,
    scenarios_passed: passed,
    scenarios_failed: failed,
    scenarios_partial: partial,
    scenarios_pending: pending,
    scenarios,
  };
}

export function resolveStepN4TestStatus(params: {
  catalogSlug: string;
  stepKey: string;
  scenarioEvidence?: StepN4ScenarioEvidence;
  allSkillsOk: boolean;
  directToolsOk: boolean;
}): { status: StepTestStatusForUi; progress: StepTestProgress | null } {
  const progress = buildStepTestProgress({
    catalogSlug: params.catalogSlug,
    stepKey: params.stepKey,
    scenarioEvidence: params.scenarioEvidence,
  });

  if (!progress || progress.scenarios_total === 0) {
    if (params.allSkillsOk && params.directToolsOk) {
      return { status: "tested_ok", progress: null };
    }
    if (params.allSkillsOk || params.directToolsOk) {
      return { status: "partially_tested", progress: null };
    }
    return { status: "ready_to_test", progress: null };
  }

  const { scenarios_total, scenarios_passed, scenarios_failed, scenarios_partial } =
    progress;

  if (scenarios_passed === scenarios_total) {
    return { status: "tested_ok", progress };
  }

  if (scenarios_passed > 0 || scenarios_partial > 0) {
    return { status: "partially_tested", progress };
  }

  if (scenarios_failed > 0) {
    return { status: "tested_failed", progress };
  }

  if (!params.directToolsOk) {
    return { status: "blocked", progress };
  }

  // Escenarios definidos pero ninguno corrido aún (o solo legacy parcial): no usar ready_to_test.
  return { status: "awaiting_n4", progress };
}
