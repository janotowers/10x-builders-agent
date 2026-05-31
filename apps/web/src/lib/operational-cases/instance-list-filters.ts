import type { OperationalCase, OperationalCaseType } from "@agents/types";

export type OperationalCasesListFilters = {
  type?: string;
  status?: string;
  step?: string;
  kind?: "all" | "real" | "test";
  sort?: "updated_desc" | "updated_asc";
};

type OperationalCasesListSearch = {
  type?: string | string[];
  status?: string | string[];
  step?: string | string[];
  kind?: string | string[];
  sort?: string | string[];
  case?: string | string[];
};

export function searchParamValue(
  value: string | string[] | undefined
): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed || undefined;
}

export function parseOperationalCasesListFilters(
  search: OperationalCasesListSearch
): OperationalCasesListFilters {
  const kindRaw = searchParamValue(search.kind);
  const kind =
    kindRaw === "real" || kindRaw === "test" || kindRaw === "all"
      ? kindRaw
      : "all";
  const sortRaw = searchParamValue(search.sort);
  const sort =
    sortRaw === "updated_asc" || sortRaw === "updated_desc"
      ? sortRaw
      : "updated_desc";
  return {
    type: searchParamValue(search.type),
    status: searchParamValue(search.status),
    step: searchParamValue(search.step),
    kind,
    sort,
  };
}

export function caseMatchesTypeFilter(
  opCase: OperationalCase,
  filterTypeId: string,
  caseTypeMap: Map<string, OperationalCaseType>
): boolean {
  if (opCase.case_type_id === filterTypeId) return true;
  const selectedType = caseTypeMap.get(filterTypeId);
  if (!selectedType) return false;
  const slug = selectedType.case_type;
  if (opCase.case_type === slug) return true;
  const instanceType = caseTypeMap.get(opCase.case_type_id);
  return instanceType?.case_type === slug;
}

export function filterOperationalCases(
  cases: OperationalCase[],
  filters: OperationalCasesListFilters,
  caseTypeMap: Map<string, OperationalCaseType>,
  allowedStatuses: readonly string[]
): OperationalCase[] {
  let result = cases;
  if (filters.type) {
    result = result.filter((opCase) =>
      caseMatchesTypeFilter(opCase, filters.type!, caseTypeMap)
    );
  }
  if (filters.status && allowedStatuses.includes(filters.status)) {
    result = result.filter((opCase) => opCase.status === filters.status);
  }
  if (filters.step) {
    result = result.filter((opCase) => opCase.current_step === filters.step);
  }
  if (filters.kind === "real") {
    result = result.filter((opCase) => opCase.context_jsonb?.test_mode !== true);
  } else if (filters.kind === "test") {
    result = result.filter((opCase) => opCase.context_jsonb?.test_mode === true);
  }
  const ascending = filters.sort === "updated_asc";
  return [...result].sort((a, b) => {
    const left = new Date(a.updated_at).getTime();
    const right = new Date(b.updated_at).getTime();
    return ascending ? left - right : right - left;
  });
}

export function operationalCasesListHref(
  filters: OperationalCasesListFilters,
  opts: { caseId?: string } = {}
): string {
  const params = new URLSearchParams();
  if (opts.caseId) params.set("case", opts.caseId);
  if (filters.type) params.set("type", filters.type);
  if (filters.status) params.set("status", filters.status);
  if (filters.step) params.set("step", filters.step);
  if (filters.kind && filters.kind !== "all") params.set("kind", filters.kind);
  if (filters.sort && filters.sort !== "updated_desc") {
    params.set("sort", filters.sort);
  }
  const query = params.toString();
  return query ? `/operational-cases?${query}` : "/operational-cases";
}

export function operationalCasesListQuerySuffix(
  filters: OperationalCasesListFilters
): string {
  const href = operationalCasesListHref(filters);
  const queryIndex = href.indexOf("?");
  return queryIndex >= 0 ? href.slice(queryIndex) : "";
}

export function readOperationalCasesListFiltersFromForm(
  form: HTMLFormElement
): OperationalCasesListFilters {
  const data = new FormData(form);
  return parseOperationalCasesListFilters({
    type: String(data.get("type") ?? ""),
    status: String(data.get("status") ?? ""),
    step: String(data.get("step") ?? ""),
    kind: String(data.get("kind") ?? "all"),
    sort: String(data.get("sort") ?? "updated_desc"),
  });
}
