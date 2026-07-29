/**
 * Scheduled-task tool-risk allowlist (flexible-workflows plan, Slice 0.3).
 *
 * Historically the scheduled-tasks cron ran the agent with
 * `autoApproveTools: true`: every tool — including medium/high-risk external
 * side effects (`bash`, `telegram_send_message_to_contact`,
 * `easybroker_publish_listing`, `calendar_delete_event`, …) — executed without
 * a second human confirmation. This module replaces that coarse boolean with
 * an explicit, risk-scoped allowlist (modeled on
 * `operational-case-cron-tool-policy.ts`):
 *
 *   - low-risk catalog tools     → `auto_execute`
 *   - medium/high-risk tools     → `request_approval` (existing HITL inbox)
 *   - per-task `tool_approval_policy` entries may NARROW the default
 *     (auto_execute → request_approval → deny) but never widen it.
 *
 * Escape hatch for one release: `SCHEDULED_TASKS_LEGACY_AUTOAPPROVE=true`
 * restores the previous behavior globally (default off).
 */
import { TOOL_CATALOG } from "@agents/agent";
import type {
  ToolApprovalMode,
  ToolApprovalPolicy,
  ToolRisk,
} from "@agents/types";

/** Strictness order: a task policy may only move a tool to a HIGHER value. */
const APPROVAL_STRICTNESS: Record<ToolApprovalMode, number> = {
  auto_execute: 0,
  request_approval: 1,
  deny: 2,
};

const TOOL_RISK_BY_ID: ReadonlyMap<string, ToolRisk> = new Map(
  TOOL_CATALOG.map((tool) => [tool.id, tool.risk])
);

export function isScheduledTaskLegacyAutoApproveEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  return env.SCHEDULED_TASKS_LEGACY_AUTOAPPROVE === "true";
}

/** Unknown tools (not in the catalog) are treated as high risk. */
export function defaultApprovalModeForTool(toolId: string): ToolApprovalMode {
  const baseToolId = toolId.includes(":") ? toolId.split(":")[0]! : toolId;
  const risk = TOOL_RISK_BY_ID.get(baseToolId) ?? "high";
  return risk === "low" ? "auto_execute" : "request_approval";
}

function stricter(a: ToolApprovalMode, b: ToolApprovalMode): ToolApprovalMode {
  return APPROVAL_STRICTNESS[a] >= APPROVAL_STRICTNESS[b] ? a : b;
}

/**
 * Builds the effective run-time approval policy for one scheduled task.
 * Covers every catalog tool explicitly so `autoApproveTools` no longer
 * influences approval decisions (explicit policy entries take precedence in
 * `resolveToolApprovalMode`).
 */
export function buildScheduledTaskToolApprovalPolicy(params?: {
  /** The task's persisted `tool_approval_policy` (may include `tool:op` keys). */
  taskPolicy?: ToolApprovalPolicy | null;
}): ToolApprovalPolicy {
  const policy: ToolApprovalPolicy = {};
  for (const tool of TOOL_CATALOG) {
    policy[tool.id] = defaultApprovalModeForTool(tool.id);
  }
  const taskPolicy = params?.taskPolicy;
  if (taskPolicy) {
    for (const [key, requestedMode] of Object.entries(taskPolicy)) {
      const baseMode = policy[key] ?? defaultApprovalModeForTool(key);
      // Narrow-only merge: a persisted task policy can tighten but a stale or
      // hand-crafted `auto_execute` on a risky tool is ignored.
      policy[key] = stricter(requestedMode, baseMode);
    }
  }
  return policy;
}
