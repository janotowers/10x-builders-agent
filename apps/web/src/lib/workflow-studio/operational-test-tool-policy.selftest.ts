import assert from "node:assert/strict";
import {
  buildStudioOperationalTestToolPolicy,
  studioOperationalTestApprovalModeForTool,
  studioOperationalTestSandboxPolicyHash,
} from "./operational-test-tool-policy";

const policy = buildStudioOperationalTestToolPolicy();

assert.equal(policy.get_user_preferences, "auto_execute");
assert.equal(policy.notify_user, "auto_execute");
assert.equal(
  policy.operational_case_update_state,
  "auto_execute",
  "tenant-owned test fixture state must use the production transition path"
);
assert.equal(policy.operational_case_add_event, "auto_execute");

assert.equal(policy.telegram_send_message_to_contact, "deny");
assert.equal(policy.gmail_send_email, "deny");
assert.equal(policy.easybroker_publish_listing, "deny");
assert.equal(policy.github_create_repo, "deny");
assert.equal(
  policy.list_runtime_attachments,
  "auto_execute",
  "baseline Studio sandbox may auto-execute low-risk attachment reads"
);
assert.equal(policy.read_runtime_attachment, "auto_execute");
assert.equal(policy.search_runtime_attachments, "auto_execute");
assert.equal(
  studioOperationalTestApprovalModeForTool("calendar_delete_event"),
  "deny"
);
assert.equal(
  studioOperationalTestApprovalModeForTool("calendar_delete_event:delete"),
  "deny"
);
assert.equal(
  studioOperationalTestApprovalModeForTool("future_unregistered_tool"),
  "deny",
  "unknown tools must fail closed"
);

assert.match(studioOperationalTestSandboxPolicyHash(), /^sha256:[a-f0-9]{64}$/);
assert.equal(
  studioOperationalTestSandboxPolicyHash(),
  studioOperationalTestSandboxPolicyHash(),
  "the persisted policy hash must be deterministic"
);

console.log("operational-test-tool-policy.selftest: ok");
