import assert from "node:assert/strict";
import {
  buildComparablesAnalysisFromToolCalls,
  comparablesUsableCount,
  COMPARABLES_INSUFFICIENT_N4_SCENARIO_ID,
  isComparablesInsufficientN4TestContext,
  normalizeComparablesAnalysisForInsufficientN4Test,
} from "./comparables-analysis";

const context = { skill_test_n4_seed: COMPARABLES_INSUFFICIENT_N4_SCENARIO_ID };

assert.equal(isComparablesInsufficientN4TestContext(context), true);
assert.equal(isComparablesInsufficientN4TestContext({}), false);

const raw = buildComparablesAnalysisFromToolCalls([
  {
    tool_name: "easybroker_search_closed_deals",
    status: "executed",
    result_json: {
      results: [
        {
          id: "eb-1",
          price: 22000,
          area_m2: 90,
          property_type: "departamento",
          operation: "rent",
        },
      ],
    },
  },
]);

assert.ok(comparablesUsableCount(raw) > 0, "sin normalizar debe haber usables");

const normalized = normalizeComparablesAnalysisForInsufficientN4Test(raw, context);
assert.equal(comparablesUsableCount(normalized), 0);
assert.equal(
  (normalized.data_quality as { usable_count?: number }).usable_count,
  0
);

const invalidFiltersAnalysis = buildComparablesAnalysisFromToolCalls([
  {
    tool_name: "easybroker_search_listings",
    status: "executed",
    result_json: {
      ok: false,
      status: "validation_error",
      error: "invalid_comparable_filters",
      invalid_fields: ["min_area_m2", "max_area_m2"],
    },
  },
]);
assert.equal(
  (invalidFiltersAnalysis.data_quality as { search_validity?: string }).search_validity,
  "invalid_filters"
);

const missingSourceAnalysis = buildComparablesAnalysisFromToolCalls([
  {
    tool_name: "get_avaclick_valuation",
    status: "executed",
    result_json: {
      ok: false,
      error: "avaclick_required_before_persist",
    },
  },
]);
assert.equal(
  (missingSourceAnalysis.data_quality as { search_validity?: string }).search_validity,
  "missing_required_source"
);

const fallbackExhaustedAnalysis = buildComparablesAnalysisFromToolCalls([
  {
    tool_name: "easybroker_search_listings",
    status: "executed",
    result_json: {
      ok: true,
      count: 0,
      results: [],
      filters_used: { min_area_m2: 109, max_area_m2: 350, zona: "Las Fuentes" },
      search_attempts: {
        strict_filters: { min_area_m2: 124, max_area_m2: 270 },
        attempts: [
          {
            level: "strict",
            reason: "canonical_strict",
            filters: { min_area_m2: 124, max_area_m2: 270 },
            count: 0,
            ok: true,
          },
          {
            level: "expanded",
            reason: "expand_area_band",
            filters: { min_area_m2: 117, max_area_m2: 307 },
            count: 0,
            ok: true,
          },
          {
            level: "wide",
            reason: "expand_area_band_wide",
            filters: { min_area_m2: 109, max_area_m2: 350 },
            count: 0,
            ok: true,
          },
          {
            level: "location_only",
            reason: "location_operation_and_type_only",
            filters: { zona: "Las Fuentes" },
            count: 0,
            ok: true,
          },
        ],
        last_attempt_level: "location_only",
        applied_level: null,
        exhausted: true,
      },
    },
  },
]);
assert.ok(
  Array.isArray((fallbackExhaustedAnalysis.data_quality as { warnings?: unknown }).warnings)
);
assert.ok(
  (
    (fallbackExhaustedAnalysis.data_quality as { warnings?: string[] }).warnings ?? []
  ).some((warning) => warning.includes("Se agotó fallback moderado"))
);
assert.ok(
  (
    (fallbackExhaustedAnalysis.data_quality as { warnings?: string[] }).warnings ?? []
  ).some((warning) => warning.includes("location_only"))
);
assert.equal(
  (fallbackExhaustedAnalysis.filters_used as { zona?: string }).zona,
  "Las Fuentes"
);

console.log("comparables-insufficient-n4.selftest: ok");
