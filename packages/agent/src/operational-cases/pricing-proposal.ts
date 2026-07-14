import type { ComparableSourceConflict } from "./comparables-analysis";

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function positiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function percentileNearestRank(
  sortedValues: number[],
  percentile: number
): number | null {
  if (sortedValues.length === 0) return null;
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(percentile * sortedValues.length) - 1)
  );
  return sortedValues[index];
}

function roundPrice(value: number): number {
  // Redondea a miles para precios "limpios" de salida/ideal/mínimo.
  if (value >= 100000) return Math.round(value / 1000) * 1000;
  if (value >= 1000) return Math.round(value / 100) * 100;
  return Math.round(value);
}

const SOURCE_LABELS: Record<string, string> = {
  easybroker_active: "EasyBroker (activas/publicadas)",
  easybroker_historical: "EasyBroker (cerradas/histórico)",
  bigquery_internal_inventory: "Inventario interno (BigQuery)",
  avaclick: "Avaclick (opinión digital)",
};
const CORE_MARKET_SOURCES = [
  "easybroker_active",
  "easybroker_historical",
  "bigquery_internal_inventory",
] as const;

export type PricingProposalPerSource = {
  source: string;
  label: string;
  sample_size: number;
  price_per_m2_p25: number | null;
  price_per_m2_p50: number | null;
  price_per_m2_p75: number | null;
  total_p25: number | null;
  total_p50: number | null;
  total_p75: number | null;
  implied_total_from_ppm2: number | null;
  // Solo Avaclick:
  sale_average_mxn?: number | null;
  sale_min_mxn?: number | null;
  sale_max_mxn?: number | null;
  price_per_m2_min_mxn?: number | null;
  price_per_m2_max_mxn?: number | null;
  pdf_url?: string | null;
  note?: string;
};

export type PricingProposal = {
  currency: "MXN";
  minimo: number;
  ideal: number;
  salida: number;
  basis: "price_per_m2" | "total_price" | "avaclick_only";
  subject_area_m2: number | null;
  area_basis: "construction" | "total" | null;
  consolidated: {
    price_per_m2_p25: number | null;
    price_per_m2_p50: number | null;
    price_per_m2_p75: number | null;
    market_total_p50: number | null;
    avaclick_total_mid: number | null;
    source_conflict: ComparableSourceConflict | null;
  };
  per_source: PricingProposalPerSource[];
  comparables_used: string[];
  rationale: string;
  approval_status: "pending";
  generated_by: "deterministic_post_agent_invariant";
  generated_at: string;
};

type NormalizedComparable = {
  source: string;
  id: string | null;
  price: number | null;
  price_per_m2: number | null;
  usable: boolean;
};

function normalizeRow(value: unknown): NormalizedComparable | null {
  if (!isRecord(value)) return null;
  const source =
    typeof value.source === "string" && value.source.trim()
      ? value.source.trim()
      : "unknown";
  return {
    source,
    id: typeof value.id === "string" && value.id.trim() ? value.id.trim() : null,
    price: numberOrNull(value.price),
    price_per_m2: numberOrNull(value.price_per_m2),
    usable: value.usable_as_comparable === true,
  };
}

function collectRows(analysis: RecordValue): NormalizedComparable[] {
  const keys = ["active_listings", "historical_references", "internal_inventory"];
  const rows: NormalizedComparable[] = [];
  for (const key of keys) {
    const arr = analysis[key];
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      const row = normalizeRow(item);
      if (row) rows.push(row);
    }
  }
  return rows;
}

function statsFor(
  rows: NormalizedComparable[],
  pick: (row: NormalizedComparable) => number | null
) {
  const values = rows
    .map(pick)
    .filter((v): v is number => positiveNumber(v))
    .sort((a, b) => a - b);
  return {
    p25: percentileNearestRank(values, 0.25),
    p50: percentileNearestRank(values, 0.5),
    p75: percentileNearestRank(values, 0.75),
    sample_size: values.length,
  };
}

function perSourceBreakdown(
  rows: NormalizedComparable[],
  subjectAreaM2: number | null,
  integrationIssues: Array<RecordValue>
): PricingProposalPerSource[] {
  const out: PricingProposalPerSource[] = [];
  const knownSources = new Set(CORE_MARKET_SOURCES);
  const unknownSources = Array.from(
    new Set(
      rows
        .filter((row) => row.usable && !knownSources.has(row.source as (typeof CORE_MARKET_SOURCES)[number]))
        .map((row) => row.source)
    )
  );
  const orderedSources = [...CORE_MARKET_SOURCES, ...unknownSources];
  for (const source of orderedSources) {
    const list = rows.filter((row) => row.usable && row.source === source);
    const ppm2 = statsFor(list, (r) => r.price_per_m2);
    const total = statsFor(list, (r) => r.price);
    const emptySourceNote =
      list.length > 0
        ? undefined
        : source === "easybroker_historical"
          ? "Sin referencias históricas únicas adicionales."
          : source === "bigquery_internal_inventory"
            ? "Sin inventario interno comparable en Ungga/BigQuery."
            : source === "easybroker_active"
              ? "Sin comparables activos usables en EasyBroker."
              : "Sin comparables usables en esta fuente.";
    const integrationNote =
      source === "easybroker_active"
        ? integrationIssueNoteForSource(
            integrationIssues,
            "easybroker_search_listings"
          )
        : source === "easybroker_historical"
          ? integrationIssueNoteForSource(
              integrationIssues,
              "easybroker_search_closed_deals"
            )
          : source === "bigquery_internal_inventory"
            ? integrationIssueNoteForSource(
                integrationIssues,
                "bigquery_lookup_local_comparables"
              )
            : undefined;
    const sourceNote = integrationNote ?? emptySourceNote;
    out.push({
      source,
      label: SOURCE_LABELS[source] ?? source,
      sample_size: list.length,
      price_per_m2_p25: ppm2.p25,
      price_per_m2_p50: ppm2.p50,
      price_per_m2_p75: ppm2.p75,
      total_p25: total.p25,
      total_p50: total.p50,
      total_p75: total.p75,
      implied_total_from_ppm2:
        positiveNumber(ppm2.p50) && positiveNumber(subjectAreaM2)
          ? roundPrice(ppm2.p50 * subjectAreaM2)
          : null,
      ...(sourceNote ? { note: sourceNote } : {}),
    });
  }
  return out;
}

function integrationIssueNoteForSource(
  integrationIssues: Array<RecordValue>,
  sourceTool: string
): string | undefined {
  const issue = integrationIssues.find(
    (item) => item.source_tool === sourceTool
  );
  if (!issue) return undefined;
  const status = typeof issue.status === "string" ? issue.status : "";
  const hint = typeof issue.hint === "string" ? issue.hint : "";
  if (status === "session_refreshed_retry_recommended") {
    return "Esta fuente falló por sesión en un intento previo, pero la sesión se refrescó en este turno. Reintenta para recuperar cobertura completa.";
  }
  if (status === "needs_manual_login") {
    return "No se pudo consultar esta fuente por sesión/login de EasyBroker. Reconecta EasyBroker MLS y vuelve a intentar.";
  }
  if (status === "not_configured") {
    return hint ? `Fuente no configurada: ${hint}` : "Fuente no configurada.";
  }
  return hint ? `Fuente no disponible: ${hint}` : "Fuente no disponible en este turno.";
}

function avaclickPerSource(avaclick: RecordValue): PricingProposalPerSource {
  return {
    source: "avaclick",
    label: SOURCE_LABELS.avaclick,
    sample_size: 1,
    price_per_m2_p25: null,
    price_per_m2_p50: null,
    price_per_m2_p75: null,
    total_p25: numberOrNull(avaclick.sale_min_mxn),
    total_p50: numberOrNull(avaclick.sale_average_mxn),
    total_p75: numberOrNull(avaclick.sale_max_mxn),
    implied_total_from_ppm2: null,
    sale_average_mxn: numberOrNull(avaclick.sale_average_mxn),
    sale_min_mxn: numberOrNull(avaclick.sale_min_mxn),
    sale_max_mxn: numberOrNull(avaclick.sale_max_mxn),
    price_per_m2_min_mxn: numberOrNull(avaclick.price_per_m2_min_mxn),
    price_per_m2_max_mxn: numberOrNull(avaclick.price_per_m2_max_mxn),
    pdf_url:
      typeof avaclick.pdf_url === "string" && avaclick.pdf_url.trim()
        ? avaclick.pdf_url.trim()
        : null,
    note: "Opinión digital de valor (no avalúo legal/fiscal/bancario).",
  };
}

function clampOrder(minimo: number, ideal: number, salida: number) {
  const sorted = [minimo, ideal, salida].sort((a, b) => a - b);
  return { minimo: sorted[0], ideal: sorted[1], salida: sorted[2] };
}

/**
 * Construye una propuesta de precio estructurada (mínimo/ideal/salida) a partir
 * del `comparables_analysis`, mostrando el desglose por fuente (EasyBroker
 * activas/cerradas, BigQuery, Avaclick) y una recomendación consolidada.
 *
 * Regla de negocio: el ancla es el mercado (comparables, ≥3 únicos). El precio
 * por m² mediano por el área del inmueble es la base preferida; si no hay precio
 * por m² suficiente, se usan precios totales. Avaclick se reporta por separado y
 * se reconcilia: si difiere materialmente del mercado, se ensancha el rango y se
 * deja una nota explícita en vez de elegir ciegamente una fuente.
 */
export function buildPricingProposalFromComparables(params: {
  analysis: unknown;
  subjectAreaM2?: number | null;
  areaBasis?: "construction" | "total" | null;
  preferAvaclickPrimary?: boolean;
}): PricingProposal | null {
  const analysis = params.analysis;
  if (!isRecord(analysis)) return null;
  const subjectAreaM2 = positiveNumber(params.subjectAreaM2)
    ? params.subjectAreaM2
    : null;

  const rows = collectRows(analysis);
  const usableRows = rows.filter((row) => row.usable);
  const avaclick = isRecord(analysis.external_valuation)
    ? analysis.external_valuation
    : null;

  const dataQuality = isRecord(analysis.data_quality) ? analysis.data_quality : null;
  const sourceConflict =
    dataQuality && isRecord(dataQuality.source_conflict)
      ? (dataQuality.source_conflict as unknown as ComparableSourceConflict)
      : null;

  const marketPpm2 = statsFor(usableRows, (r) => r.price_per_m2);
  const marketTotal = statsFor(usableRows, (r) => r.price);

  const integrationIssues =
    dataQuality && Array.isArray(dataQuality.integration_issues)
      ? dataQuality.integration_issues.filter(isRecord)
      : [];
  const perSource = perSourceBreakdown(rows, subjectAreaM2, integrationIssues);
  if (avaclick) perSource.push(avaclickPerSource(avaclick));

  const seenComparableIds = new Set<string>();
  const comparablesUsed = usableRows
    .map((row) => row.id)
    .filter((id): id is string => {
      if (!id) return false;
      if (seenComparableIds.has(id)) return false;
      seenComparableIds.add(id);
      return true;
    })
    .slice(0, 12);

  const avaclickAvg = avaclick ? numberOrNull(avaclick.sale_average_mxn) : null;
  const avaclickMin = avaclick ? numberOrNull(avaclick.sale_min_mxn) : null;
  const avaclickMax = avaclick ? numberOrNull(avaclick.sale_max_mxn) : null;

  let minimo: number | null = null;
  let ideal: number | null = null;
  let salida: number | null = null;
  let basis: PricingProposal["basis"];

  const preferAvaclickPrimary =
    params.preferAvaclickPrimary === true && positiveNumber(avaclickAvg);

  if (preferAvaclickPrimary) {
    basis = "avaclick_only";
    minimo = positiveNumber(avaclickMin) ? avaclickMin : (avaclickAvg as number) * 0.92;
    ideal = avaclickAvg as number;
    salida = positiveNumber(avaclickMax) ? avaclickMax : (avaclickAvg as number) * 1.06;
  } else if (
    positiveNumber(marketPpm2.p50) &&
    positiveNumber(subjectAreaM2) &&
    marketPpm2.sample_size >= 1
  ) {
    basis = "price_per_m2";
    const p25 = positiveNumber(marketPpm2.p25) ? marketPpm2.p25 : marketPpm2.p50 * 0.92;
    const p75 = positiveNumber(marketPpm2.p75) ? marketPpm2.p75 : marketPpm2.p50 * 1.06;
    minimo = p25 * subjectAreaM2;
    ideal = marketPpm2.p50 * subjectAreaM2;
    salida = p75 * subjectAreaM2;
  } else if (positiveNumber(marketTotal.p50)) {
    basis = "total_price";
    minimo = positiveNumber(marketTotal.p25) ? marketTotal.p25 : marketTotal.p50 * 0.92;
    ideal = marketTotal.p50;
    salida = positiveNumber(marketTotal.p75) ? marketTotal.p75 : marketTotal.p50 * 1.06;
  } else if (positiveNumber(avaclickAvg)) {
    basis = "avaclick_only";
    minimo = positiveNumber(avaclickMin) ? avaclickMin : avaclickAvg * 0.92;
    ideal = avaclickAvg;
    salida = positiveNumber(avaclickMax) ? avaclickMax : avaclickAvg * 1.06;
  } else {
    return null;
  }

  // Reconciliación con Avaclick: bajo conflicto alto, ensanchar rango para
  // reflejar honestamente la incertidumbre entre fuentes.
  if (basis !== "avaclick_only" && sourceConflict?.severity === "high") {
    if (positiveNumber(avaclickMin)) minimo = Math.min(minimo, avaclickMin);
    if (positiveNumber(avaclickMax)) salida = Math.max(salida, avaclickMax);
  }

  const ordered = clampOrder(
    roundPrice(minimo),
    roundPrice(ideal),
    roundPrice(salida)
  );

  const rationaleParts: string[] = [];
  if (basis === "price_per_m2") {
    rationaleParts.push(
      `Base: precio por m² de mercado (mediana ~${Math.round(
        marketPpm2.p50 as number
      ).toLocaleString("es-MX")}/m²) × ${subjectAreaM2} m² del inmueble.`
    );
  } else if (basis === "total_price") {
    rationaleParts.push(
      "Base: precios totales de comparables de mercado (no hubo suficiente precio por m²)."
    );
  } else {
    rationaleParts.push(
      "Base: opinión Avaclick (sin muestra de mercado suficiente); requiere validación humana."
    );
  }
  rationaleParts.push(
    `Muestra de mercado usable: ${usableRows.length} comparable(s).`
  );
  if (avaclickAvg) {
    rationaleParts.push(
      `Avaclick (referencia): venta promedio ~${Math.round(avaclickAvg).toLocaleString(
        "es-MX"
      )}.`
    );
  }
  if (sourceConflict) {
    rationaleParts.push(sourceConflict.detail);
  }

  return {
    currency: "MXN",
    minimo: ordered.minimo,
    ideal: ordered.ideal,
    salida: ordered.salida,
    basis,
    subject_area_m2: subjectAreaM2,
    area_basis: params.areaBasis ?? (subjectAreaM2 ? "construction" : null),
    consolidated: {
      price_per_m2_p25: marketPpm2.p25,
      price_per_m2_p50: marketPpm2.p50,
      price_per_m2_p75: marketPpm2.p75,
      market_total_p50: marketTotal.p50,
      avaclick_total_mid: avaclickAvg,
      source_conflict: sourceConflict,
    },
    per_source: perSource,
    comparables_used: comparablesUsed,
    rationale: rationaleParts.join(" "),
    approval_status: "pending",
    generated_by: "deterministic_post_agent_invariant",
    generated_at: new Date().toISOString(),
  };
}

function formatMxn(value: number): string {
  return `$${Math.round(value).toLocaleString("es-MX")}`;
}

function formatNumber(value: number): string {
  return Math.round(value).toLocaleString("es-MX");
}

function sourceById(
  proposal: PricingProposal,
  sourceId: string
): PricingProposalPerSource | null {
  return proposal.per_source.find((source) => source.source === sourceId) ?? null;
}

/** Texto canónico para notify_user(kind=price_approval) con propuesta concreta. */
export function formatPriceApprovalNotifyText(proposal: PricingProposal): string {
  const active = sourceById(proposal, "easybroker_active");
  const historical = sourceById(proposal, "easybroker_historical");
  const internal = sourceById(proposal, "bigquery_internal_inventory");
  const avaclick = sourceById(proposal, "avaclick");
  const activeCount = active?.sample_size ?? 0;
  const historicalCount = historical?.sample_size ?? 0;
  const internalCount = internal?.sample_size ?? 0;
  const marketPrimarySource =
    activeCount >= historicalCount && activeCount >= internalCount
      ? "EasyBroker MLS (activas/publicadas)"
      : historicalCount >= internalCount
        ? "EasyBroker MLS (cerradas/histórico)"
        : "inventario interno (Ungga/BigQuery)";
  const basisLine =
    proposal.basis === "price_per_m2"
      ? `Base principal: mediana por m² de ${marketPrimarySource} aplicada a ${proposal.subject_area_m2 ?? "N/D"} m² del inmueble.`
      : proposal.basis === "total_price"
        ? `Base principal: precios totales de ${marketPrimarySource} (sin señal suficiente de precio por m²).`
        : "Base principal: opinión Avaclick (sin muestra comparable suficiente en EasyBroker/Ungga).";
  const activeLine = active
    ? active.sample_size > 0
      ? `- EasyBroker activas/publicadas: ${active.sample_size} comparable(s) único(s). Mediana publicada: ${active.total_p50 != null ? formatMxn(active.total_p50) : "N/D"}; mediana por m²: ${active.price_per_m2_p50 != null ? `~${formatNumber(active.price_per_m2_p50)}/m²` : "N/D"}${active.implied_total_from_ppm2 != null ? `; total implícito para el inmueble: ${formatMxn(active.implied_total_from_ppm2)}.` : "."}`
      : `- EasyBroker activas/publicadas: ${active.note ?? "Sin comparables activos usables."}`
    : "- EasyBroker activas/publicadas: Sin datos disponibles.";
  const historicalLine = historical
    ? historical.sample_size > 0
      ? `- EasyBroker cerradas/histórico: ${historical.sample_size} referencia(s) histórica(s) única(s). Mediana publicada: ${historical.total_p50 != null ? formatMxn(historical.total_p50) : "N/D"}${historical.price_per_m2_p50 != null ? `; mediana por m²: ~${formatNumber(historical.price_per_m2_p50)}/m².` : "."}`
      : `- EasyBroker cerradas/histórico: ${historical.note ?? "Sin referencias históricas únicas adicionales."}`
    : "- EasyBroker cerradas/histórico: Sin datos disponibles.";
  const internalLine = internal
    ? internal.sample_size > 0
      ? `- Ungga / BigQuery: ${internal.sample_size} comparable(s) interno(s). Mediana publicada: ${internal.total_p50 != null ? formatMxn(internal.total_p50) : "N/D"}${internal.price_per_m2_p50 != null ? `; mediana por m²: ~${formatNumber(internal.price_per_m2_p50)}/m².` : "."}`
      : `- Ungga / BigQuery: ${internal.note ?? "Sin inventario interno comparable."}`
    : "- Ungga / BigQuery: Sin datos disponibles.";
  const avaclickLine = avaclick
    ? `- Avaclick (opinión digital): ${avaclick.sale_min_mxn != null && avaclick.sale_max_mxn != null ? `${formatMxn(avaclick.sale_min_mxn)}–${formatMxn(avaclick.sale_max_mxn)}` : "N/D"}${avaclick.sale_average_mxn != null ? `; promedio ~${formatMxn(avaclick.sale_average_mxn)}.` : "."} ${avaclick.note ?? "No sustituye un avalúo legal/fiscal/bancario."}`
    : "- Avaclick: Sin valuación disponible.";
  const avaclickPdfLine =
    avaclick?.pdf_url && /^https?:\/\//i.test(avaclick.pdf_url)
      ? `- PDF Avaclick: ${avaclick.pdf_url}`
      : null;
  const warningLine = proposal.consolidated.source_conflict
    ? `Advertencia: ${proposal.consolidated.source_conflict.detail}`
    : null;
  const avaclickContrastLine =
    avaclick?.sale_average_mxn != null && proposal.ideal > 0
      ? (() => {
          const avg = avaclick.sale_average_mxn;
          const divergencePct = Math.round(
            (Math.abs(proposal.ideal - avg) / Math.max(proposal.ideal, avg)) * 100
          );
          if (divergencePct <= 2) {
            return `Contraste Avaclick: el ideal sugerido (${formatMxn(proposal.ideal)}) está alineado con el promedio Avaclick (${formatMxn(avg)}).`;
          }
          const direction =
            proposal.ideal > avg ? "por encima" : "por debajo";
          return `Contraste Avaclick: el ideal sugerido (${formatMxn(proposal.ideal)}) está ~${divergencePct}% ${direction} del promedio Avaclick (${formatMxn(avg)}).`;
        })()
      : null;
  const sampleLine =
    proposal.comparables_used.length > 0
      ? `Muestra usable: ${proposal.comparables_used.length} comparable(s) único(s).`
      : null;
  const minimumSampleWarning =
    proposal.comparables_used.length === 3
      ? "Advertencia de muestra: estás en el mínimo defendible (3 comparables únicos); confirma supuestos antes de fijar precio final."
      : null;
  const avaclickDegradedLine =
    !avaclick && proposal.basis !== "avaclick_only"
      ? "Nota de integración: Avaclick no estuvo disponible en este turno; la propuesta se construyó con EasyBroker/Ungga disponibles."
      : null;
  return [
    "Propuesta de precio lista para revisión:",
    "",
    "Recomendación:",
    `- Salida (publicación): ${formatMxn(proposal.salida)}`,
    `- Ideal: ${formatMxn(proposal.ideal)}`,
    `- Mínimo: ${formatMxn(proposal.minimo)}`,
    "",
    "Lectura por fuente:",
    activeLine,
    "",
    historicalLine,
    "",
    internalLine,
    "",
    avaclickLine,
    avaclickPdfLine,
    "",
    "Criterio usado:",
    basisLine,
    sampleLine,
    avaclickContrastLine,
    minimumSampleWarning,
    avaclickDegradedLine,
    warningLine,
    "",
    "Confirma si apruebas estos valores o indícame ajustes puntuales.",
  ]
    .filter((line): line is string => line != null)
    .join("\n");
}
