import assert from "node:assert/strict";
import { TOOL_CATALOG } from "@agents/agent";
import {
  buildScheduledTaskToolApprovalPolicy,
  defaultApprovalModeForTool,
  isScheduledTaskLegacyAutoApproveEnabled,
} from "./scheduled-task-tool-policy";

// ── Risk-scoped defaults ─────────────────────────────────────────────────────

const policy = buildScheduledTaskToolApprovalPolicy();

// Every catalog tool has an explicit entry (the coarse autoApproveTools
// boolean no longer decides approvals).
for (const tool of TOOL_CATALOG) {
  assert.ok(policy[tool.id], `missing policy entry for ${tool.id}`);
}

// Plan evidence: medium/high-risk external side effects are NOT auto-approved.
assert.equal(policy["calendar_delete_event"], "request_approval");
assert.equal(policy["telegram_send_message_to_contact"], "request_approval");
assert.equal(policy["easybroker_publish_listing"], "request_approval");
assert.equal(policy["bash"], "request_approval");
assert.equal(policy["write_file"], "request_approval");

// Low-risk tools keep auto-executing.
assert.equal(policy["get_user_preferences"], "auto_execute");

// Risk parity with the catalog: low ⇒ auto_execute, else request_approval.
for (const tool of TOOL_CATALOG) {
  assert.equal(
    policy[tool.id],
    tool.risk === "low" ? "auto_execute" : "request_approval",
    `unexpected default for ${tool.id} (risk=${tool.risk})`
  );
}

// Unknown tools are treated as high risk.
assert.equal(defaultApprovalModeForTool("nonexistent_tool"), "request_approval");
assert.equal(
  defaultApprovalModeForTool("manage_scheduled_tasks:pause"),
  buildScheduledTaskToolApprovalPolicy()["manage_scheduled_tasks"]
);

// ── Per-task narrowing (never widening) ──────────────────────────────────────

const narrowed = buildScheduledTaskToolApprovalPolicy({
  taskPolicy: {
    // Widening attempt on a high-risk tool: ignored.
    bash: "auto_execute",
    // Narrowing a low-risk tool: honored.
    get_user_preferences: "request_approval",
    // Denying a risky tool: honored.
    telegram_send_message_to_contact: "deny",
    // Operation-scoped key: kept (stricter than the base for the tool).
    "manage_scheduled_tasks:pause": "request_approval",
  },
});
assert.equal(narrowed["bash"], "request_approval");
assert.equal(narrowed["get_user_preferences"], "request_approval");
assert.equal(narrowed["telegram_send_message_to_contact"], "deny");
assert.equal(narrowed["manage_scheduled_tasks:pause"], "request_approval");

// Null/absent task policy keeps the risk-scoped defaults.
assert.deepEqual(buildScheduledTaskToolApprovalPolicy({ taskPolicy: null }), policy);

// ── Legacy escape hatch ──────────────────────────────────────────────────────

assert.equal(
  isScheduledTaskLegacyAutoApproveEnabled({ SCHEDULED_TASKS_LEGACY_AUTOAPPROVE: "true" }),
  true
);
assert.equal(
  isScheduledTaskLegacyAutoApproveEnabled({ SCHEDULED_TASKS_LEGACY_AUTOAPPROVE: "false" }),
  false
);
assert.equal(isScheduledTaskLegacyAutoApproveEnabled({}), false);

console.log("scheduled-task-tool-policy.selftest: ok");
