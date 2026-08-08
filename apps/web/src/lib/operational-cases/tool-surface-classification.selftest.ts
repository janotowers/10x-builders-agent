import assert from "node:assert/strict";
import {
  isInternalOperationalTool,
  isReadinessVisibleTool,
  toolSurfaceKind,
} from "./tool-surface-classification";

for (const internalTool of [
  "operational_case_update_intake",
  "operational_case_update_state",
  "operational_case_add_event",
]) {
  assert.equal(toolSurfaceKind(internalTool), "internal_platform");
  assert.equal(isInternalOperationalTool(internalTool), true);
  assert.equal(isReadinessVisibleTool(internalTool), false);
}

assert.equal(isReadinessVisibleTool("notify_user"), true);
assert.equal(isReadinessVisibleTool("generate_document_from_template"), true);
assert.equal(toolSurfaceKind("gmail_send_email"), "external_action");
assert.equal(isReadinessVisibleTool("gmail_send_email"), true);

console.log("tool-surface-classification.selftest: ok");
