import assert from "node:assert/strict";
import {
  buildAgentE2EResumeToolApprovalPolicy,
  buildSettingsTestToolApprovalPolicy,
  isAgentE2EToolCall,
} from "./settings-test-tool-policy";

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

const contractDraftAutoExecutePolicy = buildSettingsTestToolApprovalPolicy(undefined, {
  autoExecuteContractDraftGeneration: true,
});
assert.equal(
  contractDraftAutoExecutePolicy.generate_document_from_template,
  "auto_execute"
);

assert.equal(
  buildSettingsTestToolApprovalPolicy().easybroker_create_listing,
  undefined
);

const resumePolicy = buildAgentE2EResumeToolApprovalPolicy();
assert.equal(resumePolicy.easybroker_create_listing, undefined);
assert.equal(resumePolicy.generate_document_from_template, "auto_execute");
assert.equal(isAgentE2EToolCall({ metadata_jsonb: { source: "agent_e2e" } }), true);
assert.equal(isAgentE2EToolCall({ metadata_jsonb: { source: "web" } }), false);

console.log("settings-test-tool-policy.selftest: ok");
