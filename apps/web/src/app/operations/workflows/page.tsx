/**
 * Workflow Studio — shell read-only (Slice 2.7).
 *
 * Catálogo de definiciones resueltas para el tenant: globales + privadas
 * propias, JAMÁS privadas de otros tenants (2.7-6; no requiere gate de admin
 * porque es lectura del propio tenant). El detalle renderiza un resumen del
 * graph_jsonb — solo display, sin edición/fork/publish (non-goals 2.7-7).
 *
 * [D 2.7-1] Nombre de ruta interino: /operations/workflows. Renombrar después
 * es un redirect barato; no bloqueamos el slice en la decisión de naming.
 */
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  countPinnedActiveCasesByDefinition,
  createServerClient,
  listWorkflowDefinitionsVisibleToUser,
} from "@agents/db";
import type { WorkflowDefinition } from "@agents/types";
import { createClient } from "@/lib/supabase/server";
import { AppShell } from "@/components/app-shell";
import {
  toDefinitionCatalogRow,
  type DefinitionCatalogRow,
} from "@/lib/workflow-studio/definition-catalog";

export const dynamic = "force-dynamic";

function DetailSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
        {title}
      </h3>
      <div className="mt-2 space-y-1 text-xs text-neutral-700 dark:text-neutral-300">
        {children}
      </div>
    </section>
  );
}

function DefinitionDetail({
  definition,
  row,
}: {
  definition: WorkflowDefinition;
  row: DefinitionCatalogRow;
}) {
  const graph = definition.graph_jsonb;
  return (
    <div className="space-y-3">
      <div className="rounded-2xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-950">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="text-sm font-semibold">
            {row.workflowKey} · v{row.version}
          </h2>
          <span className="rounded bg-neutral-200 px-1.5 py-0.5 text-[10px] dark:bg-neutral-800">
            {row.statusLabel}
          </span>
          <span className="rounded bg-neutral-200 px-1.5 py-0.5 text-[10px] dark:bg-neutral-800">
            {row.scopeLabel}
          </span>
          <code className="text-[10px] text-neutral-500">{row.shortHash}</code>
        </div>
        <p className="mt-1 text-xs text-neutral-500">
          Tipo de caso: {row.caseType} · {row.pinnedLabel}
          {row.lineage ? ` · ${row.lineage}` : ""}
        </p>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <DetailSection title={`Estados (${graph.states.length})`}>
          {graph.states.map((state) => (
            <p key={state.key}>
              <code>{state.key}</code>
              {state.label ? ` — ${state.label}` : ""}
              {state.kind === "terminal" ? " · terminal" : ""}
            </p>
          ))}
        </DetailSection>

        <DetailSection title={`Transiciones (${graph.transitions.length})`}>
          {graph.transitions.map((t, i) => (
            <p key={`${t.from}-${t.to}-${i}`}>
              <code>{t.from}</code> → <code>{t.to}</code>
              {t.guards.length > 0 ? ` · guards: ${t.guards.join(", ")}` : ""}
              {t.approval_required ? ` · aprobación: ${t.approval_required}` : ""}
            </p>
          ))}
        </DetailSection>

        <DetailSection title={`Pasos y skills (${graph.step_bindings.length})`}>
          {graph.step_bindings.map((binding) => (
            <p key={binding.state}>
              <code>{binding.state}</code> —{" "}
              {binding.skill ? <code>{binding.skill}</code> : "sin skill"}
              {binding.bigquery_context ? " · contexto BigQuery" : ""}
              {binding.required_assets?.length
                ? ` · assets: ${binding.required_assets
                    .map((asset) => asset.asset_key)
                    .join(", ")}`
                : ""}
            </p>
          ))}
        </DetailSection>

        <DetailSection title={`Plantillas de trabajo (${graph.work_templates.length})`}>
          {graph.work_templates.length === 0 ? (
            <p className="text-neutral-400">Sin plantillas de trabajo.</p>
          ) : (
            graph.work_templates.map((template, i) => (
              <p key={`${template.on_enter_state}-${template.work_type}-${i}`}>
                Al entrar a <code>{template.on_enter_state}</code>:{" "}
                <code>{template.work_type}</code>
                {template.required_capability
                  ? ` · capacidad: ${template.required_capability}`
                  : ""}
                {template.depends_on?.length
                  ? ` · depende de: ${template.depends_on.join(", ")}`
                  : ""}
              </p>
            ))
          )}
        </DetailSection>

        <DetailSection title="Completitud">
          <p>
            Estados terminales:{" "}
            {graph.completion.terminal_states.map((s, i) => (
              <span key={s}>
                {i > 0 ? ", " : ""}
                <code>{s}</code>
              </span>
            ))}
          </p>
          <p>
            Evidencia requerida:{" "}
            {graph.completion.required_evidence.length > 0
              ? graph.completion.required_evidence.join(", ")
              : "ninguna (v1)"}
          </p>
        </DetailSection>

        <DetailSection title={`Postcondiciones y aprobaciones`}>
          {graph.postconditions.length === 0 && graph.approvals.length === 0 ? (
            <p className="text-neutral-400">Sin postcondiciones ni aprobaciones.</p>
          ) : (
            <>
              {graph.postconditions.map((p) => (
                <p key={p.state}>
                  <code>{p.state}</code>: {p.checks.join(", ")}
                </p>
              ))}
              {graph.approvals.map((a) => (
                <p key={a.kind}>
                  Aprobación <code>{a.kind}</code> · evidencia:{" "}
                  {a.evidence_inputs.join(", ")}
                </p>
              ))}
            </>
          )}
        </DetailSection>
      </div>
    </div>
  );
}

export default async function WorkflowStudioCatalogPage({
  searchParams,
}: {
  searchParams: Promise<{ definition?: string }>;
}) {
  const auth = await createClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) redirect("/login");

  const sp = await searchParams;
  const db = createServerClient();

  let definitions: WorkflowDefinition[] = [];
  let pinnedCounts: Record<string, number> = {};
  let unavailable = false;
  try {
    [definitions, pinnedCounts] = await Promise.all([
      listWorkflowDefinitionsVisibleToUser(db, user.id),
      countPinnedActiveCasesByDefinition(db, user.id),
    ]);
  } catch {
    unavailable = true;
  }

  const rows = definitions.map((definition) =>
    toDefinitionCatalogRow(definition, pinnedCounts)
  );
  // El detalle solo resuelve ids ya visibles para el tenant — nunca se
  // consulta un id arbitrario (2.7-6).
  const selected = sp.definition
    ? definitions.find((definition) => definition.id === sp.definition)
    : undefined;
  const selectedRow = selected
    ? rows.find((row) => row.id === selected.id)
    : undefined;

  return (
    <AppShell
      title="Workflows"
      description="Catálogo read-only de definiciones de workflow: globales y privadas de tu cuenta."
    >
      <div className="mb-4 flex items-center justify-between gap-3">
        <p className="text-xs text-neutral-500">
          Solo lectura: crear, editar, fork y publish llegan en fases
          posteriores del Workflow Studio.
        </p>
        <Link
          href="/operations/workflows/assets"
          className="shrink-0 rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-xs font-semibold hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
        >
          Recursos de la cuenta
        </Link>
      </div>

      {unavailable ? (
        <div className="rounded-2xl border border-dashed border-neutral-300 bg-white p-8 text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900">
          El catálogo de definiciones no está disponible en este entorno.
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-neutral-300 bg-white p-8 text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900">
          No hay definiciones de workflow publicadas ni en borrador todavía.
        </div>
      ) : selected && selectedRow ? (
        <div className="space-y-3">
          <Link
            href="/operations/workflows"
            className="inline-block text-xs font-semibold text-violet-700 hover:underline dark:text-violet-300"
          >
            ← Volver al catálogo
          </Link>
          <DefinitionDetail definition={selected} row={selectedRow} />
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {rows.map((row) => (
            <Link
              key={row.id}
              href={`/operations/workflows?definition=${row.id}`}
              className="rounded-2xl border border-neutral-200 bg-white p-4 text-xs shadow-sm transition hover:border-violet-300 dark:border-neutral-800 dark:bg-neutral-900 dark:hover:border-violet-700"
            >
              <div className="flex items-start justify-between gap-2">
                <p className="font-semibold text-neutral-900 dark:text-neutral-100">
                  {row.workflowKey} · v{row.version}
                </p>
                <span className="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                  {row.statusLabel}
                </span>
              </div>
              <p className="mt-1 text-neutral-500">
                {row.caseType} · {row.scopeLabel}
              </p>
              <p className="mt-1 text-neutral-500">
                <code className="text-[10px]">{row.shortHash}</code> ·{" "}
                {row.pinnedLabel}
              </p>
              {row.lineage ? (
                <p className="mt-1 text-neutral-400">{row.lineage}</p>
              ) : null}
            </Link>
          ))}
        </div>
      )}
    </AppShell>
  );
}
