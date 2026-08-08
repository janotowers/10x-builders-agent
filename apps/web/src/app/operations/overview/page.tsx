/**
 * Trabajo durable de Control operativo — nivel caso / tarea durable.
 *
 * Tablero: bandeja roja Bloqueado (work bloqueado) y bandeja ámbar Pausado
 * arriba si aplican + camino Atención / En marcha / Externos / Terminado.
 * Toggle Lista. Clic → detalle con fechas → unidades de trabajo.
 */
import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import {
  createServerClient,
  getDurableTask,
  listOperationalCasesForUser,
  listDurableTasksForUser,
  listWorkRunsForTask,
  summarizeWorkRuns,
  summarizeCaseWork,
  type CaseWorkSummary,
  type WorkRunWorkSummary,
} from "@agents/db";
import type { DurableTask, OperationalCase, WorkRun } from "@agents/types";
import { createClient } from "@/lib/supabase/server";
import { AppShell } from "@/components/app-shell";
import { OperationsControlTabs } from "@/app/operations/operations-control-tabs";
import {
  classifyDurableWorkColumn,
  DURABLE_WORK_BLOCKED_COLUMN,
  DURABLE_WORK_FLOW_COLUMNS,
  DURABLE_WORK_PAUSED_COLUMN,
  durableCaseDetailDateRows,
  durableCaseStatusLabel,
  formatDurableDateTime,
  type DurableWorkColumn,
  type DurableWorkColumnId,
} from "@/lib/operations/durable-work-view-labels";
import { formatOperationalCaseTypeForDisplay } from "@/lib/operational-cases/conversation-case-identity";
import {
  formatOperationalStepForDisplay,
  friendlyOperationalStepLabel,
  OperationalStepLabelResolver,
  type OperationalStepLabelMap,
} from "@/lib/operational-cases/operational-step-labels";
import { caseWorkChipLabel } from "@/lib/operations/work-view-labels";

export const dynamic = "force-dynamic";

const COLUMN_ACCENTS: Record<
  DurableWorkColumnId,
  { dot: string; count: string; border: string; trayBg?: string }
> = {
  needs_attention: {
    dot: "bg-amber-500",
    count: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
    border: "border-t-amber-400 dark:border-t-amber-600",
  },
  in_progress: {
    dot: "bg-sky-500",
    count: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200",
    border: "border-t-sky-400 dark:border-t-sky-600",
  },
  waiting_external: {
    dot: "bg-violet-500",
    count: "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200",
    border: "border-t-violet-400 dark:border-t-violet-600",
  },
  blocked: {
    dot: "bg-red-500",
    count: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200",
    border: "border-t-red-400 dark:border-t-red-600",
    trayBg: "bg-red-50/60 dark:bg-red-950/20",
  },
  paused: {
    dot: "bg-neutral-400",
    count: "bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
    border: "border-t-neutral-400 dark:border-t-neutral-600",
    trayBg: "bg-neutral-100/80 dark:bg-neutral-900/60",
  },
  done: {
    dot: "bg-emerald-500",
    count: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
    border: "border-t-emerald-400 dark:border-t-emerald-600",
  },
};

function caseTitle(opCase: OperationalCase): string {
  const ctx = opCase.context_jsonb ?? {};
  const candidate =
    (typeof ctx.property_title === "string" && ctx.property_title.trim()) ||
    (typeof ctx.title === "string" && ctx.title.trim()) ||
    (typeof ctx.nickname === "string" && ctx.nickname.trim());
  return candidate || `${opCase.case_type} · ${opCase.id.slice(0, 8)}…`;
}

function statusCountsLabel(byStatus: Partial<Record<string, number>>): string {
  const parts: string[] = [];
  const order = [
    ["running", "en ejecución"],
    ["ready", "listos"],
    ["todo", "por hacer"],
    ["review", "en revisión"],
    ["blocked", "bloqueados"],
    ["done", "terminados"],
  ] as const;
  for (const [key, label] of order) {
    const n = byStatus[key] ?? 0;
    if (n > 0) parts.push(`${n} ${label}`);
  }
  return parts.join(" · ");
}

function overviewHref(opts: {
  vista: "tablero" | "lista";
  caseId?: string | null;
  durableTaskId?: string | null;
  workRunId?: string | null;
  /** Expandir la bandeja Pausado (colapsada por defecto: no tapa el camino). */
  showPaused?: boolean;
}): string {
  const params = new URLSearchParams();
  if (opts.vista === "lista") params.set("vista", "lista");
  if (opts.showPaused) params.set("pausados", "1");
  if (opts.caseId) params.set("case", opts.caseId);
  if (opts.durableTaskId) params.set("durable_task", opts.durableTaskId);
  if (opts.workRunId) params.set("run", opts.workRunId);
  const qs = params.toString();
  return qs ? `/operations/overview?${qs}` : "/operations/overview";
}

/** Tope de tarjetas al expandir Pausado; el resto se ve mejor en Lista. */
const PAUSED_EXPANDED_PREVIEW = 6;

function CaseCard({
  opCase,
  summary,
  selected,
  href,
  stepLabels,
}: {
  opCase: OperationalCase;
  summary: CaseWorkSummary | undefined;
  selected: boolean;
  href: string;
  stepLabels?: OperationalStepLabelMap;
}) {
  const chip = summary ? caseWorkChipLabel(summary) : "Sin unidades";
  const detail = summary ? statusCountsLabel(summary.byStatus) : "";
  const stepFriendly = friendlyOperationalStepLabel(
    opCase.current_step,
    stepLabels
  );
  return (
    <Link
      href={href}
      className={`block rounded-xl border bg-white p-3 text-xs shadow-sm transition dark:bg-neutral-900 ${
        selected
          ? "border-sky-400 ring-2 ring-sky-200 dark:border-sky-500 dark:ring-sky-900"
          : "border-neutral-200 hover:border-neutral-400 dark:border-neutral-800 dark:hover:border-neutral-600"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 font-semibold leading-snug text-neutral-900 dark:text-neutral-100">
          {caseTitle(opCase)}
        </p>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
            (summary?.blocked ?? 0) > 0
              ? "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200"
              : "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
          }`}
        >
          {chip || "0 trabajos"}
        </span>
      </div>
      <p className="mt-1 text-[11px] text-neutral-500">
        {durableCaseStatusLabel(opCase.status)}
        {stepFriendly ? ` · Paso: ${stepFriendly}` : ""}
      </p>
      {detail ? (
        <p className="mt-1 text-[11px] text-neutral-500">{detail}</p>
      ) : null}
      <p className="mt-2 text-[10px] text-neutral-400">
        Actualizado {formatDurableDateTime(opCase.updated_at)}
      </p>
    </Link>
  );
}

type DurableTaskView = {
  task: DurableTask;
  run: WorkRun | null;
  summary: WorkRunWorkSummary | undefined;
  column: DurableWorkColumnId;
};

function classifyDurableTaskView(
  task: DurableTask,
  run: WorkRun | null,
  summary: WorkRunWorkSummary | undefined
): DurableWorkColumnId {
  if ((summary?.blocked ?? 0) > 0 || task.status === "failed") return "blocked";
  if (task.status === "paused") return "paused";
  if (
    task.status === "completed" ||
    (run?.status === "succeeded" && !task.schedule_ref)
  ) {
    return "done";
  }
  if ((summary?.byStatus.review ?? 0) > 0) return "needs_attention";
  return "in_progress";
}

function DurableTaskCard({
  view,
  selected,
  href,
}: {
  view: DurableTaskView;
  selected: boolean;
  href: string;
}) {
  const detail = view.summary ? statusCountsLabel(view.summary.byStatus) : "";
  return (
    <Link
      href={href}
      className={`block rounded-xl border bg-white p-3 text-xs shadow-sm transition dark:bg-neutral-900 ${
        selected
          ? "border-violet-400 ring-2 ring-violet-200 dark:border-violet-500 dark:ring-violet-900"
          : "border-neutral-200 hover:border-neutral-400 dark:border-neutral-800 dark:hover:border-neutral-600"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 font-semibold leading-snug text-neutral-900 dark:text-neutral-100">
          {view.task.title}
        </p>
        <span className="shrink-0 rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-semibold text-violet-800 dark:bg-violet-950 dark:text-violet-200">
          Tarea durable
        </span>
      </div>
      <p className="mt-1 text-[11px] text-neutral-500">
        {DURABLE_TASK_STATUS_LABELS[view.task.status] ?? view.task.status}
        {view.run ? ` · Run ${view.run.status}` : " · Sin ejecuciones"}
      </p>
      {detail ? <p className="mt-1 text-[11px] text-neutral-500">{detail}</p> : null}
      <p className="mt-2 text-[10px] text-neutral-400">
        Actualizada {formatDurableDateTime(view.task.updated_at)}
      </p>
    </Link>
  );
}

const DURABLE_TASK_STATUS_LABELS: Record<string, string> = {
  draft: "Borrador",
  active: "Activa",
  paused: "Pausada",
  completed: "Completada",
  cancelled: "Cancelada",
  failed: "Fallida",
};

function DurableTaskDetailPanel({
  view,
  clearHref,
}: {
  view: DurableTaskView;
  clearHref: string;
}) {
  return (
    <div className="mb-4 rounded-2xl border border-violet-200 bg-violet-50 px-4 py-3 text-sm text-violet-950 dark:border-violet-900 dark:bg-violet-950 dark:text-violet-100">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-semibold">{view.task.title}</p>
          <p className="mt-1 text-xs opacity-80">{view.task.objective}</p>
          <p className="mt-1 text-xs">
            {DURABLE_TASK_STATUS_LABELS[view.task.status] ?? view.task.status}
            {view.run ? ` · Ejecución ${view.run.status}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {view.run ? (
            <Link
              href={`/operations/work?run=${view.run.id}&historial=1`}
              className="rounded-md border border-violet-400 bg-white px-3 py-1.5 text-xs font-semibold text-violet-900 dark:border-violet-700 dark:bg-violet-900 dark:text-violet-100"
            >
              Ver unidades de trabajo →
            </Link>
          ) : null}
          <Link
            href={clearHref}
            className="rounded-md border border-violet-300 px-3 py-1.5 text-xs font-semibold"
          >
            Cerrar detalle
          </Link>
        </div>
      </div>
      {view.summary ? (
        <p className="mt-2 text-xs opacity-80">
          Unidades: {view.summary.total} ·{" "}
          {statusCountsLabel(view.summary.byStatus) || "sin actividad"}
        </p>
      ) : null}
      {view.run?.result_jsonb ? (
        <pre className="mt-3 overflow-x-auto rounded-lg bg-white/70 p-3 text-[11px] dark:bg-violet-900/50">
          {JSON.stringify(view.run.result_jsonb, null, 2)}
        </pre>
      ) : null}
    </div>
  );
}

function Column({
  column,
  children,
  count,
}: {
  column: DurableWorkColumn;
  children: ReactNode;
  count: number;
}) {
  const accent = COLUMN_ACCENTS[column.id];
  return (
    <section
      className={`min-w-0 rounded-2xl border border-t-4 border-neutral-200 bg-neutral-50 p-2.5 dark:border-neutral-800 dark:bg-neutral-950 ${accent.border}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-1">
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${accent.dot}`} />
          <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
            {column.label}
          </h2>
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${accent.count}`}
          >
            {count}
          </span>
        </div>
      </div>
      <p className="mt-0.5 px-1 text-[10px] text-neutral-400">
        {column.description}
      </p>
      <div className="mt-2 space-y-2">{children}</div>
    </section>
  );
}

function ExceptionTray({
  column,
  cases,
  workByCase,
  selectedCaseId,
  cardHref,
  hint,
  collapsed,
  expandHref,
  collapseHref,
  previewLimit,
  listHref,
  stepLabelsByCaseId,
}: {
  column: DurableWorkColumn;
  cases: OperationalCase[];
  workByCase: Map<string, CaseWorkSummary>;
  selectedCaseId: string | null;
  cardHref: (caseId: string) => string;
  hint: string;
  /** Si true, solo barra resumen (no tapa el camino operativo). */
  collapsed?: boolean;
  expandHref?: string;
  collapseHref?: string;
  previewLimit?: number;
  listHref?: string;
  stepLabelsByCaseId: Map<string, OperationalStepLabelMap>;
}) {
  const accent = COLUMN_ACCENTS[column.id];
  const preview =
    previewLimit != null && !collapsed
      ? cases.slice(0, previewLimit)
      : cases;
  const hiddenCount = Math.max(0, cases.length - preview.length);

  if (collapsed) {
    return (
      <section
        className={`rounded-xl border border-t-4 border-neutral-200 px-3 py-2.5 dark:border-neutral-800 ${accent.trayBg ?? "bg-neutral-50"} ${accent.border}`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className={`h-2 w-2 shrink-0 rounded-full ${accent.dot}`} />
            <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
              {column.label}
            </h2>
            <span
              className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${accent.count}`}
            >
              {cases.length}
            </span>
            <p className="text-[11px] text-neutral-500">{hint}</p>
          </div>
          {expandHref ? (
            <Link
              href={expandHref}
              className="shrink-0 rounded-md border border-neutral-300 bg-white px-2.5 py-1 text-xs font-semibold text-neutral-700 hover:bg-neutral-50 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800"
            >
              Mostrar
            </Link>
          ) : null}
        </div>
      </section>
    );
  }

  return (
    <section
      className={`rounded-2xl border border-t-4 border-neutral-200 p-3 dark:border-neutral-800 ${accent.trayBg ?? "bg-neutral-50"} ${accent.border}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-1">
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${accent.dot}`} />
          <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
            {column.label}
          </h2>
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${accent.count}`}
          >
            {cases.length}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
            {hint}
          </p>
          {collapseHref ? (
            <Link
              href={collapseHref}
              className="rounded-md border border-neutral-300 bg-white px-2 py-0.5 text-[11px] font-semibold text-neutral-700 hover:bg-neutral-50 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-200"
            >
              Ocultar
            </Link>
          ) : null}
        </div>
      </div>
      <p className="mt-0.5 px-1 text-[10px] text-neutral-400">
        {column.description}
      </p>
      <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {preview.map((opCase) => (
          <CaseCard
            key={opCase.id}
            opCase={opCase}
            summary={workByCase.get(opCase.id)}
            selected={opCase.id === selectedCaseId}
            href={cardHref(opCase.id)}
            stepLabels={stepLabelsByCaseId.get(opCase.id)}
          />
        ))}
      </div>
      {hiddenCount > 0 && listHref ? (
        <p className="mt-2 px-1 text-[11px] text-neutral-500">
          +{hiddenCount} más.{" "}
          <Link href={listHref} className="font-semibold underline">
            Ver todos en Lista
          </Link>
        </p>
      ) : null}
    </section>
  );
}

function CaseDetailPanel({
  opCase,
  summary,
  clearHref,
  workHref,
  stepLabels,
}: {
  opCase: OperationalCase;
  summary: CaseWorkSummary | undefined;
  clearHref: string;
  workHref: string;
  stepLabels?: OperationalStepLabelMap;
}) {
  const dateRows = durableCaseDetailDateRows({
    status: opCase.status,
    createdAt: opCase.created_at,
    updatedAt: opCase.updated_at,
    nextActionAt: opCase.next_action_at,
    dueAt: opCase.due_at,
  });
  // Detalle: natural + técnico entre paréntesis (tarjetas siguen solo natural).
  const stepForDetail = opCase.current_step
    ? formatOperationalStepForDisplay(opCase.current_step, stepLabels)
    : null;
  const caseTypeForDetail = formatOperationalCaseTypeForDisplay(
    opCase.case_type
  );
  return (
    <div className="mb-4 rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-950 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-100">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-semibold">{caseTitle(opCase)}</p>
          <p className="mt-0.5 text-xs opacity-80">
            {caseTypeForDetail} ·{" "}
            <code className="text-[11px]">{opCase.id}</code>
          </p>
          <p className="mt-1 text-xs">
            <span className="font-semibold">
              {durableCaseStatusLabel(opCase.status)}
            </span>
            {stepForDetail ? (
              <span className="opacity-80"> · Paso: {stepForDetail}</span>
            ) : null}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href={workHref}
            className="rounded-md border border-sky-400 bg-white px-3 py-1.5 text-xs font-semibold text-sky-900 hover:bg-sky-100 dark:border-sky-700 dark:bg-sky-900 dark:text-sky-100 dark:hover:bg-sky-800"
          >
            Ver unidades de trabajo →
          </Link>
          <Link
            href={clearHref}
            className="rounded-md border border-sky-300 px-3 py-1.5 text-xs font-semibold hover:bg-sky-100 dark:border-sky-800 dark:hover:bg-sky-900"
          >
            Cerrar detalle
          </Link>
        </div>
      </div>
      {dateRows.length > 0 ? (
        <ol className="mt-3 flex list-none flex-wrap items-stretch gap-0 overflow-x-auto rounded-lg border border-sky-200/80 bg-white/60 dark:border-sky-800 dark:bg-sky-900/40">
          {dateRows.map((row, index) => (
            <li
              key={row.label}
              className={`min-w-[9.5rem] flex-1 px-3 py-2 ${
                index > 0
                  ? "border-l border-sky-200/80 dark:border-sky-800"
                  : ""
              }`}
            >
              <p className="text-[10px] font-semibold uppercase tracking-wide opacity-70">
                {row.label}
              </p>
              <p className="mt-0.5 text-xs font-medium leading-snug">
                {row.value}
              </p>
            </li>
          ))}
        </ol>
      ) : null}
      {summary ? (
        <p className="mt-2 text-xs opacity-80">
          Unidades: {caseWorkChipLabel(summary) || "ninguna"}
          {statusCountsLabel(summary.byStatus)
            ? ` · ${statusCountsLabel(summary.byStatus)}`
            : ""}
        </p>
      ) : (
        <p className="mt-2 text-xs opacity-80">Sin unidades de trabajo aún.</p>
      )}
    </div>
  );
}

export default async function OperationsOverviewPage({
  searchParams,
}: {
  searchParams: Promise<{
    vista?: string;
    case?: string;
    durable_task?: string;
    run?: string;
    pausados?: string;
  }>;
}) {
  const auth = await createClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await auth
    .from("profiles")
    .select("is_ungga_admin")
    .eq("id", user.id)
    .single();
  if (profile?.is_ungga_admin !== true) {
    return (
      <AppShell
        title="Control operativo"
        description="Casos y tareas durables en curso."
      >
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
          <p className="font-semibold">Sin acceso de operador</p>
          <p className="mt-2">
            Esta vista requiere <code>profiles.is_ungga_admin = true</code>.
          </p>
        </div>
      </AppShell>
    );
  }

  const sp = await searchParams;
  const vista: "tablero" | "lista" =
    sp.vista === "lista" ? "lista" : "tablero";
  const showPaused = sp.pausados === "1";
  const selectedCaseId =
    typeof sp.case === "string" && sp.case.trim() ? sp.case.trim() : null;
  const selectedDurableTaskId =
    typeof sp.durable_task === "string" && sp.durable_task.trim()
      ? sp.durable_task.trim()
      : null;
  const selectedWorkRunId =
    typeof sp.run === "string" && sp.run.trim() ? sp.run.trim() : null;

  const db = createServerClient();
  let activeCases: OperationalCase[] = [];
  let doneCases: OperationalCase[] = [];
  let workByCase = new Map<string, CaseWorkSummary>();
  let durableTaskViews: DurableTaskView[] = [];
  let unavailable = false;
  try {
    activeCases = await listOperationalCasesForUser(db, user.id, {
      statuses: ["active", "waiting_internal", "waiting_external", "paused"],
      limit: 100,
    });
    // Terminado es columna del camino operativo: siempre cargamos recientes.
    doneCases = await listOperationalCasesForUser(db, user.id, {
      statuses: ["completed", "failed"],
      limit: 50,
    });
    const allIds = [
      ...activeCases.map((c) => c.id),
      ...doneCases.map((c) => c.id),
      ...(selectedCaseId ? [selectedCaseId] : []),
    ];
    workByCase = await summarizeCaseWork(db, user.id, [
      ...new Set(allIds),
    ]);

    if (
      selectedCaseId &&
      !activeCases.some((c) => c.id === selectedCaseId) &&
      !doneCases.some((c) => c.id === selectedCaseId)
    ) {
      const { data: selectedRow } = await db
        .from("operational_cases")
        .select("*")
        .eq("user_id", user.id)
        .eq("id", selectedCaseId)
        .maybeSingle();
      if (selectedRow) {
        const selected = selectedRow as OperationalCase;
        if (selected.status === "completed" || selected.status === "failed") {
          doneCases = [selected, ...doneCases];
        } else {
          activeCases = [selected, ...activeCases];
        }
      }
    }
  } catch {
    unavailable = true;
  }

  try {
    const durableTasks = await listDurableTasksForUser(db, user.id, {
      statuses: ["active", "paused", "completed", "failed"],
      limit: 100,
    });
    if (
      selectedDurableTaskId &&
      !durableTasks.some((task) => task.id === selectedDurableTaskId)
    ) {
      const selectedTask = await getDurableTask(
        db,
        user.id,
        selectedDurableTaskId
      );
      if (selectedTask) durableTasks.unshift(selectedTask);
    }
    const taskRuns = new Map<string, WorkRun[]>();
    for (const task of durableTasks) {
      taskRuns.set(
        task.id,
        await listWorkRunsForTask(db, user.id, task.id, { limit: 20 })
      );
    }
    const selectedRuns = [...taskRuns.values()].flatMap((runs) => {
      const selected = selectedWorkRunId
        ? runs.find((run) => run.id === selectedWorkRunId)
        : null;
      const run = selected ?? runs[0];
      return run ? [run] : [];
    });
    const summaries = await summarizeWorkRuns(
      db,
      user.id,
      selectedRuns.map((run) => run.id)
    );
    durableTaskViews = durableTasks.map((task) => {
      const runs = taskRuns.get(task.id) ?? [];
      const run =
        (selectedWorkRunId
          ? runs.find((candidate) => candidate.id === selectedWorkRunId)
          : null) ??
        runs[0] ??
        null;
      const summary = run ? summaries.get(run.id) : undefined;
      return {
        task,
        run,
        summary,
        column: classifyDurableTaskView(task, run, summary),
      };
    });
  } catch {
    // Despliegue aún sin 00074/00075: los casos siguen disponibles.
  }

  const allCases = [...activeCases, ...doneCases];

  // Labels de paso desde operational_flow (tenant → global). Fallo de
  // resolución no tumba la página: las tarjetas humanizan el slug.
  const stepLabelsByCaseId = new Map<string, OperationalStepLabelMap>();
  if (!unavailable && allCases.length > 0) {
    const resolver = new OperationalStepLabelResolver(db);
    const byTypeId = new Map<string, OperationalStepLabelMap>();
    for (const opCase of allCases) {
      const typeKey = opCase.case_type_id?.trim() || opCase.case_type;
      try {
        let map = byTypeId.get(typeKey);
        if (!map) {
          map = await resolver.labelsForCase(opCase);
          byTypeId.set(typeKey, map);
        }
        stepLabelsByCaseId.set(opCase.id, map);
      } catch {
        stepLabelsByCaseId.set(opCase.id, {});
      }
    }
  }

  const byColumn = new Map<DurableWorkColumnId, OperationalCase[]>();
  for (const id of [
    ...DURABLE_WORK_FLOW_COLUMNS.map((c) => c.id),
    DURABLE_WORK_BLOCKED_COLUMN.id,
    DURABLE_WORK_PAUSED_COLUMN.id,
  ]) {
    byColumn.set(id, []);
  }
  for (const opCase of allCases) {
    const column = classifyDurableWorkColumn({
      status: opCase.status,
      work: workByCase.get(opCase.id),
    });
    byColumn.get(column)?.push(opCase);
  }

  const blockedCases = byColumn.get("blocked") ?? [];
  const pausedCases = byColumn.get("paused") ?? [];
  const selectedCase =
    selectedCaseId != null
      ? allCases.find((c) => c.id === selectedCaseId) ?? null
      : null;
  const selectedDurableTask =
    selectedDurableTaskId != null
      ? durableTaskViews.find(
          (view) => view.task.id === selectedDurableTaskId
        ) ?? null
      : null;

  const cardHref = (caseId: string) =>
    overviewHref({
      vista,
      caseId,
      showPaused,
    });
  const durableCardHref = (view: DurableTaskView) =>
    overviewHref({
      vista,
      durableTaskId: view.task.id,
      workRunId: view.run?.id,
      showPaused,
    });
  const durableBlocked = durableTaskViews.filter(
    (view) => view.column === "blocked"
  );
  const durablePaused = durableTaskViews.filter(
    (view) => view.column === "paused"
  );

  return (
    <AppShell
      title="Control operativo"
      description="Casos y tareas durables. Selecciona un caso para ver fechas y abrir sus unidades de trabajo."
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <OperationsControlTabs active="overview" />
        <div className="mb-4 flex flex-wrap gap-2">
          <div className="flex rounded-lg border border-neutral-200 bg-neutral-50 p-0.5 dark:border-neutral-800 dark:bg-neutral-950">
            <Link
              href={overviewHref({
                vista: "tablero",
                caseId: selectedCaseId,
                durableTaskId: selectedDurableTaskId,
                workRunId: selectedWorkRunId,
                showPaused,
              })}
              aria-current={vista === "tablero" ? "page" : undefined}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${
                vista === "tablero"
                  ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                  : "text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
              }`}
            >
              Tablero
            </Link>
            <Link
              href={overviewHref({
                vista: "lista",
                caseId: selectedCaseId,
                durableTaskId: selectedDurableTaskId,
                workRunId: selectedWorkRunId,
                showPaused,
              })}
              aria-current={vista === "lista" ? "page" : undefined}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${
                vista === "lista"
                  ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                  : "text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
              }`}
            >
              Lista
            </Link>
          </div>
        </div>
      </div>

      {unavailable ? (
        <div className="rounded-2xl border border-dashed border-neutral-300 bg-white p-8 text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900">
          No se pudo cargar el trabajo durable (tablas de casos/trabajo no
          disponibles).
        </div>
      ) : (
        <>
          {selectedDurableTask ? (
            <DurableTaskDetailPanel
              view={selectedDurableTask}
              clearHref={overviewHref({ vista, showPaused })}
            />
          ) : selectedCase ? (
            <CaseDetailPanel
              opCase={selectedCase}
              summary={workByCase.get(selectedCase.id)}
              clearHref={overviewHref({ vista, showPaused })}
              workHref={`/operations/work?case=${selectedCase.id}`}
              stepLabels={stepLabelsByCaseId.get(selectedCase.id)}
            />
          ) : (
            <p className="mb-3 text-xs text-neutral-500">
              Nivel caso (trabajo durable). Pausado queda colapsado para no
              tapar el camino; Bloqueado sí se abre (urgente). Clic en una
              tarjeta → fechas en línea de tiempo y unidades de trabajo.
            </p>
          )}

          {allCases.length === 0 && durableTaskViews.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-neutral-300 bg-white p-8 text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900">
              No hay casos ni tareas durables. Cuando inicies un flujo o una
              tarea batch, aparecerá aquí. Las unidades de
              trabajo internas se listan en la pestaña{" "}
              <Link href="/operations/work" className="underline">
                Unidades de trabajo
              </Link>
              .
            </div>
          ) : vista === "lista" ? (
            <ul className="space-y-2">
              {allCases.map((opCase) => (
                <li key={opCase.id}>
                  <CaseCard
                    opCase={opCase}
                    summary={workByCase.get(opCase.id)}
                    selected={opCase.id === selectedCaseId}
                    href={cardHref(opCase.id)}
                    stepLabels={stepLabelsByCaseId.get(opCase.id)}
                  />
                </li>
              ))}
              {durableTaskViews.map((view) => (
                <li key={`durable:${view.task.id}`}>
                  <DurableTaskCard
                    view={view}
                    selected={view.task.id === selectedDurableTaskId}
                    href={durableCardHref(view)}
                  />
                </li>
              ))}
            </ul>
          ) : (
            <div className="space-y-4">
              {blockedCases.length > 0 ? (
                <ExceptionTray
                  column={DURABLE_WORK_BLOCKED_COLUMN}
                  cases={blockedCases}
                  workByCase={workByCase}
                  selectedCaseId={selectedCaseId}
                  cardHref={cardHref}
                  hint="Excepción urgente · no es etapa del flujo"
                  stepLabelsByCaseId={stepLabelsByCaseId}
                />
              ) : null}
              {pausedCases.length > 0 ? (
                <ExceptionTray
                  column={DURABLE_WORK_PAUSED_COLUMN}
                  cases={pausedCases}
                  workByCase={workByCase}
                  selectedCaseId={selectedCaseId}
                  cardHref={cardHref}
                  hint="Parada deliberada · no tapa el camino"
                  collapsed={!showPaused}
                  expandHref={overviewHref({
                    vista,
                    caseId: selectedCaseId,
                    showPaused: true,
                  })}
                  collapseHref={overviewHref({
                    vista,
                    caseId: selectedCaseId,
                    showPaused: false,
                  })}
                  previewLimit={PAUSED_EXPANDED_PREVIEW}
                  listHref={overviewHref({
                    vista: "lista",
                    caseId: selectedCaseId,
                    showPaused: true,
                  })}
                  stepLabelsByCaseId={stepLabelsByCaseId}
                />
              ) : null}
              {durableBlocked.length > 0 ? (
                <Column
                  column={DURABLE_WORK_BLOCKED_COLUMN}
                  count={durableBlocked.length}
                >
                  {durableBlocked.map((view) => (
                    <DurableTaskCard
                      key={view.task.id}
                      view={view}
                      selected={view.task.id === selectedDurableTaskId}
                      href={durableCardHref(view)}
                    />
                  ))}
                </Column>
              ) : null}
              {showPaused && durablePaused.length > 0 ? (
                <Column
                  column={DURABLE_WORK_PAUSED_COLUMN}
                  count={durablePaused.length}
                >
                  {durablePaused.map((view) => (
                    <DurableTaskCard
                      key={view.task.id}
                      view={view}
                      selected={view.task.id === selectedDurableTaskId}
                      href={durableCardHref(view)}
                    />
                  ))}
                </Column>
              ) : null}

              <div
                className="grid gap-3 md:grid-cols-2 xl:grid-cols-4"
                aria-label="Camino operativo: atención, en marcha, esperando terceros, finalizado"
              >
                {DURABLE_WORK_FLOW_COLUMNS.map((column) => {
                  const items = byColumn.get(column.id) ?? [];
                  const durableItems = durableTaskViews.filter(
                    (view) => view.column === column.id
                  );
                  return (
                    <Column
                      key={column.id}
                      column={column}
                      count={items.length + durableItems.length}
                    >
                      {items.length === 0 && durableItems.length === 0 ? (
                        <p className="px-1 py-4 text-center text-xs text-neutral-400">
                          Sin trabajo
                        </p>
                      ) : (
                        <>
                          {items.map((opCase) => (
                            <CaseCard
                              key={opCase.id}
                              opCase={opCase}
                              summary={workByCase.get(opCase.id)}
                              selected={opCase.id === selectedCaseId}
                              href={cardHref(opCase.id)}
                              stepLabels={stepLabelsByCaseId.get(opCase.id)}
                            />
                          ))}
                          {durableItems.map((view) => (
                            <DurableTaskCard
                              key={`durable:${view.task.id}`}
                              view={view}
                              selected={view.task.id === selectedDurableTaskId}
                              href={durableCardHref(view)}
                            />
                          ))}
                        </>
                      )}
                    </Column>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </AppShell>
  );
}
