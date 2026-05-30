import assert from "node:assert/strict";
import {
  isolateContextForSkillTest,
  isolateContextForStepTest,
} from "./settings-test-run-isolation";

const base = {
  created_from: "case_type_settings_test",
  test_mode: true,
  property_data: { bedrooms: 3 },
  skill_test_n3_seed: "old_n3",
  skill_test_n4_seed: "old_n4",
  skill_test_repairs: { old: true },
  comparables_analysis: { stale: true },
  pricing_proposal: { stale: true },
  contract_draft: { stale: true },
};

const n3Comparables = isolateContextForSkillTest(
  base,
  "perform-comparable-analysis"
);
assert.equal(n3Comparables.skill_test_n3_seed, undefined);
assert.equal(n3Comparables.skill_test_n4_seed, undefined);
assert.equal(n3Comparables.skill_test_repairs, undefined);
assert.equal(n3Comparables.comparables_analysis, undefined);
assert.equal(n3Comparables.pricing_proposal, undefined);
assert.deepEqual(n3Comparables.property_data, { bedrooms: 3 });

const n4Price = isolateContextForStepTest(
  base,
  "price_proposal_pending_hitl"
);
assert.equal(n4Price.skill_test_n3_seed, undefined);
assert.equal(n4Price.skill_test_n4_seed, undefined);
assert.equal(n4Price.comparables_analysis, undefined);
assert.equal(n4Price.pricing_proposal, undefined);
assert.equal(n4Price.contract_draft, undefined);
assert.deepEqual(n4Price.property_data, { bedrooms: 3 });

console.log("settings-test-run-isolation.selftest: ok");
