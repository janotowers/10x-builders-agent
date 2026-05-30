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

console.log("comparables-insufficient-n4.selftest: ok");
