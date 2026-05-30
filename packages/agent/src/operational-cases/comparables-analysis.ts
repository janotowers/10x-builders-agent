type RecordValue = Record<string, unknown>;

const SOURCE_TOOL_NAMES = [
  "easybroker_search_listings",
  "easybroker_search_closed_deals",
  "bigquery_lookup_local_comparables",
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

function resultArray(result: RecordValue | null | undefined, key: "results" | "rows") {
  const value = result?.[key];
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function comparableKey(row: ComparableRow) {
  if (row.id) return `${row.source}:${row.id}`;
  return `${row.source}:${row.url ?? ""}:${row.title ?? ""}:${row.price ?? ""}:${row.area_m2 ?? ""}`;
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

export function buildComparablesAnalysisFromToolCalls(
  toolCalls: ComparableToolCallInput[]
) {
  const activeCall = latestExecutedToolCall(toolCalls, "easybroker_search_listings");
  const historicalCall = latestExecutedToolCall(toolCalls, "easybroker_search_closed_deals");
  const bqCall = latestExecutedToolCall(toolCalls, "bigquery_lookup_local_comparables");

  const active = resultArray(activeCall?.result_json, "results").map((row) =>
    normalizeEasyBrokerRow(row, "easybroker_active")
  );
  const historicalRaw = resultArray(historicalCall?.result_json, "results").map((row) =>
    normalizeEasyBrokerRow(row, "easybroker_historical")
  );
  const internal = resultArray(bqCall?.result_json, "rows").map(normalizeBigQueryRow);

  const activeKeys = new Set(active.map(comparableKey));
  const historical = historicalRaw.filter((row) => !activeKeys.has(comparableKey(row)));
  const duplicateHistoricalCount = historicalRaw.length - historical.length;
  const allRows = [...active, ...historical, ...internal];
  const deduped = dedupeComparableRows(allRows);
  const usableRows = deduped.rows.filter((row) => row.usable_as_comparable);
  const incompleteCount = deduped.rows.length - usableRows.length;
  const warnings: string[] = [];

  if (!activeCall) warnings.push("No se ejecutó easybroker_search_listings en este turno.");
  if (!historicalCall) warnings.push("No se ejecutó easybroker_search_closed_deals en este turno.");
  if (!bqCall) warnings.push("No se ejecutó bigquery_lookup_local_comparables en este turno.");
  if (active.length === 0) warnings.push("No se encontraron propiedades activas usables en EasyBroker.");
  if (historical.length === 0) warnings.push("No se encontraron referencias históricas únicas en EasyBroker.");
  if (internal.length === 0) warnings.push("No se encontraron registros en el inventario interno.");
  if (duplicateHistoricalCount > 0) {
    warnings.push(
      `${duplicateHistoricalCount} resultado(s) de EasyBroker cerradas ya estaban presentes en activas y se deduplicaron.`
    );
  }
  if (deduped.duplicates > 0) {
    warnings.push(`${deduped.duplicates} comparable(s) duplicados adicionales se omitieron.`);
  }

  const analysis = {
    filters_used: filtersFromCalls(toolCalls),
    active_listings: active,
    historical_references: historical,
    internal_inventory: internal,
    stats: {
      active_count: active.filter((row) => row.usable_as_comparable).length,
      historical_reference_count: historical.filter((row) => row.usable_as_comparable).length,
      internal_inventory_count: internal.filter((row) => row.usable_as_comparable).length,
      price: priceStats(deduped.rows),
      price_per_m2: pricePerM2Stats(deduped.rows),
    },
    data_quality: {
      usable_count: usableRows.length,
      incomplete_count: incompleteCount,
      warnings,
    },
    notes:
      usableRows.length > 0
        ? "Análisis construido determinísticamente desde resultados de tools del turno."
        : "No se encontraron comparables usables en ninguna fuente; se requiere ampliar criterios.",
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

export function comparablesHasDefensibleSample(analysis: unknown): boolean {
  return comparablesUsableCount(analysis) > 0;
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
    if (!params.notify_user_executed) {
      errors.push("Sin comparables usables debe ejecutarse notify_user al asesor con filtros y sugerencias.");
    }
  }

  return { defensible, usable_count, errors };
}

