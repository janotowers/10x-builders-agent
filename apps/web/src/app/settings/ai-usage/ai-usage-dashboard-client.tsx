"use client";

import { Fragment, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { AiUsageEvent } from "@agents/types";
import {
  aggregateCostComparisonMicroUsd,
  buildAiUsageTenantSections,
  effectiveCostMicroUsd,
  effectiveCostSplitMicroUsd,
  estimatedCostCoverage,
  estimatedCostEventCount,
  eventsMissingCatalogEstimate,
  filterAiUsageEvents,
  formatAiUsageOccurredAt,
  formatUsdFromMicro,
  mostExpensiveAiUsageEvents,
  paginateItems,
  reportedCostCoverage,
  reportedCostEventCount,
  reportedCostMoneyCoverage,
  rollupAiUsage,
  sortCases,
  sortExecutions,
  sortRollupBuckets,
  totalEffectiveCostMicroUsd,
  type AiUsageCostSort,
  type AiUsageExecutionSummary,
  type AiUsageRecencySort,
  type AiUsageRollupBucket,
  type AiUsageTenantSection,
} from "@agents/db/ai-usage";

const WINDOW_OPTIONS = [7, 30, 90] as const;
const PAGE_SIZES = [10, 25, 50] as const;

export interface AiUsageDashboardClientProps {
  events: AiUsageEvent[];
  windowDays: number;
  adminTimeZone: string;
  emailByUserId: Record<string, string>;
  caseLabelById: Record<string, string>;
  droppedThisProcess: number;
  truncated: boolean;
  eventLimit: number;
}

function pct(fraction: number | null): string {
  if (fraction == null) return "—";
  return `${(fraction * 100).toFixed(1)}%`;
}

function shortId(id: string, head = 8): string {
  return id.length <= head ? id : `${id.slice(0, head)}…`;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

type StatTone = "neutral" | "cost" | "ok" | "warn" | "danger";

const STAT_TONE_CLASS: Record<StatTone, string> = {
  neutral:
    "border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900",
  cost: "border-teal-200/70 bg-teal-50/50 dark:border-teal-900 dark:bg-teal-950/40",
  ok: "border-emerald-200/70 bg-emerald-50/50 dark:border-emerald-900 dark:bg-emerald-950/40",
  warn: "border-amber-200/80 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/40",
  danger:
    "border-rose-200/80 bg-rose-50/50 dark:border-rose-900 dark:bg-rose-950/40",
};

function Stat({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: StatTone;
}) {
  return (
    <div className={`rounded-xl border p-3 ${STAT_TONE_CLASS[tone]}`}>
      <div className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
        {label}
      </div>
      <div className="mt-1 text-lg font-semibold text-neutral-900 dark:text-neutral-50">
        {value}
      </div>
      {hint ? (
        <p className="mt-1 text-[11px] leading-snug text-neutral-500">{hint}</p>
      ) : null}
    </div>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
  emptyLabel,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: string[];
  emptyLabel: string;
}) {
  return (
    <label className="flex min-w-[9rem] flex-col gap-1 text-[11px] text-neutral-500">
      <span className="font-semibold uppercase tracking-wide">{label}</span>
      <select
        className="rounded-lg border border-neutral-200 bg-white px-2 py-1.5 text-xs text-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{emptyLabel}</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

function SortSelect<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <label className="flex items-center gap-2 text-[11px] text-neutral-500">
      <span className="font-semibold">{label}</span>
      <select
        className="rounded-lg border border-neutral-200 bg-white px-2 py-1 text-xs text-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
        value={value}
        onChange={(event) => onChange(event.target.value as T)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function TablePager({
  total,
  page,
  pageSize,
  onPageChange,
  onPageSizeChange,
}: {
  total: number;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize) || 1);
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = total === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const end = Math.min(total, safePage * pageSize);

  return (
    <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-neutral-500">
      <p>
        Mostrando {start}–{end} de {total}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1">
          Filas
          <select
            className="rounded border border-neutral-200 bg-white px-1.5 py-0.5 text-xs dark:border-neutral-700 dark:bg-neutral-950"
            value={pageSize}
            onChange={(event) => onPageSizeChange(Number(event.target.value))}
          >
            {PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="rounded border border-neutral-200 px-2 py-0.5 disabled:opacity-40 dark:border-neutral-700"
          disabled={safePage <= 1}
          onClick={() => onPageChange(safePage - 1)}
        >
          Anterior
        </button>
        <span>
          {safePage} / {totalPages}
        </span>
        <button
          type="button"
          className="rounded border border-neutral-200 px-2 py-0.5 disabled:opacity-40 dark:border-neutral-700"
          disabled={safePage >= totalPages}
          onClick={() => onPageChange(safePage + 1)}
        >
          Siguiente
        </button>
      </div>
    </div>
  );
}

function RollupTable({
  title,
  buckets,
  keyLabel,
  sort,
  onSortChange,
  resolveKeyLabel,
  fixedDaySort,
}: {
  title: string;
  buckets: AiUsageRollupBucket[];
  keyLabel: string;
  sort?: AiUsageCostSort;
  onSortChange?: (sort: AiUsageCostSort) => void;
  resolveKeyLabel?: (key: string) => string;
  fixedDaySort?: boolean;
}) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const sorted = useMemo(() => {
    if (fixedDaySort) {
      return [...buckets].sort((a, b) => b.key.localeCompare(a.key));
    }
    return sortRollupBuckets(buckets, sort ?? "cost");
  }, [buckets, fixedDaySort, sort]);

  const slice = useMemo(
    () => paginateItems(sorted, page, pageSize),
    [sorted, page, pageSize]
  );

  return (
    <section className="rounded-2xl border border-neutral-200 border-l-[3px] border-l-slate-400/50 bg-slate-50/40 p-4 shadow-sm dark:border-neutral-800 dark:border-l-slate-500/40 dark:bg-slate-950/30">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          <p className="mt-1 text-[11px] text-neutral-500">
            {fixedDaySort
              ? "Cada fila es un día calendario en la zona del perfil del admin (misma que las horas del detalle), no UTC. "
              : ""}
            Costo contabilizado = Σ por evento (reportado por proveedor si
            existe; si no, estimado de catálogo). Las fracciones X/Y cuentan
            eventos con esa fuente sellada (componentes; no sumar columnas).
            En operación sana ambas deberían acercarse a Y.
          </p>
        </div>
        {!fixedDaySort && onSortChange ? (
          <SortSelect
            label="Orden"
            value={sort ?? "cost"}
            onChange={onSortChange}
            options={[
              { value: "cost", label: "Mayor costo" },
              { value: "events", label: "Más llamadas" },
              { value: "name", label: "Nombre" },
            ]}
          />
        ) : null}
      </div>
      {slice.total === 0 ? (
        <p className="mt-2 text-xs text-neutral-500">Sin eventos en la ventana.</p>
      ) : (
        <>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-neutral-500">
                <tr>
                  <th className="py-1 pr-3 font-semibold">{keyLabel}</th>
                  <th className="py-1 pr-3 font-semibold">Llamadas a modelos</th>
                  <th className="py-1 pr-3 font-semibold">Tokens in/out</th>
                  <th className="py-1 pr-3 font-semibold">Costo contabilizado</th>
                  <th className="py-1 pr-3 font-semibold">
                    Reportado por proveedor
                  </th>
                  <th className="py-1 pr-3 font-semibold">Estimado de catálogo</th>
                  <th className="py-1 pr-3 font-semibold">Errores</th>
                  <th className="py-1 font-semibold">Reintentos</th>
                </tr>
              </thead>
              <tbody>
                {slice.items.map((bucket) => (
                  <tr
                    key={bucket.key}
                    className="border-t border-neutral-100 dark:border-neutral-800"
                  >
                    <td className="max-w-72 truncate py-1.5 pr-3 font-mono">
                      {resolveKeyLabel
                        ? resolveKeyLabel(bucket.key)
                        : bucket.key}
                    </td>
                    <td className="py-1.5 pr-3">{bucket.events}</td>
                    <td className="py-1.5 pr-3">
                      {bucket.inputTokens.toLocaleString()} /{" "}
                      {bucket.outputTokens.toLocaleString()}
                    </td>
                    <td className="py-1.5 pr-3 font-medium text-teal-900/90 dark:text-teal-200/90">
                      {formatUsdFromMicro(bucket.effectiveCostMicroUsd)}
                    </td>
                    <td className="py-1.5 pr-3 text-slate-700 dark:text-slate-300">
                      {formatUsdFromMicro(bucket.reportedCostMicroUsd)}
                      <span className="text-neutral-400">
                        {" "}
                        · {bucket.reportedCostEvents}/{bucket.events}
                      </span>
                    </td>
                    <td className="py-1.5 pr-3 text-stone-600 dark:text-stone-400">
                      {formatUsdFromMicro(bucket.estimatedCostMicroUsd)}
                      <span className="text-neutral-400">
                        {" "}
                        · {bucket.estimatedCostEvents}/{bucket.events}
                      </span>
                    </td>
                    <td
                      className={`py-1.5 pr-3 ${
                        bucket.errorEvents > 0
                          ? "font-medium text-rose-700 dark:text-rose-300"
                          : ""
                      }`}
                    >
                      {bucket.errorEvents}
                    </td>
                    <td
                      className={`py-1.5 ${
                        bucket.retryEvents > 0
                          ? "text-amber-800 dark:text-amber-200"
                          : ""
                      }`}
                    >
                      {bucket.retryEvents}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <TablePager
            total={slice.total}
            page={slice.page}
            pageSize={slice.pageSize}
            onPageChange={setPage}
            onPageSizeChange={(size) => {
              setPageSize(size);
              setPage(1);
            }}
          />
        </>
      )}
    </section>
  );
}

function FunctionBreakdownTable({
  rows,
}: {
  rows: AiUsageExecutionSummary["byFunction"];
}) {
  if (rows.length === 0) {
    return (
      <p className="text-[11px] text-neutral-500">Sin desglose por función.</p>
    );
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-teal-100 bg-teal-50/40 p-2 dark:border-teal-900/50 dark:bg-teal-950/30">
      <p className="mb-1 text-[11px] font-semibold text-teal-900/80 dark:text-teal-200/80">
        Desglose por función de IA
      </p>
      <table className="w-full text-left text-[11px]">
        <thead className="text-neutral-500">
          <tr>
            <th className="py-1 pr-2 font-semibold">Función</th>
            <th className="py-1 pr-2 font-semibold">Proveedor</th>
            <th className="py-1 pr-2 font-semibold">Modelo</th>
            <th className="py-1 pr-2 font-semibold">Operación</th>
            <th className="py-1 pr-2 font-semibold">Llamadas</th>
            <th className="py-1 font-semibold">Costo</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={`${row.modelRole}:${row.provider}:${row.modelId}:${row.operation}`}
              className="border-t border-neutral-200 dark:border-neutral-800"
            >
              <td className="py-1 pr-2 font-mono">{row.modelRole}</td>
              <td className="py-1 pr-2 font-mono">{row.provider}</td>
              <td className="max-w-48 truncate py-1 pr-2 font-mono">
                {row.modelId}
              </td>
              <td className="py-1 pr-2">{row.operation}</td>
              <td className="py-1 pr-2">{row.events}</td>
              <td className="py-1">
                {formatUsdFromMicro(row.effectiveCostMicroUsd)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AccountSections({
  sections,
  emailByUserId,
  caseLabelById,
  adminTimeZone,
  accountSort,
  onAccountSortChange,
}: {
  sections: AiUsageTenantSection[];
  emailByUserId: Record<string, string>;
  caseLabelById: Record<string, string>;
  adminTimeZone: string;
  accountSort: AiUsageCostSort;
  onAccountSortChange: (sort: AiUsageCostSort) => void;
}) {
  const [expandedAccounts, setExpandedAccounts] = useState<Set<string>>(
    () => new Set(sections.slice(0, 3).map((section) => section.userId))
  );
  const [expandedExecutions, setExpandedExecutions] = useState<Set<string>>(
    () => new Set()
  );
  const [executionSort, setExecutionSort] =
    useState<AiUsageRecencySort>("recent");
  const [caseSort, setCaseSort] = useState<AiUsageRecencySort>("recent");
  const [execPageByUser, setExecPageByUser] = useState<Record<string, number>>(
    {}
  );
  const [execSizeByUser, setExecSizeByUser] = useState<Record<string, number>>(
    {}
  );
  const [casePageByUser, setCasePageByUser] = useState<Record<string, number>>(
    {}
  );
  const [caseSizeByUser, setCaseSizeByUser] = useState<Record<string, number>>(
    {}
  );
  const [uncorrPageByUser, setUncorrPageByUser] = useState<
    Record<string, number>
  >({});
  const [uncorrSizeByUser, setUncorrSizeByUser] = useState<
    Record<string, number>
  >({});

  const sortedSections = useMemo(() => {
    const withBuckets = sections.map((section) => section);
    if (accountSort === "name") {
      return [...withBuckets].sort((a, b) => {
        const aLabel = emailByUserId[a.userId] ?? a.userId;
        const bLabel = emailByUserId[b.userId] ?? b.userId;
        return aLabel.localeCompare(bLabel);
      });
    }
    if (accountSort === "events") {
      return [...withBuckets].sort(
        (a, b) =>
          b.summary.events - a.summary.events ||
          a.userId.localeCompare(b.userId)
      );
    }
    return [...withBuckets].sort(
      (a, b) =>
        b.summary.effectiveCostMicroUsd - a.summary.effectiveCostMicroUsd ||
        a.userId.localeCompare(b.userId)
    );
  }, [sections, accountSort, emailByUserId]);

  function toggleAccount(userId: string) {
    setExpandedAccounts((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }

  function toggleExecution(turnId: string) {
    setExpandedExecutions((prev) => {
      const next = new Set(prev);
      if (next.has(turnId)) next.delete(turnId);
      else next.add(turnId);
      return next;
    });
  }

  if (sortedSections.length === 0) {
    return (
      <section className="rounded-2xl border border-neutral-200 border-l-[3px] border-l-teal-600/45 bg-teal-50/30 p-4 shadow-sm dark:border-neutral-800 dark:border-l-teal-500/40 dark:bg-teal-950/25">
        <h2 className="text-sm font-semibold">Por cuenta</h2>
        <p className="mt-2 text-xs text-neutral-500">Sin eventos en la ventana.</p>
      </section>
    );
  }

  return (
    <section className="space-y-3 rounded-2xl border border-neutral-200 border-l-[3px] border-l-teal-600/45 bg-teal-50/30 p-4 shadow-sm dark:border-neutral-800 dark:border-l-teal-500/40 dark:bg-teal-950/25">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Por cuenta</h2>
          <p className="mt-1 text-[11px] text-neutral-500">
            Vistas alternativas de los mismos costos (no sumables entre sí): por
            ejecución (`turn_id`), por caso operacional y, si aplica, sin
            ejecución correlacionada (`turn_id` nulo).
          </p>
        </div>
        <SortSelect
          label="Orden"
          value={accountSort}
          onChange={onAccountSortChange}
          options={[
            { value: "cost", label: "Mayor costo" },
            { value: "events", label: "Más llamadas" },
            { value: "name", label: "Correo electrónico" },
          ]}
        />
      </div>

      {sortedSections.map((section) => {
        const email = emailByUserId[section.userId];
        const title = email
          ? `${email} · ${shortId(section.userId)}`
          : section.userId;
        const s = section.summary;
        const open = expandedAccounts.has(section.userId);
        const executions = sortExecutions(section.executions, executionSort);
        const cases = sortCases(section.cases, caseSort);
        const execPage = execPageByUser[section.userId] ?? 1;
        const execSize = execSizeByUser[section.userId] ?? 10;
        const casePage = casePageByUser[section.userId] ?? 1;
        const caseSize = caseSizeByUser[section.userId] ?? 10;
        const execSlice = paginateItems(executions, execPage, execSize);
        const caseSlice = paginateItems(cases, casePage, caseSize);
        const uncorrFunctions = section.uncorrelated?.byFunction ?? [];
        const uncorrPage = uncorrPageByUser[section.userId] ?? 1;
        const uncorrSize = uncorrSizeByUser[section.userId] ?? 10;
        const uncorrSlice = paginateItems(
          uncorrFunctions,
          uncorrPage,
          uncorrSize
        );

        return (
          <div
            key={section.userId}
            className="rounded-xl border border-teal-100/80 bg-white/80 p-3 dark:border-teal-900/40 dark:bg-neutral-900/70"
          >
            <button
              type="button"
              className="flex w-full flex-wrap items-baseline justify-between gap-2 text-left"
              onClick={() => toggleAccount(section.userId)}
              aria-expanded={open}
            >
              <h3 className="text-sm font-semibold font-mono">
                <span className="mr-2 text-neutral-400">{open ? "▼" : "▶"}</span>
                {title}
              </h3>
              <p className="text-xs text-neutral-500">
                {s.events} llamadas ·{" "}
                {formatUsdFromMicro(s.effectiveCostMicroUsd)} contabilizado ·
                con reportado {s.reportedCostEvents}/{s.events} · con
                estimado {s.estimatedCostEvents}/{s.events}
              </p>
            </button>
            <p className="mt-1 text-[11px] text-neutral-500">
              Tokens {s.inputTokens.toLocaleString()} /{" "}
              {s.outputTokens.toLocaleString()} · reportado por proveedor{" "}
              {formatUsdFromMicro(s.reportedCostMicroUsd)} · estimado de
              catálogo {formatUsdFromMicro(s.estimatedCostMicroUsd)}
            </p>

            {open ? (
              <div className="mt-3 space-y-4">
                <div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h4 className="text-xs font-semibold">Por ejecución</h4>
                      <p className="mt-0.5 text-[11px] text-neutral-500">
                        Agrupa todas las operaciones de IA con el mismo{" "}
                        <code>turn_id</code>. En Web/Telegram suele ser una
                        solicitud; en cron/heartbeat/case runner, una corrida
                        automática.
                      </p>
                    </div>
                    <SortSelect
                      label="Orden"
                      value={executionSort}
                      onChange={setExecutionSort}
                      options={[
                        { value: "recent", label: "Más recientes" },
                        { value: "cost", label: "Mayor costo" },
                      ]}
                    />
                  </div>
                  {execSlice.total === 0 ? (
                    <p className="mt-1 text-xs text-neutral-500">
                      Sin ejecuciones correlacionadas en la ventana.
                    </p>
                  ) : (
                    <>
                      <div className="mt-1 overflow-x-auto">
                        <table className="w-full text-left text-xs">
                          <thead className="text-neutral-500">
                            <tr>
                              <th className="py-1 pr-3 font-semibold w-6" />
                              <th className="py-1 pr-3 font-semibold">
                                Inicio ({adminTimeZone})
                              </th>
                              <th className="py-1 pr-3 font-semibold">
                                Última actividad
                              </th>
                              <th className="py-1 pr-3 font-semibold">Canal</th>
                              <th className="py-1 pr-3 font-semibold">
                                Ejecución (turn_id)
                              </th>
                              <th className="py-1 pr-3 font-semibold">Caso</th>
                              <th className="py-1 pr-3 font-semibold">
                                Llamadas
                              </th>
                              <th className="py-1 font-semibold">
                                Costo contabilizado
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {execSlice.items.map((execution) => {
                              const execOpen = expandedExecutions.has(
                                execution.turnId
                              );
                              return (
                                <Fragment key={execution.turnId}>
                                  <tr className="border-t border-neutral-100 dark:border-neutral-800">
                                    <td className="py-1.5 pr-2">
                                      <button
                                        type="button"
                                        className="text-neutral-400"
                                        aria-expanded={execOpen}
                                        onClick={() =>
                                          toggleExecution(execution.turnId)
                                        }
                                      >
                                        {execOpen ? "▼" : "▶"}
                                      </button>
                                    </td>
                                    <td className="py-1.5 pr-3 whitespace-nowrap">
                                      {formatAiUsageOccurredAt(
                                        execution.startedAt,
                                        adminTimeZone,
                                        { precision: "second" }
                                      )}
                                    </td>
                                    <td className="py-1.5 pr-3 whitespace-nowrap">
                                      {formatAiUsageOccurredAt(
                                        execution.lastOccurredAt,
                                        adminTimeZone,
                                        { precision: "second" }
                                      )}
                                    </td>
                                    <td className="py-1.5 pr-3">
                                      {execution.channel ?? "—"}
                                    </td>
                                    <td className="py-1.5 pr-3 font-mono">
                                      {shortId(execution.turnId)}
                                    </td>
                                    <td className="max-w-56 truncate py-1.5 pr-3 font-mono">
                                      {execution.operationalCaseId
                                        ? (caseLabelById[
                                            execution.operationalCaseId
                                          ] ??
                                          shortId(execution.operationalCaseId))
                                        : "—"}
                                    </td>
                                    <td className="py-1.5 pr-3">
                                      {execution.events}
                                    </td>
                                    <td className="py-1.5">
                                      {formatUsdFromMicro(
                                        execution.effectiveCostMicroUsd
                                      )}
                                    </td>
                                  </tr>
                                  {execOpen ? (
                                    <tr className="border-t border-neutral-100 dark:border-neutral-800">
                                      <td colSpan={8} className="py-2 pl-6">
                                        <FunctionBreakdownTable
                                          rows={execution.byFunction}
                                        />
                                      </td>
                                    </tr>
                                  ) : null}
                                </Fragment>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                      <TablePager
                        total={execSlice.total}
                        page={execSlice.page}
                        pageSize={execSlice.pageSize}
                        onPageChange={(page) =>
                          setExecPageByUser((prev) => ({
                            ...prev,
                            [section.userId]: page,
                          }))
                        }
                        onPageSizeChange={(size) => {
                          setExecSizeByUser((prev) => ({
                            ...prev,
                            [section.userId]: size,
                          }));
                          setExecPageByUser((prev) => ({
                            ...prev,
                            [section.userId]: 1,
                          }));
                        }}
                      />
                    </>
                  )}
                </div>

                <div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h4 className="text-xs font-semibold">
                        Por caso operacional
                      </h4>
                      <p className="mt-0.5 text-[11px] text-neutral-500">
                        Instancia de caso (`operational_case_id`), no el tipo
                        de caso. Vista alternativa de los mismos costos.
                      </p>
                    </div>
                    <SortSelect
                      label="Orden"
                      value={caseSort}
                      onChange={setCaseSort}
                      options={[
                        { value: "recent", label: "Actividad reciente" },
                        { value: "cost", label: "Mayor costo" },
                      ]}
                    />
                  </div>
                  {caseSlice.total === 0 ? (
                    <p className="mt-1 text-xs text-neutral-500">
                      Sin casos en la ventana.
                    </p>
                  ) : (
                    <>
                      <div className="mt-1 overflow-x-auto">
                        <table className="w-full text-left text-xs">
                          <thead className="text-neutral-500">
                            <tr>
                              <th className="py-1 pr-3 font-semibold">Caso</th>
                              <th className="py-1 pr-3 font-semibold">
                                Primera actividad
                              </th>
                              <th className="py-1 pr-3 font-semibold">
                                Última actividad
                              </th>
                              <th className="py-1 pr-3 font-semibold">
                                Ejecuciones
                              </th>
                              <th className="py-1 pr-3 font-semibold">
                                Llamadas
                              </th>
                              <th className="py-1 font-semibold">
                                Costo contabilizado
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {caseSlice.items.map((caseRow) => (
                              <tr
                                key={caseRow.operationalCaseId}
                                className="border-t border-neutral-100 dark:border-neutral-800"
                              >
                                <td className="max-w-96 truncate py-1.5 pr-3 font-mono">
                                  {caseLabelById[caseRow.operationalCaseId] ??
                                    shortId(caseRow.operationalCaseId)}
                                </td>
                                <td className="py-1.5 pr-3 whitespace-nowrap">
                                  {formatAiUsageOccurredAt(
                                    caseRow.firstOccurredAt,
                                    adminTimeZone
                                  )}
                                </td>
                                <td className="py-1.5 pr-3 whitespace-nowrap">
                                  {formatAiUsageOccurredAt(
                                    caseRow.lastOccurredAt,
                                    adminTimeZone
                                  )}
                                </td>
                                <td className="py-1.5 pr-3">
                                  {caseRow.executionCount}
                                </td>
                                <td className="py-1.5 pr-3">
                                  {caseRow.events}
                                </td>
                                <td className="py-1.5">
                                  {formatUsdFromMicro(
                                    caseRow.effectiveCostMicroUsd
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <TablePager
                        total={caseSlice.total}
                        page={caseSlice.page}
                        pageSize={caseSlice.pageSize}
                        onPageChange={(page) =>
                          setCasePageByUser((prev) => ({
                            ...prev,
                            [section.userId]: page,
                          }))
                        }
                        onPageSizeChange={(size) => {
                          setCaseSizeByUser((prev) => ({
                            ...prev,
                            [section.userId]: size,
                          }));
                          setCasePageByUser((prev) => ({
                            ...prev,
                            [section.userId]: 1,
                          }));
                        }}
                      />
                    </>
                  )}
                </div>

                {section.uncorrelated ? (
                  <div>
                    <h4 className="text-xs font-semibold">
                      Sin ejecución correlacionada
                    </h4>
                    <p className="mt-0.5 text-[11px] text-neutral-500">
                      Eventos con <code>turn_id = null</code> (p. ej. algunos
                      jobs de fondo). Ya están en el total de la cuenta; aquí se
                      muestran para reconciliar el detalle.
                    </p>
                    <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-300">
                      {section.uncorrelated.events} llamadas ·{" "}
                      {formatUsdFromMicro(
                        section.uncorrelated.effectiveCostMicroUsd
                      )}{" "}
                      contabilizado
                    </p>
                    <div className="mt-1 overflow-x-auto">
                      <table className="w-full text-left text-xs">
                        <thead className="text-neutral-500">
                          <tr>
                            <th className="py-1 pr-3 font-semibold">Función</th>
                            <th className="py-1 pr-3 font-semibold">
                              Proveedor
                            </th>
                            <th className="py-1 pr-3 font-semibold">Modelo</th>
                            <th className="py-1 pr-3 font-semibold">Canal*</th>
                            <th className="py-1 pr-3 font-semibold">
                              Llamadas
                            </th>
                            <th className="py-1 font-semibold">Costo</th>
                          </tr>
                        </thead>
                        <tbody>
                          {uncorrSlice.items.map((row) => (
                            <tr
                              key={`${row.modelRole}:${row.provider}:${row.modelId}:${row.operation}`}
                              className="border-t border-neutral-100 dark:border-neutral-800"
                            >
                              <td className="py-1.5 pr-3 font-mono">
                                {row.modelRole}
                              </td>
                              <td className="py-1.5 pr-3 font-mono">
                                {row.provider}
                              </td>
                              <td className="max-w-48 truncate py-1.5 pr-3 font-mono">
                                {row.modelId}
                              </td>
                              <td className="py-1.5 pr-3 text-neutral-400">
                                —
                              </td>
                              <td className="py-1.5 pr-3">{row.events}</td>
                              <td className="py-1.5">
                                {formatUsdFromMicro(row.effectiveCostMicroUsd)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p className="mt-1 text-[10px] text-neutral-400">
                      * El desglose de esta tabla es por función; canales del
                      grupo:{" "}
                      {section.uncorrelated.byChannel
                        .map(
                          (bucket) =>
                            `${bucket.key} (${formatUsdFromMicro(bucket.effectiveCostMicroUsd)})`
                        )
                        .join(", ") || "—"}
                    </p>
                    <TablePager
                      total={uncorrSlice.total}
                      page={uncorrSlice.page}
                      pageSize={uncorrSlice.pageSize}
                      onPageChange={(page) =>
                        setUncorrPageByUser((prev) => ({
                          ...prev,
                          [section.userId]: page,
                        }))
                      }
                      onPageSizeChange={(size) => {
                        setUncorrSizeByUser((prev) => ({
                          ...prev,
                          [section.userId]: size,
                        }));
                        setUncorrPageByUser((prev) => ({
                          ...prev,
                          [section.userId]: 1,
                        }));
                      }}
                    />
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}

export function AiUsageDashboardClient({
  events,
  windowDays,
  adminTimeZone,
  emailByUserId,
  caseLabelById,
  droppedThisProcess,
  truncated,
  eventLimit,
}: AiUsageDashboardClientProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [userId, setUserId] = useState("");
  const [provider, setProvider] = useState("");
  const [channel, setChannel] = useState("");
  const [modelRole, setModelRole] = useState("");
  const [modelId, setModelId] = useState("");
  const [status, setStatus] = useState("");

  const [accountSort, setAccountSort] = useState<AiUsageCostSort>("cost");
  const [providerSort, setProviderSort] = useState<AiUsageCostSort>("cost");
  const [modelSort, setModelSort] = useState<AiUsageCostSort>("cost");
  const [roleSort, setRoleSort] = useState<AiUsageCostSort>("cost");
  const [channelSort, setChannelSort] = useState<AiUsageCostSort>("cost");

  const filterOptions = useMemo(() => {
    return {
      userIds: uniqueSorted(events.map((event) => event.user_id)),
      providers: uniqueSorted(
        events.map((event) => event.provider || "(none)")
      ),
      channels: uniqueSorted(
        events.map((event) => event.channel ?? "(none)")
      ),
      roles: uniqueSorted(events.map((event) => event.model_role)),
      models: uniqueSorted(events.map((event) => event.model_id)),
      statuses: uniqueSorted(events.map((event) => event.status)),
    };
  }, [events]);

  const userOptions = useMemo(() => {
    return filterOptions.userIds.map((id) => ({
      id,
      label: emailByUserId[id] ? `${emailByUserId[id]} · ${shortId(id)}` : id,
    }));
  }, [filterOptions.userIds, emailByUserId]);

  const filtered = useMemo(
    () =>
      filterAiUsageEvents(events, {
        userId: userId || null,
        provider: provider || null,
        channel: channel || null,
        modelRole: modelRole || null,
        modelId: modelId || null,
        status: status || null,
      }),
    [events, userId, provider, channel, modelRole, modelId, status]
  );

  const accountedTotal = totalEffectiveCostMicroUsd(filtered);
  const split = effectiveCostSplitMicroUsd(filtered);
  const reportedEvents = reportedCostEventCount(filtered);
  const estimatedEvents = estimatedCostEventCount(filtered);
  const callCoverage = reportedCostCoverage(filtered);
  const estimateCoverage = estimatedCostCoverage(filtered);
  const moneyCoverage = reportedCostMoneyCoverage(filtered);
  const comparison = aggregateCostComparisonMicroUsd(filtered);
  const missingEstimates = useMemo(
    () => eventsMissingCatalogEstimate(filtered),
    [filtered]
  );
  const errorCount = filtered.filter((event) => event.status === "error").length;
  const retryCount = filtered.filter((event) => event.retry_ordinal > 0).length;
  const expensive = mostExpensiveAiUsageEvents(filtered, 25);
  const tenantSections = useMemo(
    () => buildAiUsageTenantSections(filtered),
    [filtered]
  );

  const hasFilters = Boolean(
    userId || provider || channel || modelRole || modelId || status
  );

  function clearFilters() {
    setUserId("");
    setProvider("");
    setChannel("");
    setModelRole("");
    setModelId("");
    setStatus("");
  }

  function setWindowDays(days: number) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("days", String(days));
    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <div className="space-y-4">
      {truncated ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
          Se alcanzó el límite de {eventLimit.toLocaleString()} eventos en la
          ventana; los totales pueden estar incompletos.
        </div>
      ) : null}

      {missingEstimates.length > 0 ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
          <p className="font-semibold">
            {missingEstimates.length} llamada
            {missingEstimates.length === 1 ? "" : "s"} con tokens pero sin
            estimado de catálogo
          </p>
          <p className="mt-1">
            Suele indicar modelo fuera del catálogo activo o un fallo al
            sellar el estimado. Modelos:{" "}
            {[...new Set(missingEstimates.map((event) => event.model_id))]
              .slice(0, 8)
              .join(", ")}
            {missingEstimates.length > 8 ? "…" : ""}. Conviene preguntar por
            qué no cuadra antes de confiar en la comparación dual-cost.
          </p>
        </div>
      ) : null}

      <div className="flex flex-wrap items-end gap-3 rounded-2xl border border-slate-200 bg-slate-50/70 p-3 dark:border-slate-800 dark:bg-slate-950/40">
        <label className="flex min-w-[8rem] flex-col gap-1 text-[11px] text-neutral-500">
          <span className="font-semibold uppercase tracking-wide">Periodo</span>
          <select
            className="rounded-lg border border-neutral-200 bg-white px-2 py-1.5 text-xs text-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
            value={windowDays}
            onChange={(event) => setWindowDays(Number(event.target.value))}
          >
            {WINDOW_OPTIONS.map((days) => (
              <option key={days} value={days}>
                {days} días
              </option>
            ))}
          </select>
        </label>

        <label className="flex min-w-[12rem] flex-col gap-1 text-[11px] text-neutral-500">
          <span className="font-semibold uppercase tracking-wide">Cuenta</span>
          <select
            className="rounded-lg border border-neutral-200 bg-white px-2 py-1.5 text-xs text-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
            value={userId}
            onChange={(event) => setUserId(event.target.value)}
          >
            <option value="">Todas</option>
            {userOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <SelectField
          label="Proveedor"
          value={provider}
          onChange={setProvider}
          options={filterOptions.providers}
          emptyLabel="Todos"
        />
        <SelectField
          label="Canal"
          value={channel}
          onChange={setChannel}
          options={filterOptions.channels}
          emptyLabel="Todos"
        />
        <SelectField
          label="Función de IA"
          value={modelRole}
          onChange={setModelRole}
          options={filterOptions.roles}
          emptyLabel="Todas"
        />
        <SelectField
          label="Modelo"
          value={modelId}
          onChange={setModelId}
          options={filterOptions.models}
          emptyLabel="Todos"
        />
        <SelectField
          label="Estado"
          value={status}
          onChange={setStatus}
          options={filterOptions.statuses}
          emptyLabel="Todos"
        />

        <button
          type="button"
          className="rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-medium disabled:opacity-40 dark:border-neutral-600"
          disabled={!hasFilters}
          onClick={clearFilters}
        >
          Limpiar filtros
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Llamadas a modelos"
          value={filtered.length.toLocaleString()}
          hint="1 evento por llamada al modelo; reintentos = filas nuevas"
        />
        <Stat
          label="Costo contabilizado"
          value={formatUsdFromMicro(accountedTotal)}
          hint={`Costo reportado por el proveedor cuando existe; catálogo como fallback. Aportado por proveedor ${formatUsdFromMicro(split.fromReported)} · por fallback ${formatUsdFromMicro(split.fromEstimated)}`}
          tone="cost"
        />
        <Stat
          label="Cobertura reportado / estimado"
          value={`${reportedEvents}/${filtered.length} · ${estimatedEvents}/${filtered.length}`}
          hint={`Reportado ${pct(callCoverage)} de llamadas · estimado de catálogo ${pct(estimateCoverage)}. Dinero contabilizado desde proveedor: ${pct(moneyCoverage)}. Si no cuadra con el total, investigar.`}
          tone={
            filtered.length > 0 &&
            reportedEvents === filtered.length &&
            estimatedEvents === filtered.length
              ? "ok"
              : missingEstimates.length > 0 ||
                  reportedEvents < filtered.length
                ? "warn"
                : "neutral"
          }
        />
        <Stat
          label="Errores / reintentos / drops"
          value={`${errorCount} / ${retryCount} / ${droppedThisProcess}`}
          hint="Drops = este proceso Node desde el arranque (no histórico en DB)"
          tone={
            errorCount > 0 || droppedThisProcess > 0
              ? "danger"
              : retryCount > 0
                ? "warn"
                : "neutral"
          }
        />
      </div>

      {comparison ? (
        <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-3 text-xs dark:border-slate-800 dark:bg-slate-950/30">
          <div className="font-semibold">
            Comparación reportado por proveedor vs estimado de catálogo (solo
            llamadas con ambas fuentes)
          </div>
          <p className="mt-1 text-neutral-500">
            {comparison.comparableEvents} llamadas ·{" "}
            <span className="text-slate-700 dark:text-slate-300">
              reportado por proveedor {formatUsdFromMicro(comparison.reported)}
            </span>{" "}
            ·{" "}
            <span className="text-stone-600 dark:text-stone-400">
              estimado de catálogo {formatUsdFromMicro(comparison.estimated)}
            </span>{" "}
            · Δ {formatUsdFromMicro(comparison.delta)}
            {comparison.deltaPct != null
              ? ` (${(comparison.deltaPct * 100).toFixed(1)}%)`
              : ""}
            . Diferencias grandes suelen indicar catálogo obsoleto, caché o
            routing distinto al precio listado.
          </p>
        </div>
      ) : null}

      <RollupTable
        title="Por día"
        keyLabel="Día"
        buckets={rollupAiUsage(filtered, "day", {
          timeZone: adminTimeZone,
        })}
        fixedDaySort
      />
      <AccountSections
        sections={tenantSections}
        emailByUserId={emailByUserId}
        caseLabelById={caseLabelById}
        adminTimeZone={adminTimeZone}
        accountSort={accountSort}
        onAccountSortChange={setAccountSort}
      />
      <RollupTable
        title="Por proveedor"
        keyLabel="Proveedor"
        buckets={rollupAiUsage(filtered, "provider")}
        sort={providerSort}
        onSortChange={setProviderSort}
      />
      <RollupTable
        title="Por modelo"
        keyLabel="Modelo"
        buckets={rollupAiUsage(filtered, "model")}
        sort={modelSort}
        onSortChange={setModelSort}
      />
      <RollupTable
        title="Por función de IA"
        keyLabel="Función"
        buckets={rollupAiUsage(filtered, "role")}
        sort={roleSort}
        onSortChange={setRoleSort}
      />
      <RollupTable
        title="Por canal"
        keyLabel="Canal"
        buckets={rollupAiUsage(filtered, "channel")}
        sort={channelSort}
        onSortChange={setChannelSort}
      />

      <section className="rounded-2xl border border-neutral-200 border-l-[3px] border-l-orange-400/55 bg-orange-50/25 p-4 shadow-sm dark:border-neutral-800 dark:border-l-orange-500/40 dark:bg-orange-950/20">
        <h2 className="text-sm font-semibold">Llamadas más caras</h2>
        <p className="mt-1 text-[11px] text-neutral-500">
          Orden fijo por costo contabilizado descendente.
        </p>
        {expensive.length === 0 ? (
          <p className="mt-2 text-xs text-neutral-500">
            Sin eventos en la ventana.
          </p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-neutral-500">
                <tr>
                  <th className="py-1 pr-3 font-semibold">
                    Cuándo ({adminTimeZone})
                  </th>
                  <th className="py-1 pr-3 font-semibold">Cuenta</th>
                  <th className="py-1 pr-3 font-semibold">Proveedor</th>
                  <th className="py-1 pr-3 font-semibold">Modelo</th>
                  <th className="py-1 pr-3 font-semibold">Función de IA</th>
                  <th className="py-1 pr-3 font-semibold">Canal</th>
                  <th className="py-1 pr-3 font-semibold">Tokens in/out</th>
                  <th className="py-1 pr-3 font-semibold">
                    Costo contabilizado
                  </th>
                  <th className="py-1 font-semibold">Estado</th>
                </tr>
              </thead>
              <tbody>
                {expensive.map((event) => (
                  <tr
                    key={event.id}
                    className="border-t border-neutral-100 dark:border-neutral-800"
                  >
                    <td className="py-1.5 pr-3 whitespace-nowrap">
                      {formatAiUsageOccurredAt(
                        event.occurred_at,
                        adminTimeZone
                      )}
                    </td>
                    <td className="max-w-48 truncate py-1.5 pr-3">
                      {emailByUserId[event.user_id] ?? shortId(event.user_id)}
                    </td>
                    <td className="py-1.5 pr-3 font-mono">
                      {event.provider || "—"}
                    </td>
                    <td className="py-1.5 pr-3 font-mono">{event.model_id}</td>
                    <td className="py-1.5 pr-3">{event.model_role}</td>
                    <td className="py-1.5 pr-3">{event.channel ?? "—"}</td>
                    <td className="py-1.5 pr-3">
                      {(event.input_tokens ?? 0).toLocaleString()} /{" "}
                      {(event.output_tokens ?? 0).toLocaleString()}
                    </td>
                    <td className="py-1.5 pr-3 font-medium text-teal-900/90 dark:text-teal-200/90">
                      {formatUsdFromMicro(effectiveCostMicroUsd(event))}
                      {event.reported_cost_micro_usd == null
                        ? " (estimado de catálogo)"
                        : ""}
                      {event.reported_cost_micro_usd != null &&
                      event.estimated_cost_micro_usd != null
                        ? ` · est. ${formatUsdFromMicro(event.estimated_cost_micro_usd)}`
                        : ""}
                    </td>
                    <td
                      className={`py-1.5 ${
                        event.status === "error"
                          ? "font-medium text-rose-700 dark:text-rose-300"
                          : ""
                      }`}
                    >
                      {event.status}
                      {event.retry_ordinal > 0
                        ? ` · retry ${event.retry_ordinal}`
                        : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
