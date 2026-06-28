import assert from "node:assert/strict";
import {
  buildComparablesAnalysisFromToolCalls,
  comparablesHasDefensibleSample,
  comparablesUniqueCount,
} from "./comparables-analysis";
import {
  buildPricingProposalFromComparables,
  formatPriceApprovalNotifyText,
} from "./pricing-proposal";

// --- Cross-source dedupe + defensible sample (>=3 únicos) ---
const analysis = buildComparablesAnalysisFromToolCalls([
  {
    tool_name: "easybroker_search_listings",
    status: "executed",
    result_json: {
      results: [
        { id: "A1", url: "https://eb.com/p/1", price: 3000000, area_m2: 100 },
        { id: "A2", url: "https://eb.com/p/2", price: 3200000, area_m2: 105 },
        { id: "A3", url: "https://eb.com/p/3", price: 2800000, area_m2: 95 },
      ],
    },
  },
  {
    tool_name: "easybroker_search_closed_deals",
    status: "executed",
    result_json: {
      results: [
        // Duplicado de A1 por url: debe deduplicarse cross-source.
        { id: "A1", url: "https://eb.com/p/1", price: 3000000, area_m2: 100 },
        { id: "H4", url: "https://eb.com/p/4", price: 3100000, area_m2: 102 },
      ],
    },
  },
  {
    tool_name: "get_avaclick_valuation",
    status: "executed",
    result_json: {
      ok: true,
      status: "success",
      source: "avaclick",
      sale_average_mxn: 1600000,
      sale_min_mxn: 1500000,
      sale_max_mxn: 1700000,
      price_per_m2_min_mxn: 15000,
      price_per_m2_max_mxn: 17000,
    },
  },
]);

const dq = analysis.data_quality as Record<string, unknown>;
assert.equal(dq.unique_comparable_count, 4, "4 comparables únicos (A1 dedup)");
assert.equal(comparablesUniqueCount(analysis), 4);
assert.equal(comparablesHasDefensibleSample(analysis), true, "≥3 únicos => defendible");

// Avaclick (~16k/m²) vs mercado (~30k/m²) => conflicto alto.
const conflict = dq.source_conflict as { severity?: string } | null;
assert.ok(conflict, "debe detectar source_conflict");
assert.equal(conflict?.severity, "high");

// --- Propuesta de precio: orden mínimo<=ideal<=salida + per_source con Avaclick ---
const proposal = buildPricingProposalFromComparables({
  analysis,
  subjectAreaM2: 100,
  areaBasis: "construction",
});
assert.ok(proposal, "debe generar pricing_proposal");
assert.ok(
  proposal!.minimo <= proposal!.ideal && proposal!.ideal <= proposal!.salida,
  "rango ordenado mínimo<=ideal<=salida"
);
assert.ok(
  proposal!.per_source.some((s) => s.source === "avaclick"),
  "per_source incluye Avaclick"
);
assert.ok(
  proposal!.per_source.some((s) => s.source === "easybroker_active"),
  "per_source incluye EasyBroker activas"
);
assert.ok(
  proposal!.per_source.some((s) => s.source === "easybroker_historical"),
  "per_source incluye EasyBroker histórico aunque esté vacío"
);
assert.ok(
  proposal!.per_source.some((s) => s.source === "bigquery_internal_inventory"),
  "per_source incluye BigQuery aunque esté vacío"
);
assert.ok(proposal!.consolidated.source_conflict, "consolidado refleja conflicto");
// Bajo conflicto alto, el rango se ensancha hacia Avaclick.
assert.ok(proposal!.minimo <= 1500000, "mínimo se ensancha hacia Avaclick bajo conflicto alto");
const priceApprovalCopy = formatPriceApprovalNotifyText(proposal!);
assert.match(priceApprovalCopy, /Recomendación:/);
assert.match(priceApprovalCopy, /Lectura por fuente:/);
assert.match(priceApprovalCopy, /EasyBroker activas\/publicadas:/);
assert.match(priceApprovalCopy, /Ungga \/ BigQuery:/);
assert.match(priceApprovalCopy, /Criterio usado:/);
assert.match(priceApprovalCopy, /Advertencia:/);
assert.doesNotMatch(priceApprovalCopy, /Base: precio por m² de mercado/);

// --- Muestra insuficiente (<3 únicos) NO es defendible ---
const weak = buildComparablesAnalysisFromToolCalls([
  {
    tool_name: "easybroker_search_listings",
    status: "executed",
    result_json: {
      results: [
        { id: "B1", url: "https://eb.com/q/1", price: 3000000, area_m2: 100 },
        { id: "B2", url: "https://eb.com/q/2", price: 3100000, area_m2: 101 },
      ],
    },
  },
]);
const weakDq = weak.data_quality as Record<string, unknown>;
assert.equal(weakDq.unique_comparable_count, 2);
assert.equal(comparablesHasDefensibleSample(weak), false, "2 únicos => no defendible");
assert.ok(
  (weakDq.warnings as string[]).some((w) => w.includes("Muestra insuficiente")),
  "warning de muestra insuficiente"
);

// --- Exactamente 3 únicos => defendible + warning de mínimo ---
const atMin = buildComparablesAnalysisFromToolCalls([
  {
    tool_name: "easybroker_search_listings",
    status: "executed",
    result_json: {
      results: [
        { id: "C1", url: "https://eb.com/r/1", price: 3000000, area_m2: 100 },
        { id: "C2", url: "https://eb.com/r/2", price: 3100000, area_m2: 101 },
        { id: "C3", url: "https://eb.com/r/3", price: 2900000, area_m2: 99 },
      ],
    },
  },
]);
const atMinDq = atMin.data_quality as Record<string, unknown>;
assert.equal(atMinDq.unique_comparable_count, 3);
assert.equal(atMinDq.at_minimum_sample, true);
assert.equal(comparablesHasDefensibleSample(atMin), true);
assert.ok(
  (atMinDq.warnings as string[]).some((w) => w.includes("mínimo defendible")),
  "warning de muestra en el mínimo"
);

// --- Conflicto por precio total aunque m² esté cerca (escenario Las Fuentes) ---
const lasFuentesLike = buildComparablesAnalysisFromToolCalls([
  {
    tool_name: "easybroker_search_listings",
    status: "executed",
    result_json: {
      results: [
        { id: "L1", url: "https://eb.com/l/1", price: 11100000, area_m2: 220 },
        { id: "L2", url: "https://eb.com/l/2", price: 12546000, area_m2: 270 },
        { id: "L3", url: "https://eb.com/l/3", price: 12055380, area_m2: 265 },
      ],
    },
  },
  {
    tool_name: "get_avaclick_valuation",
    status: "executed",
    result_json: {
      ok: true,
      status: "success",
      sale_average_mxn: 5753000,
      price_per_m2_min_mxn: 35464,
      price_per_m2_max_mxn: 43345,
    },
  },
]);
const lfConflict = (lasFuentesLike.data_quality as Record<string, unknown>).source_conflict as
  | { divergence_pct?: number }
  | null;
assert.ok(lfConflict, "debe detectar conflicto total ~12M vs ~5.7M");
assert.ok(
  (lfConflict?.divergence_pct ?? 0) >= 30,
  "divergencia total debe superar umbral"
);

// --- Avaclick quota: persiste análisis sin valuación y con warning de integración ---
const avaclickQuota = buildComparablesAnalysisFromToolCalls([
  {
    tool_name: "easybroker_search_listings",
    status: "executed",
    result_json: {
      results: [{ id: "Q1", url: "https://eb.com/q1", price: 8000000, area_m2: 180 }],
    },
  },
  {
    tool_name: "easybroker_search_closed_deals",
    status: "executed",
    result_json: {
      results: [{ id: "Q2", url: "https://eb.com/q2", price: 7800000, area_m2: 175 }],
    },
  },
  {
    tool_name: "get_avaclick_valuation",
    status: "failed",
    result_json: {
      ok: false,
      status: "quota_error",
      message: "Alcanzo el limite de Avaluos",
      retryable: false,
    },
  },
]);
const quotaWarnings =
  (avaclickQuota.data_quality as { warnings?: string[] }).warnings ?? [];
assert.ok(
  quotaWarnings.some((w) => /Avaclick no disponible/i.test(w) || /Avaclick falló/i.test(w)),
  "quota_error de Avaclick debe quedar como warning no bloqueante"
);

console.log("comparables-pricing.selftest: ok");
