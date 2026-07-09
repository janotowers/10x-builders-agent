import assert from "node:assert/strict";
import { detectStepScenarioFixtureDrift } from "./step-test-scenario-fixture-drift";

assert.deepEqual(
  detectStepScenarioFixtureDrift("package_ready_preflight_blocked", {
    raw_photos: [],
  }),
  []
);

const drift = detectStepScenarioFixtureDrift("package_ready_preflight_blocked", {
  raw_photos: ["a", "b", "c", "d", "e", "f", "g"],
});
assert.equal(drift.length, 1);
assert.match(drift[0] ?? "", /menos de 5 fotos/);
assert.match(drift[0] ?? "", /7/);

const reviewDrift = detectStepScenarioFixtureDrift(
  "package_ready_description_review_requested",
  { raw_photos: ["a"], pricing_proposal: { approval_status: "pending" } }
);
assert.equal(reviewDrift.length, 2);

console.log("step-test-scenario-fixture-drift.selftest: ok");
