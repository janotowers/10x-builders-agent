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
      search_attempts: {
        strict_filters: { min_area_m2: 124, max_area_m2: 168 },
        fallback_filters: { min_area_m2: 109, max_area_m2: 183 },
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

console.log("comparables-insufficient-n4.selftest: ok");
