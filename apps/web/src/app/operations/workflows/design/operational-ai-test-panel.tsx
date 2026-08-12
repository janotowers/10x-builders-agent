"use client";

import { useCallback, useEffect, useState } from "react";

type QualificationStatus =
  | "missing"
  | "pending"
  | "running"
  | "passed"
  | "failed"
  | "stale"
  | "non_convergent";

type QualificationScenario = {
  id: string;
  label: string;
  passed: boolean;
  detail?: string | null;
};

type QualificationView = {
  status: QualificationStatus;
  resultKind?:
    | "passed"
    | "failed_by_verdict"
    | "inconclusive_infrastructure"
    | null;
  repairEligible?: boolean;
  fingerprint?: string | null;
  executorModels?: string[];
  judgeModel?: string | null;
  scenarios?: QualificationScenario[];
  latencyMs?: number | null;
  costMicroUsd?: number | null;
  createdAt?: string | null;
  staleReasons?: string[];
  summary?: string | null;
  runId?: string | null;
  repairIteration?: number | null;
  repairProposal?: RepairProposal | null;
};

type RepairProposal = {
  id: string;
  status: "proposed";
  sourceSkillSlug: string;
  sourceSkillVersion: number;
  sourceRunId: string;
  sourceFingerprint: string;
  repairIteration: number;
  bodyMd: string;
  compilerModelId: string;
  createdAt: string;
};

const STATUS_LABEL: Record<QualificationStatus, string> = {
  missing: "Sin ejecutar",
  pending: "Pendiente",
  running: "Ejecutando",
  passed: "Aprobada",
  failed: "Fallida",
  stale: "Desactualizada",
  non_convergent: "Inconclusa",
};

function formatCost(microUsd: number | null | undefined): string | null {
  if (typeof microUsd !== "number" || !Number.isFinite(microUsd)) return null;
  return `$${(microUsd / 1_000_000).toFixed(4)} USD`;
}

export function OperationalAiTestPanel({
  artifactKind,
  artifactId,
}: {
  artifactKind: "case_workflow" | "durable_task" | "reusable_skill" | "schedule";
  artifactId: string;
}) {
  const [view, setView] = useState<QualificationView>({ status: "missing" });
  const [loading, setLoading] = useState(true);
  const [repairing, setRepairing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [repairProposal, setRepairProposal] =
    useState<RepairProposal | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ artifactKind, artifactId });
      const response = await fetch(`/api/studio-operational-tests?${params}`, {
        cache: "no-store",
      });
      const json = (await response.json()) as QualificationView & {
        error?: string;
      };
      if (!response.ok) throw new Error(json.error || "No se pudo cargar la prueba.");
      setView(json);
      setRepairProposal(json.repairProposal ?? null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [artifactId, artifactKind]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run() {
    setLoading(true);
    setError(null);
    setRepairProposal(null);
    setView((current) => ({ ...current, status: "running" }));
    try {
      const response = await fetch("/api/studio-operational-tests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ artifactKind, artifactId }),
      });
      const json = (await response.json()) as QualificationView & {
        error?: string;
      };
      if (!response.ok) throw new Error(json.error || "La prueba no pudo completarse.");
      setView(json);
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : String(runError));
      await load();
    } finally {
      setLoading(false);
    }
  }

  async function repair() {
    if (
      artifactKind !== "reusable_skill" ||
      view.status !== "failed" ||
      view.resultKind !== "failed_by_verdict" ||
      !view.repairEligible ||
      !view.runId
    ) {
      return;
    }
    setRepairing(true);
    setError(null);
    try {
      const response = await fetch("/api/studio-operational-tests/repair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          artifactKind,
          artifactId,
          sourceRunId: view.runId,
        }),
      });
      const json = (await response.json()) as {
        proposal?: RepairProposal;
        error?: string;
      };
      if (!response.ok || !json.proposal) {
        throw new Error(
          json.error || "No se pudo crear la propuesta de reparación."
        );
      }
      setRepairProposal(json.proposal);
    } catch (repairError) {
      setError(
        repairError instanceof Error ? repairError.message : String(repairError)
      );
    } finally {
      setRepairing(false);
    }
  }

  const cost = formatCost(view.costMicroUsd);
  return (
    <section className="rounded-xl border border-neutral-200 bg-white p-3 text-xs dark:border-neutral-800 dark:bg-neutral-900">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-semibold">Prueba con IA operativa</h3>
          <p className="mt-0.5 text-[11px] text-neutral-500 dark:text-neutral-400">
            Ejecuta el artefacto con el modelo de producción en un sandbox; no
            realiza envíos ni publicaciones externas.
          </p>
        </div>
        <span className="rounded bg-neutral-100 px-2 py-1 text-[10px] font-semibold dark:bg-neutral-800">
          {STATUS_LABEL[view.status]}
        </span>
      </div>

      {view.status === "stale" ? (
        <p className="mt-2 rounded-md bg-amber-50 px-2 py-1.5 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          Cambió el artefacto, el modelo o la rúbrica. Recalifica antes de una
          nueva activación.
        </p>
      ) : null}
      {view.resultKind === "inconclusive_infrastructure" ? (
        <p className="mt-2 rounded-md bg-amber-50 px-2 py-1.5 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          La ejecución no recibió un veredicto válido por una falla de
          infraestructura. No se considera un fallo del artefacto y no se puede
          generar una reparación; vuelve a ejecutar la calificación.
        </p>
      ) : null}
      {view.summary ? (
        <p className="mt-2 text-neutral-700 dark:text-neutral-200">{view.summary}</p>
      ) : null}
      {error ? (
        <p className="mt-2 rounded-md bg-red-50 px-2 py-1.5 text-red-700 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={loading || view.status === "running"}
          onClick={() => void run()}
          className="rounded-md bg-violet-700 px-3 py-1.5 font-semibold text-white hover:bg-violet-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading || view.status === "running"
            ? "Ejecutando…"
            : view.status === "missing"
              ? "Ejecutar prueba"
              : "Recalificar"}
        </button>
        {view.createdAt ? (
          <span className="text-[10px] text-neutral-400">
            Última corrida {new Date(view.createdAt).toLocaleString("es-MX")}
          </span>
        ) : null}
      </div>

      {artifactKind === "reusable_skill" &&
      view.status === "failed" &&
      view.resultKind === "failed_by_verdict" &&
      view.repairEligible === true &&
      !repairProposal ? (
        <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-2 dark:border-amber-900 dark:bg-amber-950/30">
          <p className="text-[11px] text-amber-900 dark:text-amber-100">
            La reparación crea una propuesta de borrador nueva para revisión.
            No modifica este borrador, no vuelve a probarlo y no lo publica ni
            activa.
          </p>
          <button
            type="button"
            disabled={loading || repairing || !view.runId}
            onClick={() => void repair()}
            className="mt-2 rounded-md border border-amber-400 bg-white px-3 py-1.5 font-semibold text-amber-900 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
          >
            {repairing
              ? "Creando propuesta…"
              : "Crear nueva propuesta de borrador"}
          </button>
        </div>
      ) : null}

      {repairProposal ? (
        <details
          open
          className="mt-3 rounded-md border border-violet-200 bg-violet-50 p-2 dark:border-violet-900 dark:bg-violet-950/30"
        >
          <summary className="cursor-pointer font-semibold text-violet-900 dark:text-violet-100">
            Revisar propuesta de reparación #{repairProposal.repairIteration}
          </summary>
          <p className="mt-2 text-[11px] text-violet-800 dark:text-violet-200">
            Propuesta guardada para revisión. Debes aplicarla explícitamente,
            volver a ejecutar la prueba y publicar o activar por separado.
          </p>
          <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded bg-white p-2 text-[10px] text-neutral-800 dark:bg-neutral-950 dark:text-neutral-200">
            {repairProposal.bodyMd}
          </pre>
          <p className="mt-2 break-all text-[10px] text-neutral-500">
            Propuesta {repairProposal.id} · versión fuente{" "}
            {repairProposal.sourceSkillVersion} · modelo{" "}
            {repairProposal.compilerModelId}
          </p>
        </details>
      ) : null}

      {view.scenarios?.length ||
      view.executorModels?.length ||
      view.judgeModel ||
      view.staleReasons?.length ? (
        <details className="mt-3 rounded-md border border-neutral-200 px-2 py-1 dark:border-neutral-700">
          <summary className="cursor-pointer font-medium">Ver evidencia técnica</summary>
          <div className="mt-2 space-y-2 text-[11px]">
            {view.executorModels?.length ? (
              <p>
                <span className="text-neutral-500">Modelos ejecutores:</span>{" "}
                {view.executorModels.join(", ")}
              </p>
            ) : null}
            {view.judgeModel ? (
              <p>
                <span className="text-neutral-500">Juez:</span> {view.judgeModel}
              </p>
            ) : null}
            {typeof view.latencyMs === "number" || cost ? (
              <p>
                {typeof view.latencyMs === "number"
                  ? `${Math.round(view.latencyMs)} ms`
                  : null}
                {typeof view.latencyMs === "number" && cost ? " · " : null}
                {cost}
              </p>
            ) : null}
            {view.staleReasons?.length ? (
              <ul className="list-disc pl-4">
                {view.staleReasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            ) : null}
            {view.scenarios?.length ? (
              <ul className="space-y-1">
                {view.scenarios.map((scenario) => (
                  <li key={scenario.id}>
                    {view.resultKind === "inconclusive_infrastructure"
                      ? "?"
                      : scenario.passed
                        ? "✓"
                        : "✗"}{" "}
                    {scenario.label}
                    {scenario.detail ? ` — ${scenario.detail}` : ""}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </details>
      ) : null}
    </section>
  );
}
