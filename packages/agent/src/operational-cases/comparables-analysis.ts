import { classifyComparableSearchOutcome } from "./comparable-search-contract";
type RecordValue = Record<string, unknown>;

const SOURCE_TOOL_NAMES = [
  "easybroker_search_listings",
  "easybroker_search_closed_deals",
  "bigquery_lookup_local_comparables",
  "get_avaclick_valuation",
] as const;

export type ComparableSourceToolName = (typeof SOURCE_TOOL_NAMES)[number];

export type ComparableToolCallInput = {
  tool_name: string;
  status: string;
  arguments_json?: RecordValue | null;
  result_json?: RecordValue | null;
  created_at?: string | null;
};

type ComparableRow = {
  source: string;
  id: string | null;
  title?: string | null;
  address?: string | null;
  url?: string | null;
  price: number | null;
  area_m2: number | null;
  price_per_m2: number | null;
  property_type?: string | null;
  operation?: string | null;
  bedrooms?: number | null;
  bathrooms?: number | null;
  parking_spaces?: number | null;
  price_basis?: string | null;
  is_closed_price?: boolean;
  usable_as_comparable: boolean;
  quality_reasons: string[];
};

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function positiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function latestExecutedToolCall(
  toolCalls: ComparableToolCallInput[],
  toolName: ComparableSourceToolName
) {
  return [...toolCalls]
    .filter((call) => call.tool_name === toolName && call.status === "executed")
    .sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")))
    .at(-1);
}

function latestToolCall(
  toolCalls: ComparableToolCallInput[],
  toolName: ComparableSourceToolName
) {
  return [...toolCalls]
    .filter((call) => call.tool_name === toolName)
    .sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")))
    .at(-1);
}

function resultArray(result: RecordValue | null | undefined, key: "results" | "rows") {
  const value = result?.[key];
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function comparableKey(row: ComparableRow) {
  if (row.id) return `${row.source}:${row.id}`;
  return `${row.source}:${row.url ?? ""}:${row.title ?? ""}:${row.price ?? ""}:${row.area_m2 ?? ""}`;
}

/** Mínimo de comparables ÚNICOS (cross-source) para una muestra defendible. */
export const MIN_DEFENSIBLE_UNIQUE_COMPARABLES = 3;

function normalizeUrlForKey(url: string): string {
  return url.trim().toLowerCase().replace(/[?#].*$/, "").replace(/\/+$/, "");
}

/**
 * Clave canónica que IGNORA la fuente para deduplicar el mismo inmueble cuando
 * aparece en varias fuentes (p. ej. EasyBroker activas + cerradas, o EasyBroker
 * + inventario interno). Prioriza identificadores estables (url, id de
 * EasyBroker) y cae a una firma fuerte (dirección/título + precio + área) solo
 * cuando los tres componentes están presentes, para evitar fusiones falsas.
 */
function canonicalComparableKey(row: ComparableRow): string {
  const url = cleanString(row.url);
  if (url) return `u:${normalizeUrlForKey(url)}`;
  const id = cleanString(row.id)?.toLowerCase();
  if (id) {
    // EasyBroker activas/cerradas comparten el mismo espacio de ids.
    if (row.source === "easybroker_active" || row.source === "easybroker_historical") {
      return `eb:${id}`;
    }
    return `${row.source}:${id}`;
  }
  const addr = cleanString(row.address) ?? cleanString(row.title);
  if (addr && positiveNumber(row.price) && positiveNumber(row.area_m2)) {
    return `s:${addr.toLowerCase().replace(/\s+/g, " ")}|${row.price}|${row.area_m2}`;
  }
  // Sin identificadores ni firma fuerte: mantener único por fuente.
  return `weak:${comparableKey(row)}`;
}

/** Filas usables deduplicadas cross-source por clave canónica. */
function uniqueUsableComparables(rows: ComparableRow[]): ComparableRow[] {
  const seen = new Set<string>();
  const out: ComparableRow[] = [];
  for (const row of rows) {
    if (!row.usable_as_comparable) continue;
    const key = canonicalComparableKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function easyBrokerQualityReasons(row: Pick<ComparableRow, "price" | "id" | "url">) {
  const reasons: string[] = [];
  if (!positiveNumber(row.price)) reasons.push("missing_price");
  if (!row.id && !row.url) reasons.push("missing_identifier");
  return reasons;
}

function normalizeEasyBrokerRow(value: RecordValue, source: "easybroker_active" | "easybroker_historical"): ComparableRow {
  const price = numberOrNull(value.price);
  const areaM2 = numberOrNull(value.area_m2);
  const row: ComparableRow = {
    source,
    id: cleanString(value.id),
    title: cleanString(value.title),
    url: cleanString(value.url),
    price,
    area_m2: areaM2,
    price_per_m2:
      positiveNumber(price) && positiveNumber(areaM2) ? Math.round(price / areaM2) : null,
    property_type: cleanString(value.property_type),
    operation: cleanString(value.operation),
    bedrooms: numberOrNull(value.bedrooms),
    bathrooms: numberOrNull(value.bathrooms),
    parking_spaces: numberOrNull(value.parking_spaces),
    price_basis: source === "easybroker_historical" ? "published_or_captured_reference" : "asking_price",
    is_closed_price: false,
    usable_as_comparable: false,
    quality_reasons: [],
  };
  row.quality_reasons = easyBrokerQualityReasons(row);
  row.usable_as_comparable = row.quality_reasons.length === 0;
  return row;
}

function normalizeBigQueryRow(value: RecordValue): ComparableRow {
  const price = numberOrNull(value.price);
  const areaM2 = numberOrNull(value.area_m2);
  const qualityReasons = Array.isArray(value.quality_reasons)
    ? value.quality_reasons.filter((item): item is string => typeof item === "string")
    : [];
  if (!positiveNumber(price) && !qualityReasons.includes("missing_price")) {
    qualityReasons.push("missing_price");
  }
  const cityState = [value.city, value.state]
    .map(cleanString)
    .filter(Boolean)
    .join(", ");
  const address = cleanString(value.address) ?? (cityState || null);
  return {
    source: "bigquery_internal_inventory",
    id: cleanString(value.id),
    address,
    url: cleanString(value.url),
    price,
    area_m2: areaM2,
    price_per_m2:
      positiveNumber(price) && positiveNumber(areaM2) ? Math.round(price / areaM2) : null,
    property_type: cleanString(value.property_type),
    operation: cleanString(value.operation),
    bedrooms: numberOrNull(value.bedrooms),
    bathrooms: numberOrNull(value.bathrooms),
    price_basis: cleanString(value.price_basis) ?? "asking_price",
    is_closed_price: value.is_closed_price === true,
    usable_as_comparable:
      value.usable_as_comparable === true && qualityReasons.length === 0 && positiveNumber(price),
    quality_reasons: qualityReasons,
  };
}

function dedupeComparableRows(rows: ComparableRow[]) {
  const seen = new Set<string>();
  const deduped: ComparableRow[] = [];
  let duplicates = 0;
  for (const row of rows) {
    const key = comparableKey(row);
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    deduped.push(row);
  }
  return { rows: deduped, duplicates };
}

function percentileNearestRank(sortedValues: number[], percentile: number) {
  if (sortedValues.length === 0) return null;
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(percentile * sortedValues.length) - 1)
  );
  return sortedValues[index];
}

function priceStats(rows: ComparableRow[]) {
  const prices = rows
    .filter((row) => row.usable_as_comparable)
    .map((row) => row.price)
    .filter((price): price is number => positiveNumber(price))
    .sort((a, b) => a - b);
  return {
    p25: percentileNearestRank(prices, 0.25),
    p50: percentileNearestRank(prices, 0.5),
    p75: percentileNearestRank(prices, 0.75),
    sample_size: prices.length,
    sources: Array.from(
      new Set(rows.filter((row) => row.usable_as_comparable && positiveNumber(row.price)).map((row) => row.source))
    ),
  };
}

function pricePerM2Stats(rows: ComparableRow[]) {
  const values = rows
    .filter((row) => row.usable_as_comparable)
    .map((row) => row.price_per_m2)
    .filter((price): price is number => positiveNumber(price))
    .sort((a, b) => a - b);
  return {
    available: values.length >= 3,
    p25: percentileNearestRank(values, 0.25),
    p50: percentileNearestRank(values, 0.5),
    p75: percentileNearestRank(values, 0.75),
    sample_size: values.length,
    sources: Array.from(
      new Set(rows.filter((row) => row.usable_as_comparable && positiveNumber(row.price_per_m2)).map((row) => row.source))
    ),
  };
}

function filtersFromCalls(toolCalls: ComparableToolCallInput[]) {
  const firstArgs = SOURCE_TOOL_NAMES
    .map((toolName) => latestExecutedToolCall(toolCalls, toolName)?.arguments_json)
    .find(isRecord);
  const firstResultFilters = SOURCE_TOOL_NAMES
    .map((toolName) => {
      const result = latestExecutedToolCall(toolCalls, toolName)?.result_json;
      return isRecord(result?.filters_used) ? result.filters_used : isRecord(result?.query) ? result.query : null;
    })
    .find(isRecord);
  const source = firstResultFilters ?? firstArgs ?? {};
  return {
    neighborhood: cleanString(source.neighborhood) ?? cleanString(source.zona),
    zona: cleanString(source.zona) ?? cleanString(source.neighborhood),
    operation: cleanString(source.operation),
    property_type: cleanString(source.property_type),
    min_area_m2: numberOrNull(source.min_area_m2),
    max_area_m2: numberOrNull(source.max_area_m2),
    months_back: numberOrNull(source.months_back) ?? 12,
  };
}

function normalizeAvaclickValuation(result: RecordValue | null | undefined): {
  valuation: RecordValue | null;
  failure_warning: string | null;
} {
  if (!isRecord(result)) {
    return { valuation: null, failure_warning: null };
  }
  if (result.ok !== true) {
    const status = cleanString(result.status);
    const message = cleanString(result.message);
    const missingFields = Array.isArray(result.missing_required_fields)
      ? result.missing_required_fields.filter(
          (field): field is string => typeof field === "string" && field.trim().length > 0
        )
      : [];
    if (status === "validation_error" && missingFields.length > 0) {
      return {
        valuation: null,
        failure_warning:
          `Avaclick omitido por faltantes mínimos: ${missingFields.join(", ")}.`,
      };
    }
    return {
      valuation: null,
      failure_warning:
        message != null
          ? `Avaclick no disponible (${status ?? "error"}): ${message}`
          : `Avaclick no disponible (${status ?? "error"}).`,
    };
  }
  return {
    valuation: {
      source: "avaclick",
      sale_average_mxn: numberOrNull(result.sale_average_mxn),
      sale_min_mxn: numberOrNull(result.sale_min_mxn),
      sale_max_mxn: numberOrNull(result.sale_max_mxn),
      rent_average_mxn: numberOrNull(result.rent_average_mxn),
      rent_min_mxn: numberOrNull(result.rent_min_mxn),
      rent_max_mxn: numberOrNull(result.rent_max_mxn),
      price_per_m2_min_mxn: numberOrNull(result.price_per_m2_min_mxn),
      price_per_m2_max_mxn: numberOrNull(result.price_per_m2_max_mxn),
      pdf_url: cleanString(result.pdf_url),
      warning:
        cleanString(result.warning) ??
        "Opinión digital de valor (no avalúo legal/fiscal/bancario).",
    },
    failure_warning: null,
  };
}

const SOURCE_TOOL_LABELS: Record<ComparableSourceToolName, string> = {
  easybroker_search_listings: "EasyBroker (activas/publicadas)",
  easybroker_search_closed_deals: "EasyBroker (cerradas/referencia histórica)",
  bigquery_lookup_local_comparables: "Inventario interno (BigQuery)",
  get_avaclick_valuation: "Avaclick",
};

export type ComparableIntegrationIssue = {
  source_tool: ComparableSourceToolName;
  label: string;
  status: string;
  action: "reconnect_easybroker_web" | "configure_integration" | "retry_or_check";
  recoverable_via_reauth: boolean;
  hint: string | null;
};

/**
 * Distingue los modos de fallo de una fuente de comparables. `needs_manual_login`
 * (EasyBroker MLS) es recuperable por reconexión humana; `not_configured` requiere
 * configurar la integración; el resto se reporta como fallo genérico. Los
 * `validation_error` por faltantes mínimos (p.ej. Avaclick) NO son problemas de
 * integración y se ignoran aquí (se manejan como warnings de datos).
 */
function detectIntegrationIssue(
  toolName: ComparableSourceToolName,
  result: RecordValue | null | undefined
): ComparableIntegrationIssue | null {
  if (!isRecord(result)) return null;
  const status = cleanString(result.status);
  if (status === "validation_error") return null;
  const needsReauth = status === "needs_manual_login";
  const notConfigured = status === "not_configured" || status === "not_connected";
  const failed = result.ok === false || status === "failed";
  if (!needsReauth && !notConfigured && !failed) return null;
  const hint = cleanString(result.hint) ?? cleanString(result.error);
  if (needsReauth) {
    return {
      source_tool: toolName,
      label: SOURCE_TOOL_LABELS[toolName],
      status: "needs_manual_login",
      action: "reconnect_easybroker_web",
      recoverable_via_reauth: true,
      hint,
    };
  }
  if (notConfigured) {
    return {
      source_tool: toolName,
      label: SOURCE_TOOL_LABELS[toolName],
      status: "not_configured",
      action: "configure_integration",
      recoverable_via_reauth: false,
      hint,
    };
  }
  return {
    source_tool: toolName,
    label: SOURCE_TOOL_LABELS[toolName],
    status: status ?? "failed",
    action: "retry_or_check",
    recoverable_via_reauth: false,
    hint,
  };
}

function collectIntegrationIssues(
  toolCalls: ComparableToolCallInput[]
): ComparableIntegrationIssue[] {
  const issues: ComparableIntegrationIssue[] = [];
  for (const toolName of SOURCE_TOOL_NAMES) {
    const issue = detectIntegrationIssue(
      toolName,
      latestToolCall(toolCalls, toolName)?.result_json
    );
    if (issue) issues.push(issue);
  }
  return issues;
}

function integrationIssueWarning(issue: ComparableIntegrationIssue): string {
  if (issue.action === "reconnect_easybroker_web") {
    return `${issue.label} no devolvió resultados: la sesión web de EasyBroker requiere reconexión (login/CAPTCHA/MFA). Reconecta en Credenciales API → "Probar conexión" y reintenta; el análisis continúa con las fuentes disponibles.`;
  }
  if (issue.action === "configure_integration") {
    return `${issue.label} no está configurada${issue.hint ? `: ${issue.hint}` : "."} El análisis continúa con las fuentes disponibles.`;
  }
  return `${issue.label} falló${issue.hint ? `: ${issue.hint}` : "."} El análisis continúa con las fuentes disponibles.`;
}

export type ComparableSourceConflict = {
  market_price_per_m2: number;
  avaclick_price_per_m2: number;
  ratio: number;
  divergence_pct: number;
  severity: "warn" | "high";
  detail: string;
};

/** Umbral de divergencia (±%) entre señales comparables y Avaclick. */
const SOURCE_CONFLICT_DIVERGENCE_PCT = 30;
const SOURCE_CONFLICT_HIGH_DIVERGENCE_PCT = 60;

export type ComparablesAnalysisBuildOptions = {
  /** Superficie del inmueble sujeto (m²) para total implícito en alertas. */
  subject_area_m2?: number | null;
};

/** Superficie confiable del sujeto para pricing y alertas de divergencia. */
export function resolveSubjectAreaM2FromPropertyData(
  propertyData: RecordValue | null | undefined
): number | null {
  if (!isRecord(propertyData)) return null;
  for (const key of [
    "area_construida_m2",
    "construction_area_m2",
    "built_area_m2",
    "area_total_m2",
  ] as const) {
    const value = numberOrNull(propertyData[key]);
    if (positiveNumber(value)) return value;
  }
  return null;
}

function resolvePrimaryComparableSourceLabel(params: {
  activeUsableCount: number;
  historicalUsableCount: number;
  internalUsableCount: number;
}): string {
  const { activeUsableCount, historicalUsableCount, internalUsableCount } = params;
  if (
    activeUsableCount >= historicalUsableCount &&
    activeUsableCount >= internalUsableCount &&
    activeUsableCount > 0
  ) {
    return "EasyBroker MLS (activas/publicadas)";
  }
  if (historicalUsableCount >= internalUsableCount && historicalUsableCount > 0) {
    return "EasyBroker MLS (cerradas/histórico)";
  }
  if (internalUsableCount > 0) {
    return "Ungga / BigQuery";
  }
  return "comparables consultados";
}

function formatMxnRounded(value: number): string {
  return `$${Math.round(value).toLocaleString("es-MX")}`;
}

/**
 * Detecta discrepancia material entre la señal comparable principal
 * (EasyBroker/Ungga) y Avaclick, comparando peras con peras:
 * - precio/m² mediano vs rango/m² Avaclick
 * - total implícito del sujeto (mediana/m² × m² del caso) vs promedio Avaclick
 */
function detectSourceConflict(params: {
  marketPricePerM2P50: number | null;
  subjectAreaM2: number | null;
  avaclick: RecordValue | null;
  primaryMarketSourceLabel: string;
}): ComparableSourceConflict | null {
  const market = params.marketPricePerM2P50;
  const ava = params.avaclick;
  if (!isRecord(ava)) return null;

  const divergences: Array<{ pct: number; detail: string }> = [];
  const sourceLabel = params.primaryMarketSourceLabel;

  if (positiveNumber(market)) {
    const avaMin = numberOrNull(ava.price_per_m2_min_mxn);
    const avaMax = numberOrNull(ava.price_per_m2_max_mxn);
    const avaCandidates = [avaMin, avaMax].filter((v): v is number => positiveNumber(v));
    if (avaCandidates.length > 0) {
      const avaMid =
        avaCandidates.reduce((sum, value) => sum + value, 0) / avaCandidates.length;
      if (positiveNumber(avaMid)) {
        const ratio = market / avaMid;
        const divergencePct = Math.round(Math.abs(ratio - 1) * 100);
        if (divergencePct >= SOURCE_CONFLICT_DIVERGENCE_PCT) {
          divergences.push({
            pct: divergencePct,
            detail:
              `La mediana por m² de ${sourceLabel} (~${Math.round(market).toLocaleString("es-MX")}/m²) ` +
              `difiere ${divergencePct}% de Avaclick (~${Math.round(avaMid).toLocaleString("es-MX")}/m²).`,
          });
        }
      }
    }
  }

  const avaclickAvg = numberOrNull(ava.sale_average_mxn);
  const subjectArea = params.subjectAreaM2;
  const impliedSubjectTotal =
    positiveNumber(market) && positiveNumber(subjectArea)
      ? Math.round(market * subjectArea)
      : null;
  if (positiveNumber(avaclickAvg) && positiveNumber(impliedSubjectTotal)) {
    const totalDivergencePct = Math.round(
      (Math.abs(impliedSubjectTotal - avaclickAvg) /
        Math.max(impliedSubjectTotal, avaclickAvg)) *
        100
    );
    if (totalDivergencePct >= SOURCE_CONFLICT_DIVERGENCE_PCT) {
      divergences.push({
        pct: totalDivergencePct,
        detail:
          `El total implícito para este inmueble según ${sourceLabel} (${formatMxnRounded(impliedSubjectTotal)}) ` +
          `difiere ${totalDivergencePct}% del promedio Avaclick (${formatMxnRounded(avaclickAvg)}).`,
      });
    }
  }

  if (divergences.length === 0) return null;

  const worst = divergences.reduce((max, item) => (item.pct > max.pct ? item : max), divergences[0]!);
  const severity: "warn" | "high" =
    worst.pct >= SOURCE_CONFLICT_HIGH_DIVERGENCE_PCT ? "high" : "warn";
  const avaMin = numberOrNull(ava.price_per_m2_min_mxn);
  const avaMax = numberOrNull(ava.price_per_m2_max_mxn);
  const avaMidPpm2 =
    [avaMin, avaMax].filter((v): v is number => positiveNumber(v)).length > 0
      ? [avaMin, avaMax]
          .filter((v): v is number => positiveNumber(v))
          .reduce((sum, value) => sum + value, 0) /
        [avaMin, avaMax].filter((v): v is number => positiveNumber(v)).length
      : null;

  return {
    market_price_per_m2: positiveNumber(market) ? Math.round(market) : 0,
    avaclick_price_per_m2: positiveNumber(avaMidPpm2) ? Math.round(avaMidPpm2) : 0,
    ratio:
      positiveNumber(market) && positiveNumber(avaMidPpm2)
        ? Math.round((market / avaMidPpm2) * 100) / 100
        : 0,
    divergence_pct: worst.pct,
    severity,
    detail: `${worst.detail} Revisar supuestos antes de fijar precio.`,
  };
}

export function buildComparablesAnalysisFromToolCalls(
  toolCalls: ComparableToolCallInput[],
  options?: ComparablesAnalysisBuildOptions
) {
  const activeCall = latestExecutedToolCall(toolCalls, "easybroker_search_listings");
  const historicalCall = latestExecutedToolCall(toolCalls, "easybroker_search_closed_deals");
  const bqCall = latestExecutedToolCall(toolCalls, "bigquery_lookup_local_comparables");
  const avaclickCall = latestToolCall(toolCalls, "get_avaclick_valuation");

  const active = resultArray(activeCall?.result_json, "results").map((row) =>
    normalizeEasyBrokerRow(row, "easybroker_active")
  );
  const historicalRaw = resultArray(historicalCall?.result_json, "results").map((row) =>
    normalizeEasyBrokerRow(row, "easybroker_historical")
  );
  const internal = resultArray(bqCall?.result_json, "rows").map(normalizeBigQueryRow);
  const avaclickOutcome = normalizeAvaclickValuation(avaclickCall?.result_json);
  const avaclickValuation = avaclickOutcome.valuation;

  const activeKeys = new Set(active.map(canonicalComparableKey));
  const historical = historicalRaw.filter(
    (row) => !activeKeys.has(canonicalComparableKey(row))
  );
  const duplicateHistoricalCount = historicalRaw.length - historical.length;
  const allRows = [...active, ...historical, ...internal];
  const deduped = dedupeComparableRows(allRows);
  const usableRows = deduped.rows.filter((row) => row.usable_as_comparable);
  const incompleteCount = deduped.rows.length - usableRows.length;
  const uniqueUsableRows = uniqueUsableComparables(deduped.rows);
  const uniqueComparableCount = uniqueUsableRows.length;
  const crossSourceDuplicates = usableRows.length - uniqueComparableCount;
  const uniquePricePerM2Stats = pricePerM2Stats(uniqueUsableRows);
  const activeUsableCount = active.filter((row) => row.usable_as_comparable).length;
  const historicalUsableCount = historical.filter((row) => row.usable_as_comparable).length;
  const internalUsableCount = internal.filter((row) => row.usable_as_comparable).length;
  const primaryMarketSourceLabel = resolvePrimaryComparableSourceLabel({
    activeUsableCount,
    historicalUsableCount,
    internalUsableCount,
  });
  const rawSubjectArea = options?.subject_area_m2 ?? null;
  const subjectAreaM2 = positiveNumber(rawSubjectArea) ? rawSubjectArea : null;
  const sourceConflict = detectSourceConflict({
    marketPricePerM2P50: uniquePricePerM2Stats.p50,
    subjectAreaM2,
    avaclick: avaclickValuation,
    primaryMarketSourceLabel,
  });
  const warnings: string[] = [];
  let propertyDataUntrusted = false;
  const invalidFiltersDetected = toolCalls.some((call) => {
    if (!isRecord(call.result_json)) return false;
    const status = cleanString(call.result_json.status);
    const error = cleanString(call.result_json.error);
    return status === "validation_error" && error === "invalid_comparable_filters";
  });
  const missingRequiredSourceDetected = toolCalls.some((call) => {
    if (!isRecord(call.result_json)) return false;
    const error = cleanString(call.result_json.error);
    return (
      error === "missing_required_comparable_source" ||
      error === "avaclick_required_before_persist"
    );
  });
  const fallbackModeradoAttempted = toolCalls.some((call) => {
    if (!isRecord(call.result_json)) return false;
    return isRecord(call.result_json.search_attempts);
  });

  if (!activeCall) warnings.push("No se ejecutó easybroker_search_listings en este turno.");
  if (!historicalCall) warnings.push("No se ejecutó easybroker_search_closed_deals en este turno.");
  if (!bqCall) warnings.push("No se ejecutó bigquery_lookup_local_comparables en este turno.");
  if (!avaclickCall) warnings.push("No se ejecutó get_avaclick_valuation en este turno.");
  if (active.length === 0) warnings.push("No se encontraron propiedades activas usables en EasyBroker.");
  if (historical.length === 0) warnings.push("No se encontraron referencias históricas únicas en EasyBroker.");
  if (internal.length === 0) warnings.push("No se encontraron registros en el inventario interno.");
  if (avaclickCall && !avaclickValuation) {
    warnings.push(
      avaclickOutcome.failure_warning ??
        "La valoración Avaclick no estuvo disponible o no fue exitosa; el análisis continúa con EasyBroker/BigQuery."
    );
    if ((avaclickOutcome.failure_warning ?? "").includes("construction_area_m2")) {
      propertyDataUntrusted = true;
      warnings.push(
        "La superficie construida usada para valoración parece incompleta o no confiable; validar property_data antes de decidir precio."
      );
    }
  }
  if (invalidFiltersDetected) {
    warnings.push(
      "La búsqueda de comparables tuvo filtros inválidos; reintenta con filtros canónicos antes de concluir insuficiencia de mercado."
    );
  }
  if (missingRequiredSourceDetected) {
    warnings.push(
      "Faltó una fuente obligatoria de comparables para este tipo de inmueble (Avaclick)."
    );
  }
  if (fallbackModeradoAttempted && usableRows.length === 0) {
    warnings.push(
      "Se agotó fallback moderado de búsqueda (área expandida y relajación de exactitud) sin obtener comparables usables."
    );
  }
  if (duplicateHistoricalCount > 0) {
    warnings.push(
      `${duplicateHistoricalCount} resultado(s) de EasyBroker cerradas ya estaban presentes en activas y se deduplicaron.`
    );
  }
  if (deduped.duplicates > 0) {
    warnings.push(`${deduped.duplicates} comparable(s) duplicados adicionales se omitieron.`);
  }
  if (crossSourceDuplicates > 0) {
    warnings.push(
      `${crossSourceDuplicates} comparable(s) usables aparecían en más de una fuente y se contaron una sola vez.`
    );
  }
  if (
    uniqueComparableCount > 0 &&
    uniqueComparableCount < MIN_DEFENSIBLE_UNIQUE_COMPARABLES
  ) {
    warnings.push(
      `Muestra insuficiente: solo ${uniqueComparableCount} comparable(s) único(s) (mínimo defendible: ${MIN_DEFENSIBLE_UNIQUE_COMPARABLES}). Ampliar criterios o pedir decisión al asesor.`
    );
  } else if (uniqueComparableCount === MIN_DEFENSIBLE_UNIQUE_COMPARABLES) {
    warnings.push(
      `Muestra en el mínimo defendible (${MIN_DEFENSIBLE_UNIQUE_COMPARABLES} comparables únicos); el rango de precio tiene mayor incertidumbre.`
    );
  }
  if (sourceConflict) {
    warnings.push(sourceConflict.detail);
  }

  const integrationIssues = collectIntegrationIssues(toolCalls);
  const needsUserReauth = integrationIssues.some(
    (issue) => issue.recoverable_via_reauth
  );
  for (const issue of integrationIssues) {
    warnings.push(integrationIssueWarning(issue));
  }

  const searchValidity = classifyComparableSearchOutcome({
    usable_count: usableRows.length,
    search_validity: invalidFiltersDetected ? "invalid_filters" : "valid",
    property_data_untrusted: propertyDataUntrusted,
    missing_required_source: missingRequiredSourceDetected,
  });

  const analysis = {
    filters_used: filtersFromCalls(toolCalls),
    active_listings: active,
    historical_references: historical,
    internal_inventory: internal,
    external_valuation: avaclickValuation,
    stats: {
      active_count: active.filter((row) => row.usable_as_comparable).length,
      historical_reference_count: historical.filter((row) => row.usable_as_comparable).length,
      internal_inventory_count: internal.filter((row) => row.usable_as_comparable).length,
      price: priceStats(deduped.rows),
      price_per_m2: pricePerM2Stats(deduped.rows),
    },
    data_quality: {
      usable_count: usableRows.length,
      unique_comparable_count: uniqueComparableCount,
      min_defensible_unique_comparables: MIN_DEFENSIBLE_UNIQUE_COMPARABLES,
      at_minimum_sample: uniqueComparableCount === MIN_DEFENSIBLE_UNIQUE_COMPARABLES,
      cross_source_duplicates: crossSourceDuplicates,
      incomplete_count: incompleteCount,
      source_conflict: sourceConflict,
      warnings,
      integration_issues: integrationIssues,
      needs_user_reauth: needsUserReauth,
      property_data_untrusted: propertyDataUntrusted,
      search_validity: searchValidity,
    },
    notes:
      searchValidity === "valid"
        ? "Análisis construido determinísticamente desde resultados de tools del turno."
        : searchValidity === "invalid_filters"
          ? "La búsqueda fue inválida por filtros (no refleja insuficiencia real de mercado). Reintenta con filtros saneados/canónicos."
          : searchValidity === "missing_required_source"
            ? "Faltó una fuente obligatoria aplicable (Avaclick) para cerrar un análisis defendible."
            : searchValidity === "property_data_untrusted"
              ? "No se logró una muestra defendible y se detectaron señales de datos base no confiables (superficie construida). Confirmar/corregir property_data antes de ampliar criterios."
              : "La búsqueda fue válida pero no hubo comparables suficientes en las fuentes consultadas.",
  };

  return analysis;
}

/** Escenario N4: sin comparables usables — no avanzar a precio. */
export const COMPARABLES_INSUFFICIENT_N4_SCENARIO_ID =
  "comparables_in_progress_insufficient_data";

export function isComparablesInsufficientN4TestContext(
  context: unknown
): boolean {
  return (
    isRecord(context) &&
    context.skill_test_n4_seed === COMPARABLES_INSUFFICIENT_N4_SCENARIO_ID
  );
}

/**
 * En casos de prueba del escenario «insuficientes», normaliza el análisis a 0 usables
 * aunque EasyBroker devuelva filas, para que N4 sea determinista.
 */
export function normalizeComparablesAnalysisForInsufficientN4Test(
  analysis: RecordValue,
  context: unknown
): RecordValue {
  if (!isComparablesInsufficientN4TestContext(context)) return analysis;

  const markNonUsable = (row: RecordValue) => ({
    ...row,
    usable_as_comparable: false,
    quality_reasons: Array.isArray(row.quality_reasons)
      ? [
          ...row.quality_reasons.filter((item): item is string => typeof item === "string"),
          "n4_insufficient_scenario_test",
        ]
      : ["n4_insufficient_scenario_test"],
  });

  const active = Array.isArray(analysis.active_listings)
    ? analysis.active_listings.filter(isRecord).map(markNonUsable)
    : [];
  const historical = Array.isArray(analysis.historical_references)
    ? analysis.historical_references.filter(isRecord).map(markNonUsable)
    : [];
  const internal = Array.isArray(analysis.internal_inventory)
    ? analysis.internal_inventory.filter(isRecord).map(markNonUsable)
    : [];
  const dq = isRecord(analysis.data_quality) ? analysis.data_quality : null;
  const warnings = Array.isArray(dq?.warnings)
    ? dq.warnings.filter((item): item is string => typeof item === "string")
    : [];
  const testWarning =
    "Escenario N4 «sin comparables usables»: resultados de búsqueda normalizados a 0 usables para validación determinística.";
  const mergedWarnings = warnings.includes(testWarning)
    ? warnings
    : [...warnings, testWarning];

  return {
    ...analysis,
    active_listings: active,
    historical_references: historical,
    internal_inventory: internal,
    stats: {
      ...(isRecord(analysis.stats) ? analysis.stats : {}),
      active_count: 0,
      historical_reference_count: 0,
      internal_inventory_count: 0,
      price: {
        p25: null,
        p50: null,
        p75: null,
        sample_size: 0,
        available: false,
      },
      price_per_m2: { available: false, sample_size: 0 },
    },
    data_quality: {
      ...(isRecord(analysis.data_quality) ? analysis.data_quality : {}),
      usable_count: 0,
      unique_comparable_count: 0,
      at_minimum_sample: false,
      cross_source_duplicates: 0,
      source_conflict: null,
      incomplete_count:
        active.length + historical.length + internal.length,
      warnings: mergedWarnings,
    },
    notes:
      "N4 datos insuficientes: 0 comparables usables tras normalización de prueba (no avanzar a precio).",
  };
}

export function comparablesUsableCount(analysis: unknown): number {
  if (!isRecord(analysis)) return 0;
  const dq = isRecord(analysis.data_quality) ? analysis.data_quality : null;
  if (positiveNumber(dq?.usable_count)) return dq.usable_count;
  const stats = isRecord(analysis.stats) ? analysis.stats : null;
  const price = isRecord(stats?.price) ? stats.price : null;
  if (positiveNumber(price?.sample_size)) return price.sample_size;
  return 0;
}

/**
 * Comparables ÚNICOS (cross-source) usables. Para artefactos nuevos lee
 * `data_quality.unique_comparable_count`; para artefactos antiguos sin ese campo
 * cae a `usable_count` para no romper compatibilidad.
 */
export function comparablesUniqueCount(analysis: unknown): number {
  if (!isRecord(analysis)) return 0;
  const dq = isRecord(analysis.data_quality) ? analysis.data_quality : null;
  if (dq && typeof dq.unique_comparable_count === "number") {
    return Math.max(0, dq.unique_comparable_count);
  }
  return comparablesUsableCount(analysis);
}

/**
 * Muestra defendible = al menos `MIN_DEFENSIBLE_UNIQUE_COMPARABLES` comparables
 * únicos (cross-source). Avaclick es una valoración, no un comparable, y no
 * cuenta para este umbral.
 */
export function comparablesHasDefensibleSample(analysis: unknown): boolean {
  return comparablesUniqueCount(analysis) >= MIN_DEFENSIBLE_UNIQUE_COMPARABLES;
}

export function validateComparablesAnalysisArtifact(value: unknown) {
  const errors: string[] = [];
  if (!isRecord(value)) return ["comparables_analysis debe ser un objeto."];
  if (!isRecord(value.filters_used)) errors.push("comparables_analysis.filters_used es obligatorio.");
  if (!isRecord(value.stats)) errors.push("comparables_analysis.stats es obligatorio.");
  if (!isRecord(value.data_quality)) {
    errors.push("comparables_analysis.data_quality es obligatorio.");
  }
  return errors;
}

export function validateComparablesCaseOutcome(params: {
  comparables_analysis: unknown;
  current_step: string;
  status: string;
  notify_user_executed: boolean;
}) {
  const artifactErrors = validateComparablesAnalysisArtifact(params.comparables_analysis);
  const defensible = comparablesHasDefensibleSample(params.comparables_analysis);
  const usable_count = comparablesUsableCount(params.comparables_analysis);
  const dq = isRecord(params.comparables_analysis)
    ? (isRecord(params.comparables_analysis.data_quality)
        ? params.comparables_analysis.data_quality
        : null)
    : null;
  const searchValidity =
    typeof dq?.search_validity === "string" ? dq.search_validity : "valid";
  const errors = [...artifactErrors];

  if (defensible) {
    if (params.current_step !== "price_proposal_pending") {
      errors.push("Con comparables usables el caso debe avanzar a current_step=price_proposal_pending.");
    }
    if (params.status !== "active" && params.status !== "waiting_internal") {
      errors.push("Con comparables usables se espera status=active (o waiting_internal si hay HITL de precio).");
    }
  } else {
    if (params.current_step === "price_proposal_pending") {
      errors.push("Sin comparables usables (todas las fuentes) no debe avanzar a price_proposal_pending.");
    }
    if (params.current_step !== "comparables_in_progress") {
      errors.push("Sin comparables usables el caso debe permanecer en comparables_in_progress.");
    }
    if (params.status !== "waiting_internal") {
      errors.push("Sin comparables usables se espera status=waiting_internal (asesor debe ampliar criterios).");
    }
    if (searchValidity !== "invalid_filters" && !params.notify_user_executed) {
      errors.push("Sin comparables usables debe ejecutarse notify_user al asesor con filtros y sugerencias.");
    }
  }

  return { defensible, usable_count, errors };
}

