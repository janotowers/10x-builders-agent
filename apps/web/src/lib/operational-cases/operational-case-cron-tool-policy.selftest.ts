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
  "generate_document_from_template",
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

console.log("operational-case-cron-tool-policy.selftest: ok");
