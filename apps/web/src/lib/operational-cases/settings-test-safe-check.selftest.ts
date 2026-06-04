import assert from "node:assert/strict";
import {
  firstOperationalStep,
  safeTestStartStep,
  safeTestSuccessStep,
} from "./settings-test-safe-check";

const flow = [
  { step_key: "intake", step_label: "Completar registro" },
  { step_key: "first_operational", step_label: "Primer paso operativo" },
  { step_key: "transversal_tools", step_label: "Transversales" },
  { step_key: "second_operational", step_label: "Segundo paso operativo" },
];

assert.equal(safeTestStartStep(null), "intake");
assert.equal(firstOperationalStep(flow), "first_operational");
assert.equal(safeTestSuccessStep(null, flow), "first_operational");
assert.equal(
  safeTestSuccessStep({ safe_test: { success_step: "custom_success" } }, flow),
  "custom_success"
);
assert.equal(
  safeTestStartStep({ safe_test: { start_step: "custom_start" } }),
  "custom_start"
);

console.log("settings-test-safe-check.selftest: ok");
