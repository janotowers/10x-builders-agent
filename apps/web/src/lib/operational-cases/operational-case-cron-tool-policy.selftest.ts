import assert from "node:assert/strict";
import {
  buildOperationalCaseCronToolApprovalPolicy,
  OPERATIONAL_CASE_CRON_AUTO_EXECUTE_TOOLS,
} from "./operational-case-cron-tool-policy";

const policy = buildOperationalCaseCronToolApprovalPolicy();

for (const toolId of OPERATIONAL_CASE_CRON_AUTO_EXECUTE_TOOLS) {
  assert.equal(policy[toolId], "auto_execute");
}

for (const externalOrCommercialTool of [
  "telegram_send_message_to_contact",
  "easybroker_create_listing",
  "easybroker_upload_images",
  "ungga_publish_listing",
]) {
  assert.equal(
    policy[externalOrCommercialTool],
    undefined,
    `${externalOrCommercialTool} must preserve catalog HITL behavior`
  );
}
assert.equal(
  policy.generate_document_from_template,
  "auto_execute",
  "internal draft rendering is mechanical; contract_review owns human approval"
);

const internalRoutePolicy = buildOperationalCaseCronToolApprovalPolicy({
  context_jsonb: { document_request_target: "internal_user" },
});
assert.equal(
  internalRoutePolicy.telegram_send_message_to_contact,
  "deny",
  "internal document collection must never contact the external owner"
);

const externalRoutePolicy = buildOperationalCaseCronToolApprovalPolicy({
  context_jsonb: { document_request_target: "external_contact" },
});
assert.equal(
  externalRoutePolicy.telegram_send_message_to_contact,
  undefined,
  "external contact route preserves catalog HITL"
);

console.log("operational-case-cron-tool-policy.selftest: ok");
