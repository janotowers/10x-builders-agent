"use client";

import { useRouter } from "next/navigation";
import type { OperationalCaseStatus, OperationalCaseType } from "@agents/types";
import {
  operationalCasesListHref,
  readOperationalCasesListFiltersFromForm,
  type OperationalCasesListFilters,
} from "@/lib/operational-cases/instance-list-filters";

type StatusOption = {
  value: OperationalCaseStatus;
  label: string;
};

type StepOption = {
  value: string;
  label: string;
};

export function OperationalCasesFilters({
  caseTypes,
  filters,
  statusOptions,
  stepOptions,
  resultCount,
  totalCount,
}: {
  caseTypes: OperationalCaseType[];
  filters: OperationalCasesListFilters;
  statusOptions: StatusOption[];
  stepOptions: StepOption[];
  resultCount: number;
  totalCount: number;
}) {
  const router = useRouter();
  const hasActiveFilters =
    Boolean(filters.type) ||
    Boolean(filters.status) ||
    Boolean(filters.step) ||
    (filters.kind && filters.kind !== "all") ||
    filters.sort === "updated_asc";

  function applyFilters(form: HTMLFormElement) {
    const nextFilters = readOperationalCasesListFiltersFromForm(form);
    router.push(operationalCasesListHref(nextFilters));
  }

  return (
    <div className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Flujos en curso</h2>
          <p className="mt-1 text-xs text-neutral-500">
            {resultCount === totalCount
              ? `${totalCount} en total`
              : `Mostrando ${resultCount} de ${totalCount}`}
          </p>
        </div>
        {hasActiveFilters ? (
          <a
            href="/operational-cases"
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-semibold hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            Limpiar filtros
          </a>
        ) : null}
      </div>

      <form
        action="/operational-cases"
        method="get"
        className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5"
        onSubmit={(event) => {
          event.preventDefault();
          applyFilters(event.currentTarget);
        }}
      >
        <label className="block text-xs">
          <span className="font-semibold text-neutral-600 dark:text-neutral-300">
            Caso de uso
          </span>
          <select
            name="type"
            defaultValue={filters.type ?? ""}
            onChange={(event) => {
              const form = event.currentTarget.form;
              if (form) applyFilters(form);
            }}
            className="mt-1 w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-950"
          >
            <option value="">Todos</option>
            {caseTypes.map((type) => (
              <option key={type.id} value={type.id}>
                {type.display_name}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-xs">
          <span className="font-semibold text-neutral-600 dark:text-neutral-300">
            Estado
          </span>
          <select
            name="status"
            defaultValue={filters.status ?? ""}
            onChange={(event) => {
              const form = event.currentTarget.form;
              if (form) applyFilters(form);
            }}
            className="mt-1 w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-950"
          >
            <option value="">Todos</option>
            {statusOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-xs">
          <span className="font-semibold text-neutral-600 dark:text-neutral-300">
            Paso / etapa
          </span>
          <select
            name="step"
            defaultValue={filters.step ?? ""}
            onChange={(event) => {
              const form = event.currentTarget.form;
              if (form) applyFilters(form);
            }}
            className="mt-1 w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-950"
          >
            <option value="">Todas</option>
            {stepOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-xs">
          <span className="font-semibold text-neutral-600 dark:text-neutral-300">
            Tipo
          </span>
          <select
            name="kind"
            defaultValue={filters.kind ?? "all"}
            onChange={(event) => {
              const form = event.currentTarget.form;
              if (form) applyFilters(form);
            }}
            className="mt-1 w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-950"
          >
            <option value="all">Reales y prueba</option>
            <option value="real">Solo reales</option>
            <option value="test">Solo prueba</option>
          </select>
        </label>

        <label className="block text-xs">
          <span className="font-semibold text-neutral-600 dark:text-neutral-300">
            Orden
          </span>
          <select
            name="sort"
            defaultValue={filters.sort ?? "updated_desc"}
            onChange={(event) => {
              const form = event.currentTarget.form;
              if (form) applyFilters(form);
            }}
            className="mt-1 w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-950"
          >
            <option value="updated_desc">Más recientes primero</option>
            <option value="updated_asc">Más antiguos primero</option>
          </select>
        </label>
      </form>
    </div>
  );
}

export type { OperationalCasesListFilters };
