"use client";

import type { OperationalCaseFlowStepDecision } from "@agents/types";
import { scenarioBranchBadgeLabel } from "@/lib/operational-cases/step-decision-ui";

/**
 * Bloque de solo lectura: mapa de ramas del paso (PATTERN_STEP_BRANCH_DECISION).
 * No ejecuta el IF; documenta caminos para el configurador.
 */
export function StepDecisionPanel({
  decision,
}: {
  decision: OperationalCaseFlowStepDecision;
}) {
  return (
    <div className="rounded-lg border border-teal-200/80 bg-teal-50/40 p-3 text-[11px] text-teal-950 dark:border-teal-900/50 dark:bg-teal-950/20 dark:text-teal-100">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-teal-800 dark:text-teal-300">
        Decisión del paso
      </div>
      <div className="mt-1 font-semibold text-sm text-teal-950 dark:text-teal-50">
        {decision.label}
      </div>
      {decision.description ? (
        <p className="mt-1 text-teal-800/90 dark:text-teal-200/80">
          {decision.description}
        </p>
      ) : null}
      <div className="mt-2 space-y-1 text-teal-800 dark:text-teal-200/90">
        {decision.context_key ? (
          <p>
            Condición:{" "}
            <span className="font-mono text-[10px]">{decision.context_key}</span>
          </p>
        ) : null}
        {decision.decided_by_hint ? (
          <p>Se fija: {decision.decided_by_hint}</p>
        ) : null}
        <p className="text-teal-700/80 dark:text-teal-300/70">
          El panel no ejecuta esta decisión; el runtime usa el estado del caso.
        </p>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {decision.branches.map((branch) => (
          <div
            key={branch.value}
            className="rounded border border-teal-200/70 bg-white/80 p-2 dark:border-teal-800/60 dark:bg-neutral-900/60"
          >
            <div className="font-semibold text-teal-950 dark:text-teal-50">
              Rama · {branch.label}
            </div>
            <div className="mt-0.5 font-mono text-[10px] text-teal-700 dark:text-teal-300">
              {branch.value}
              {branch.expected_status ? ` · ${branch.expected_status}` : ""}
            </div>
            {branch.description ? (
              <p className="mt-1 text-teal-800/90 dark:text-teal-200/80">
                {branch.description}
              </p>
            ) : null}
            {(branch.primary_tool_ids?.length ?? 0) > 0 ? (
              <p className="mt-1.5 text-teal-800 dark:text-teal-200">
                Tools:{" "}
                <span className="font-mono text-[10px]">
                  {branch.primary_tool_ids!.join(", ")}
                </span>
              </p>
            ) : null}
            {(branch.scenario_ids?.length ?? 0) > 0 ? (
              <p className="mt-1 text-teal-800 dark:text-teal-200">
                Escenarios N4:{" "}
                <span className="font-mono text-[10px]">
                  {branch.scenario_ids!.join(", ")}
                </span>
              </p>
            ) : null}
          </div>
        ))}
      </div>

      {(decision.shared_tool_ids?.length ?? 0) > 0 ? (
        <p className="mt-2 text-teal-800 dark:text-teal-200">
          Compartidas:{" "}
          <span className="font-mono text-[10px]">
            {decision.shared_tool_ids!.join(", ")}
          </span>
        </p>
      ) : null}
    </div>
  );
}

/** Badge pequeño para tool o escenario ligado a una rama. */
export function StepDecisionBranchBadge({
  label,
}: {
  label: string;
}) {
  return (
    <span className="inline-flex rounded-full bg-teal-100 px-1.5 py-0.5 text-[10px] font-semibold text-teal-900 dark:bg-teal-950/70 dark:text-teal-200">
      {label}
    </span>
  );
}

export function StepDecisionScenarioBadge({
  decision,
  scenarioId,
}: {
  decision: OperationalCaseFlowStepDecision | null | undefined;
  scenarioId: string;
}) {
  const label = scenarioBranchBadgeLabel(decision, scenarioId);
  if (!label) return null;
  return <StepDecisionBranchBadge label={label} />;
}
