import assert from "node:assert/strict";
import { buildSettingsTestToolApprovalPolicy } from "./settings-test-tool-policy";

const defaultPolicy = buildSettingsTestToolApprovalPolicy();
assert.equal(defaultPolicy.telegram_send_message_to_contact, "auto_execute");
assert.equal(defaultPolicy.operational_case_update_state, "auto_execute");
assert.equal(defaultPolicy.operational_case_add_event, "auto_execute");

const internalPolicy = buildSettingsTestToolApprovalPolicy(undefined, {
  documentRequestTarget: "internal_user",
});
assert.equal(internalPolicy.telegram_send_message_to_contact, "deny");
assert.equal(internalPolicy.operational_case_update_state, "auto_execute");
assert.equal(internalPolicy.operational_case_add_event, "auto_execute");

const externalPolicy = buildSettingsTestToolApprovalPolicy(undefined, {
  documentRequestTarget: "external_contact",
});
assert.equal(externalPolicy.telegram_send_message_to_contact, "auto_execute");

console.log("settings-test-tool-policy.selftest: ok");
