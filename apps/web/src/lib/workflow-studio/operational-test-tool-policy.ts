import { createHash } from "node:crypto";
import { TOOL_CATALOG } from "@agents/agent";
import type { ToolApprovalMode, ToolApprovalPolicy } from "@agents/types";
import { canonicalizeJson } from "@agents/workflows";
import { buildSettingsTestToolApprovalPolicy } from "../operational-cases/settings-test-tool-policy";

export const STUDIO_OPERATIONAL_TEST_SANDBOX_POLICY_ID =
  "studio-operational-test";
export const STUDIO_OPERATIONAL_TEST_SANDBOX_POLICY_VERSION = "1";

/**
 * Internal fixture mutations needed by the production-parity case harness.
 * They remain inside a tenant-owned test case and create no external effect.
 */
const STUDIO_SANDBOX_INTERNAL_AUTO_EXECUTE = new Set([
  "operational_case_update_state",
  "operational_case_add_event",
]);

const TOOL_BY_ID = new Map(TOOL_CATALOG.map((tool) => [tool.id, tool]));
const SETTINGS_TEST_BASE_POLICY = buildSettingsTestToolApprovalPolicy();

function baseToolId(toolId: string): string {
  return toolId.includes(":") ? toolId.split(":")[0]! : toolId;
}

/**
 * Fail-closed Studio sandbox:
 * - unknown tools deny;
 * - medium/high-risk tools deny, including all external writes/messages;
 * - low-risk tools auto-execute;
 * - two internal case-fixture mutations inherit the Settings test allowance.
 */
export function studioOperationalTestApprovalModeForTool(
  toolId: string
): ToolApprovalMode {
  const id = baseToolId(toolId);
  const tool = TOOL_BY_ID.get(id);
  if (!tool) return "deny";
  if (STUDIO_SANDBOX_INTERNAL_AUTO_EXECUTE.has(id)) {
    return SETTINGS_TEST_BASE_POLICY[id] ?? "deny";
  }
  if (tool.risk === "low") {
    return SETTINGS_TEST_BASE_POLICY[id] ?? "auto_execute";
  }
  return "deny";
}

/** Explicit policy for every catalog tool; callers use the resolver for unknowns. */
export function buildStudioOperationalTestToolPolicy(): ToolApprovalPolicy {
  const policy: ToolApprovalPolicy = {};
  for (const tool of TOOL_CATALOG) {
    policy[tool.id] = studioOperationalTestApprovalModeForTool(tool.id);
  }
  return policy;
}

export function studioOperationalTestSandboxPolicyHash(): string {
  const descriptor = {
    id: STUDIO_OPERATIONAL_TEST_SANDBOX_POLICY_ID,
    version: STUDIO_OPERATIONAL_TEST_SANDBOX_POLICY_VERSION,
    policy: buildStudioOperationalTestToolPolicy(),
    unknown_tool_mode: "deny",
  };
  return `sha256:${createHash("sha256")
    .update(canonicalizeJson(descriptor), "utf8")
    .digest("hex")}`;
}
