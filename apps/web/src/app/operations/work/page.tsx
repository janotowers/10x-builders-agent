/**
 * Vista de trabajo del operador (flexible-workflows plan, Slice 2.5).
 *
 * Gate de rol interino: `profiles.is_ungga_admin` [D — Technical Plan §16 deja
 * abierto el sistema de roles; no inventamos uno en este slice]. La entrada de
 * navegación también está oculta para no-admins (app-navigation adminOnly).
 *
 * Layout: camino feliz en una fila (Todo → Ready → Running → Review → Done);
 * Bloqueado es bandeja de excepción arriba (reencola a Ready, no es etapa).
 * Sin drag-and-drop en v1 — las únicas transiciones manuales son botones de
 * acción explicada donde son legales (review→done y blocked→ready).
 * Vocabulario de liveness §10; la palabra "heartbeat" jamás se renderiza aquí
 * (verificado por UI selftest).
 */
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import {
  approveReviewedItem,
  createServerClient,
  listWorkItemEvents,
  listWorkItemsForUser,
  retryBlockedItem,
} from "@agents/db";
import type {
  WorkItem,
  WorkItemAttempt,
  WorkItemEvent,
  WorkItemStatus,
} from "@agents/types";
import { createClient } from "@/lib/supabase/server";
import { AppShell } from "@/components/app-shell";
import { OperationsControlTabs } from "@/app/operations/operations-control-tabs";
import {
  blockedReasonLabel,
  executorKindLabel,
  livenessCue,
  retryStateLabel,
  verificationStateLabel,
  WORK_VIEW_BLOCKED_COLUMN,
  WORK_VIEW_FLOW_COLUMNS,
  sortWorkItemsForBoardView,
  workReviewActionPresentation,
  workTypeLabel,
  type WorkViewColumn,
} from "@/lib/operations/work-view-labels";

// Acentos semánticos por columna: rojo/ámbar = piden acción del operador,
// violeta = ejecución viva, verde = terminado (se apaga visualmente).
const COLUMN_ACCENTS: Record<
  WorkItemStatus,
  { dot: string; count: string; border: string }
> = {
  todo: {
    dot: "bg-neutral-400",
    count: "bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
    border: "border-t-neutral-300 dark:border-t-neutral-700",
  },
  ready: {
    dot: "bg-sky-500",
    count: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200",
    border: "border-t-sky-400 dark:border-t-sky-600",
  },
  running: {
    dot: "bg-violet-500",
    count: "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200",
    border: "border-t-violet-400 dark:border-t-violet-600",
  },
  blocked: {
    dot: "bg-red-500",
    count: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200",
    border: "border-t-red-400 dark:border-t-red-600",
  },
  review: {
    dot: "bg-amber-500",
    count: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
    border: "border-t-amber-400 dark:border-t-amber-600",
  },
  done: {
    dot: "bg-emerald-500",
    count: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
    border: "border-t-emerald-400 dark:border-t-emerald-600",
  },
  cancelled: {
    dot: "bg-neutral-400",
    count: "bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
    border: "border-t-neutral-300 dark:border-t-neutral-700",
  },
};

function executorBadgeClasses(kind: string | null | undefined): string {
  switch (kind) {
    case "human":
      return "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200";
    case "main_agent":
      return "border-violet-200 bg-violet-50 text-violet-800 dark:border-violet-800 dark:bg-violet-950 dark:text-violet-200";
    case "deterministic_service":
      return "border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-200";
    default:
      return "border-neutral-200 bg-neutral-50 text-neutral-600 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300";
  }
}

export const dynamic = "force-dynamic";

async function requireOperator(): Promise<
  { user: { id: string } } | { denied: true; flagValue: string }
> {
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
    return { denied: true, flagValue: String(profile?.is_ungga_admin ?? "null") };
  }
  return { user };
}

async function approveReviewedItemAction(formData: FormData) {
  "use server";
  const gate = await requireOperator();
  if ("denied" in gate) redirect("/operations/work");
  const itemId = String(formData.get("work_item_id") ?? "").trim();
  if (itemId) {
    const db = createServerClient();
    await approveReviewedItem(db, { userId: gate.user.id, itemId });
  }
  revalidatePath("/operations/work");
}

async function retryBlockedItemAction(formData: FormData) {
  "use server";
  const gate = await requireOperator();
  if ("denied" in gate) redirect("/operations/work");
  const itemId = String(formData.get("work_item_id") ?? "").trim();
  if (itemId) {
    const db = createServerClient();
    await retryBlockedItem(db, { userId: gate.user.id, itemId });
  }
  revalidatePath("/operations/work");
}

type CaseLabelRow = {
  id: string;
  case_type: string;
  status: string;
  context_jsonb: Record<string, unknown> | null;
};

/** Casos que ya no están vigentes: su trabajo es historia, no operación. */
const HISTORICAL_CASE_STATUSES = new Set(["completed", "cancelled", "archived"]);

function caseLabel(row: CaseLabelRow | undefined, caseId: string): string {
  if (!row) return `${caseId.slice(0, 8)}…`;
  const ctx = row.context_jsonb ?? {};
  const candidate =
    (typeof ctx.property_title === "string" && ctx.property_title.trim()) ||
    (typeof ctx.title === "string" && ctx.title.trim()) ||
    (typeof ctx.nickname === "string" && ctx.nickname.trim());
  return candidate || `${row.case_type} · ${row.id.slice(0, 8)}…`;
}

function ColumnHeader({
  column,
  count,
  useShortLabel = false,
}: {
  column: WorkViewColumn;
  count: number;
  useShortLabel?: boolean;
}) {
  const accents = COLUMN_ACCENTS[column.status];
  const label =
    useShortLabel && column.shortLabel ? column.shortLabel : column.label;
  return (
    <h2 className="flex items-center justify-between gap-1 px-1 text-sm font-semibold">
      <span className="flex min-w-0 items-center gap-1.5" title={column.label}>
        <span className={`h-2 w-2 shrink-0 rounded-full ${accents.dot}`} />
        <span className="truncate">{label}</span>
      </span>
      <span
        className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${accents.count}`}
      >
        {count}
      </span>
    </h2>
  );
}

function workHref(opts: {
  caseId?: string | null;
  historial?: boolean;
  itemId?: string | null;
}): string {
  const params = new URLSearchParams();
  if (opts.caseId) params.set("case", opts.caseId);
  if (opts.historial) params.set("historial", "1");
  if (opts.itemId) params.set("item", opts.itemId);
  const qs = params.toString();
  return qs ? `/operations/work?${qs}` : "/operations/work";
}

function formatWorkDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("es-MX", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}

/** Fecha/hora corta en la tarjeta (paridad con Trabajo durable). */
function formatWorkCardDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("es-MX", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function jsonPreview(value: unknown, max = 600): string {
  try {
    const text = JSON.stringify(value, null, 2);
    if (text.length <= max) return text;
    return `${text.slice(0, max)}…`;
  } catch {
    return String(value);
  }
}

function WorkItemDetailPanel({
  item,
  attempts,
  events,
  caseLabelText,
  clearHref,
  caseOverviewHref,
}: {
  item: WorkItem;
  attempts: WorkItemAttempt[];
  events: WorkItemEvent[];
  caseLabelText: string;
  clearHref: string;
  caseOverviewHref: string;
}) {
  const sortedAttempts = [...attempts].sort(
    (a, b) => b.attempt_number - a.attempt_number
  );
  return (
    <div className="mb-4 rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-950 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-100">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-semibold">{workTypeLabel(item.work_type)}</p>
          <p className="mt-0.5 text-xs opacity-80">
            <code className="text-[11px]">{item.work_type}</code>
            {" · "}
            <code className="text-[11px]">{item.id}</code>
          </p>
          <p className="mt-1 text-xs">
            Estado <span className="font-semibold">{item.status}</span>
            {" · "}
            {retryStateLabel(item)}
            {" · capacidad "}
            <code className="text-[11px]">{item.required_capability}</code>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href={caseOverviewHref}
            className="rounded-md border border-sky-400 bg-white px-3 py-1.5 text-xs font-semibold text-sky-900 hover:bg-sky-100 dark:border-sky-700 dark:bg-sky-900 dark:text-sky-100"
          >
            Ver caso →
          </Link>
          <Link
            href={clearHref}
            className="rounded-md border border-sky-300 px-3 py-1.5 text-xs font-semibold hover:bg-sky-100 dark:border-sky-800 dark:hover:bg-sky-900"
          >
            Cerrar detalle
          </Link>
        </div>
      </div>

      <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-3">
        <div>
          <dt className="text-[10px] font-semibold uppercase tracking-wide opacity-70">
            Caso
          </dt>
          <dd className="font-medium">{caseLabelText}</dd>
        </div>
        <div>
          <dt className="text-[10px] font-semibold uppercase tracking-wide opacity-70">
            Origen
          </dt>
          <dd className="font-medium">{item.origin}</dd>
        </div>
        <div>
          <dt className="text-[10px] font-semibold uppercase tracking-wide opacity-70">
            Verificación
          </dt>
          <dd className="font-medium">{verificationStateLabel(item)}</dd>
        </div>
        <div>
          <dt className="text-[10px] font-semibold uppercase tracking-wide opacity-70">
            Creado
          </dt>
          <dd className="font-medium">{formatWorkDateTime(item.created_at)}</dd>
        </div>
        <div>
          <dt className="text-[10px] font-semibold uppercase tracking-wide opacity-70">
            Actualizado
          </dt>
          <dd className="font-medium">{formatWorkDateTime(item.updated_at)}</dd>
        </div>
        {item.due_at ? (
          <div>
            <dt className="text-[10px] font-semibold uppercase tracking-wide opacity-70">
              Fecha límite del item
            </dt>
            <dd className="font-medium">{formatWorkDateTime(item.due_at)}</dd>
          </div>
        ) : null}
        {item.status === "blocked" ? (
          <div className="sm:col-span-2">
            <dt className="text-[10px] font-semibold uppercase tracking-wide opacity-70">
              Motivo de bloqueo
            </dt>
            <dd className="font-medium text-red-700 dark:text-red-300">
              {blockedReasonLabel(item.blocked_reason)}
            </dd>
          </div>
        ) : null}
      </dl>

      {item.result_jsonb ? (
        <div className="mt-3">
          <p className="text-[10px] font-semibold uppercase tracking-wide opacity-70">
            Resultado
          </p>
          <pre className="mt-1 max-h-40 overflow-auto rounded-lg border border-sky-200/80 bg-white/70 p-2 text-[10px] text-neutral-800 dark:border-sky-800 dark:bg-sky-900/50 dark:text-sky-100">
            {jsonPreview(item.result_jsonb)}
          </pre>
        </div>
      ) : null}

      <div className="mt-4">
        <p className="text-[10px] font-semibold uppercase tracking-wide opacity-70">
          Intentos ({sortedAttempts.length})
        </p>
        {sortedAttempts.length === 0 ? (
          <p className="mt-1 text-xs opacity-80">Sin attempts todavía.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {sortedAttempts.map((attempt) => (
              <li
                key={attempt.id}
                className="rounded-lg border border-sky-200/80 bg-white/70 p-2.5 text-xs dark:border-sky-800 dark:bg-sky-900/40"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">
                    Intento {attempt.attempt_number}
                  </span>
                  <span
                    className={`rounded-md border px-1.5 py-0.5 text-[10px] font-semibold ${executorBadgeClasses(attempt.executor_kind)}`}
                  >
                    {executorKindLabel(attempt.executor_kind)}
                  </span>
                  <span className="text-neutral-500">{attempt.status}</span>
                  {item.current_attempt_id === attempt.id ? (
                    <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-semibold text-sky-800 dark:bg-sky-950 dark:text-sky-200">
                      vigente
                    </span>
                  ) : null}
                </div>
                <p className="mt-1 text-[11px] text-neutral-500">
                  Claim {formatWorkDateTime(attempt.claimed_at)}
                  {attempt.completed_at
                    ? ` · fin ${formatWorkDateTime(attempt.completed_at)}`
                    : ""}
                  {attempt.last_liveness_at
                    ? ` · vitalidad ${formatWorkDateTime(attempt.last_liveness_at)}`
                    : ""}
                </p>
                {attempt.error_jsonb ? (
                  <pre className="mt-1 max-h-28 overflow-auto rounded border border-red-200 bg-red-50/80 p-1.5 text-[10px] text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-100">
                    {jsonPreview(attempt.error_jsonb, 400)}
                  </pre>
                ) : null}
                {attempt.evidence_jsonb ? (
                  <pre className="mt-1 max-h-28 overflow-auto rounded border border-neutral-200 bg-neutral-50 p-1.5 text-[10px] text-neutral-800 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200">
                    {jsonPreview(attempt.evidence_jsonb, 400)}
                  </pre>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-4">
        <p className="text-[10px] font-semibold uppercase tracking-wide opacity-70">
          Timeline ({events.length})
        </p>
        {events.length === 0 ? (
          <p className="mt-1 text-xs opacity-80">Sin eventos registrados.</p>
        ) : (
          <ol className="mt-2 max-h-48 space-y-1.5 overflow-auto text-xs">
            {events.map((event) => (
              <li
                key={event.id}
                className="rounded border border-sky-200/60 bg-white/50 px-2 py-1.5 dark:border-sky-800 dark:bg-sky-900/30"
              >
                <span className="font-semibold">{event.event_type}</span>
                <span className="opacity-70"> · {event.actor}</span>
                <span className="opacity-70">
                  {" · "}
                  {formatWorkDateTime(event.created_at)}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

function WorkItemCard({
  item,
  attempt,
  caseLabelText,
  depCount,
  compact = false,
  selected = false,
  detailHref,
}: {
  item: WorkItem;
  attempt: WorkItemAttempt | null;
  caseLabelText: string;
  depCount: number;
  compact?: boolean;
  selected?: boolean;
  detailHref: string;
}) {
  const cue = item.status === "running" ? livenessCue(attempt) : "";
  const reviewAction =
    item.status === "review"
      ? workReviewActionPresentation(item.work_type)
      : null;
  return (
    <article
      className={`rounded-xl border bg-white text-xs shadow-sm dark:bg-neutral-900 ${
        compact ? "p-2.5" : "p-3"
      } ${
        selected
          ? "border-sky-400 ring-2 ring-sky-200 dark:border-sky-500 dark:ring-sky-900"
          : "border-neutral-200 dark:border-neutral-800"
      }`}
    >
      {/* El enlace cubre el cuerpo; Aprobar/Reintentar quedan FUERA para no
          capturar el clic (forms anidados en <a> son ilegales en HTML). */}
      <Link href={detailHref} className="block outline-none">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="font-semibold leading-snug text-neutral-900 dark:text-neutral-100">
              {workTypeLabel(item.work_type)}
            </p>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px] text-neutral-400">
              <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                {retryStateLabel(item)}
              </span>
              <code className="truncate">{item.work_type}</code>
            </p>
          </div>
        </div>
        <p className="mt-1.5 truncate text-neutral-500" title={caseLabelText}>
          Caso: {caseLabelText}
        </p>
        <p className="mt-1.5 flex flex-wrap items-center gap-1 text-neutral-500">
          <span
            className={`rounded-md border px-1.5 py-0.5 text-[10px] font-semibold ${executorBadgeClasses(attempt?.executor_kind)}`}
          >
            {executorKindLabel(attempt?.executor_kind)}
          </span>
          {depCount > 0 ? (
            <span>
              {depCount} dep{depCount === 1 ? "" : "s"}
            </span>
          ) : null}
          {item.due_at ? (
            <span>
              Fecha límite: {new Date(item.due_at).toLocaleString("es-MX")}
            </span>
          ) : null}
        </p>
        <p
          className="mt-1 truncate text-neutral-500"
          title={verificationStateLabel(item)}
        >
          Verificación: {verificationStateLabel(item)}
        </p>
        {cue ? (
          <p className="mt-1 font-medium text-violet-700 dark:text-violet-300">
            {cue}
          </p>
        ) : null}
        {item.status === "blocked" ? (
          <p className="mt-1 text-red-600 dark:text-red-400">
            Motivo: {blockedReasonLabel(item.blocked_reason)}
          </p>
        ) : null}
        <p className="mt-2 text-[10px] text-neutral-400">
          Actualizado {formatWorkCardDateTime(item.updated_at)}
        </p>
        <p className="mt-1.5 text-[10px] font-medium text-sky-700 dark:text-sky-300">
          Ver detalle →
        </p>
      </Link>
      {reviewAction?.kind === "domain_decision" ? (
        <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] font-medium text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          {reviewAction.guidance}
        </p>
      ) : null}
      {reviewAction?.kind === "manual_close" ? (
        <form action={approveReviewedItemAction} className="mt-2">
          <input type="hidden" name="work_item_id" value={item.id} />
          <button
            type="submit"
            className="rounded-md border border-emerald-300 bg-emerald-50 px-2 py-1 text-[11px] font-semibold text-emerald-800 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
            title={reviewAction.title}
          >
            {reviewAction.label}
          </button>
        </form>
      ) : null}
      {item.status === "blocked" ? (
        <form action={retryBlockedItemAction} className="mt-2">
          <input type="hidden" name="work_item_id" value={item.id} />
          <button
            type="submit"
            className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] font-semibold text-amber-800 hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
            title="Reencola el item bloqueado para un nuevo intento (blocked → ready); amplía max_attempts en 1 si el bloqueo fue por límite de intentos."
          >
            Reintentar
          </button>
        </form>
      ) : null}
    </article>
  );
}

function FlowColumn({
  column,
  items,
  renderCard,
}: {
  column: WorkViewColumn;
  items: WorkItem[];
  renderCard: (item: WorkItem) => ReactNode;
}) {
  return (
    <section
      className={`min-w-0 rounded-2xl border border-t-4 border-neutral-200 bg-neutral-50 p-2.5 dark:border-neutral-800 dark:bg-neutral-950 ${COLUMN_ACCENTS[column.status].border}`}
    >
      <ColumnHeader column={column} count={items.length} useShortLabel />
      <div className="mt-2 space-y-2">
        {items.length === 0 ? (
          <p className="px-1 py-4 text-center text-xs text-neutral-400">
            Sin items
          </p>
        ) : (
          items.map((item) => renderCard(item))
        )}
      </div>
    </section>
  );
}

export default async function OperatorWorkViewPage({
  searchParams,
}: {
  searchParams: Promise<{ historial?: string; case?: string; item?: string }>;
}) {
  const sp = await searchParams;
  const showHistory = sp.historial === "1";
  const filterCaseId =
    typeof sp.case === "string" && sp.case.trim() ? sp.case.trim() : null;
  const selectedItemId =
    typeof sp.item === "string" && sp.item.trim() ? sp.item.trim() : null;
  const gate = await requireOperator();
  if ("denied" in gate) {
    return (
      <AppShell
        title="Control operativo"
        description="Vista del operador: estado de ejecución de los work items."
      >
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
          <p className="font-semibold">Sin acceso de operador</p>
          <p className="mt-2">
            Esta vista requiere <code>profiles.is_ungga_admin = true</code> como
            rol de operador interino. Ahora mismo el flag está en{" "}
            <code>{gate.flagValue}</code>.
          </p>
        </div>
      </AppShell>
    );
  }

  const db = createServerClient();

  // Tolerante a entornos donde la migración 00069 aún no se aplica.
  let items: WorkItem[] = [];
  let attempts: WorkItemAttempt[] = [];
  const dependencyCounts = new Map<string, number>();
  const caseLabels = new Map<string, CaseLabelRow>();
  let unavailable = false;
  try {
    items = await listWorkItemsForUser(db, gate.user.id, { limit: 500 });
    const itemIds = items.map((i) => i.id);
    if (itemIds.length > 0) {
      const [attemptsRes, depsRes] = await Promise.all([
        db
          .from("work_item_attempts")
          .select("*")
          .eq("user_id", gate.user.id)
          .in("work_item_id", itemIds),
        db
          .from("work_item_dependencies")
          .select("work_item_id")
          .eq("user_id", gate.user.id)
          .in("work_item_id", itemIds),
      ]);
      if (attemptsRes.error) throw attemptsRes.error;
      if (depsRes.error) throw depsRes.error;
      attempts = (attemptsRes.data ?? []) as WorkItemAttempt[];
      for (const dep of (depsRes.data ?? []) as Array<{ work_item_id: string }>) {
        dependencyCounts.set(
          dep.work_item_id,
          (dependencyCounts.get(dep.work_item_id) ?? 0) + 1
        );
      }
      const caseIds = [
        ...new Set([
          ...items.map((i) => i.case_id),
          ...(filterCaseId ? [filterCaseId] : []),
        ]),
      ];
      if (caseIds.length > 0) {
        const { data: caseRows, error: caseError } = await db
          .from("operational_cases")
          .select("id, case_type, status, context_jsonb")
          .in("id", caseIds);
        if (caseError) throw caseError;
        for (const row of (caseRows ?? []) as CaseLabelRow[]) {
          caseLabels.set(row.id, row);
        }
      }
    } else if (filterCaseId) {
      const { data: caseRow, error: caseError } = await db
        .from("operational_cases")
        .select("id, case_type, status, context_jsonb")
        .eq("id", filterCaseId)
        .maybeSingle();
      if (caseError) throw caseError;
      if (caseRow) caseLabels.set(caseRow.id, caseRow as CaseLabelRow);
    }
  } catch {
    unavailable = true;
  }

  // Filtro de historial: por defecto solo trabajo de casos vigentes; el
  // toggle ?historial=1 muestra también lo de casos completados/cancelados.
  const isHistorical = (item: WorkItem): boolean => {
    const status = caseLabels.get(item.case_id)?.status;
    return status != null && HISTORICAL_CASE_STATUSES.has(status);
  };
  const historicalCount = items.filter(isHistorical).length;
  const scopedItems = filterCaseId
    ? items.filter((i) => i.case_id === filterCaseId)
    : items;
  const visibleItems = sortWorkItemsForBoardView(
    showHistory ? scopedItems : scopedItems.filter((i) => !isHistorical(i))
  );
  const filterCaseLabel = filterCaseId
    ? caseLabel(caseLabels.get(filterCaseId), filterCaseId)
    : null;

  // Attempt vigente por item: preferir current_attempt_id; fallback al
  // attempt de mayor attempt_number.
  const attemptsByItem = new Map<string, WorkItemAttempt[]>();
  for (const attempt of attempts) {
    const list = attemptsByItem.get(attempt.work_item_id) ?? [];
    list.push(attempt);
    attemptsByItem.set(attempt.work_item_id, list);
  }
  const currentAttemptFor = (item: WorkItem): WorkItemAttempt | null => {
    const list = attemptsByItem.get(item.id) ?? [];
    if (item.current_attempt_id) {
      const exact = list.find((a) => a.id === item.current_attempt_id);
      if (exact) return exact;
    }
    return (
      [...list].sort((a, b) => b.attempt_number - a.attempt_number)[0] ?? null
    );
  };

  const flowColumns = WORK_VIEW_FLOW_COLUMNS.map((column) => ({
    ...column,
    items: visibleItems.filter((item) => item.status === column.status),
  }));
  const blockedItems = visibleItems.filter(
    (item) => item.status === WORK_VIEW_BLOCKED_COLUMN.status
  );

  const selectedItem =
    selectedItemId != null
      ? items.find((i) => i.id === selectedItemId) ??
        visibleItems.find((i) => i.id === selectedItemId) ??
        null
      : null;
  let selectedEvents: WorkItemEvent[] = [];
  if (selectedItem) {
    try {
      selectedEvents = await listWorkItemEvents(
        db,
        gate.user.id,
        selectedItem.id,
        40
      );
    } catch {
      selectedEvents = [];
    }
  }

  const renderCard = (item: WorkItem, compact = false) => (
    <WorkItemCard
      key={item.id}
      item={item}
      attempt={currentAttemptFor(item)}
      caseLabelText={caseLabel(caseLabels.get(item.case_id), item.case_id)}
      depCount={dependencyCounts.get(item.id) ?? 0}
      compact={compact}
      selected={item.id === selectedItemId}
      detailHref={workHref({
        caseId: filterCaseId,
        historial: showHistory,
        itemId: item.id,
      })}
    />
  );

  return (
    <AppShell
      title="Control operativo"
      description="Trabajo interno: work items por estado. Clic en una tarjeta → intentos, evidencia y timeline (Aprobar/Reintentar siguen en la tarjeta)."
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <OperationsControlTabs active="work" />
        <div className="mb-4 flex flex-wrap gap-2">
          {filterCaseId ? (
            <Link
              href="/operations/overview"
              className="rounded-md border border-sky-300 bg-sky-50 px-3 py-1.5 text-xs font-semibold text-sky-900 hover:bg-sky-100 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-100"
            >
              Quitar filtro de caso
            </Link>
          ) : null}
          {historicalCount > 0 ? (
            <Link
              href={workHref({
                caseId: filterCaseId,
                historial: !showHistory,
                itemId: selectedItemId,
              })}
              className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-xs font-semibold text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              {showHistory
                ? "Ocultar historial"
                : `Mostrar historial (${historicalCount} de casos terminados)`}
            </Link>
          ) : null}
        </div>
      </div>
      {filterCaseId ? (
        <div className="mb-4 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-950 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-100">
          Filtrado por caso:{" "}
          <span className="font-semibold">{filterCaseLabel}</span>
          .{" "}
          <Link href="/operations/overview" className="underline">
            Volver a trabajo durable
          </Link>
        </div>
      ) : null}
      {selectedItem ? (
        <WorkItemDetailPanel
          item={selectedItem}
          attempts={attemptsByItem.get(selectedItem.id) ?? []}
          events={selectedEvents}
          caseLabelText={caseLabel(
            caseLabels.get(selectedItem.case_id),
            selectedItem.case_id
          )}
          clearHref={workHref({
            caseId: filterCaseId,
            historial: showHistory,
          })}
          caseOverviewHref={`/operations/overview?case=${selectedItem.case_id}`}
        />
      ) : null}
      {unavailable ? (
        <div className="rounded-2xl border border-dashed border-neutral-300 bg-white p-8 text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900">
          El plano de trabajo no está disponible en este entorno (la migración
          00069 aún no se aplica o las tablas no responden).
        </div>
      ) : (
        <div className="space-y-4">
          {/* El tablero (columnas + bandeja) se muestra siempre: sin items, las
              columnas vacías siguen anclando la progresión del flujo. */}
          {visibleItems.length === 0 ? (
            <div className="rounded-xl border border-dashed border-neutral-300 bg-white px-4 py-3 text-sm text-neutral-600 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300">
              {historicalCount > 0 ? (
                <>No hay trabajo en casos vigentes.</>
              ) : (
                <>
                  No hay work items todavía. Los casos con definición pinneada y
                  flag <code>work_plane_v2</code> los generarán en el próximo
                  tick del cron.
                </>
              )}
            </div>
          ) : null}

          {/* Excepción: solo visible con items. Vacía no aporta progresión y
              el acento rojo distrae; Reintentar reencola a Listo. */}
          {blockedItems.length > 0 ? (
            <section
              className={`rounded-2xl border border-t-4 border-neutral-200 bg-red-50/60 p-3 dark:border-neutral-800 dark:bg-red-950/20 ${COLUMN_ACCENTS.blocked.border}`}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2 px-1">
                <ColumnHeader
                  column={WORK_VIEW_BLOCKED_COLUMN}
                  count={blockedItems.length}
                />
                <p className="text-[11px] text-red-800/80 dark:text-red-200/80">
                  Excepción · Reintentar vuelve a Listo (no es etapa del flujo)
                </p>
              </div>
              <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {blockedItems.map((item) => renderCard(item, true))}
              </div>
            </section>
          ) : null}

          {/* Camino feliz: una fila en pantallas anchas para percibir progresión. */}
          <div
            className="grid gap-3 md:grid-cols-2 xl:grid-cols-5"
            aria-label="Camino feliz del trabajo: por hacer, listo, en ejecución, en revisión, terminado"
          >
            {flowColumns.map((column) => (
              <FlowColumn
                key={column.status}
                column={column}
                items={column.items}
                renderCard={(item) => renderCard(item, true)}
              />
            ))}
          </div>
        </div>
      )}
    </AppShell>
  );
}
