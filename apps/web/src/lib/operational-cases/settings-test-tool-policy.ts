import type { ToolApprovalPolicy } from "@agents/types";

/** Tools that must run without HITL during Settings → Preparación operativa. */
export const SETTINGS_TEST_AUTO_EXECUTE_TOOLS = [
  "telegram_send_message_to_contact",
  "operational_case_update_state",
  "operational_case_add_event",
] as const;

export function buildSettingsTestToolApprovalPolicy(
  extraToolIds?: Iterable<string>
): ToolApprovalPolicy {
  const policy: ToolApprovalPolicy = {};
  for (const toolId of SETTINGS_TEST_AUTO_EXECUTE_TOOLS) {
    policy[toolId] = "auto_execute";
  }
  if (extraToolIds) {
    for (const toolId of extraToolIds) {
      policy[toolId] = "auto_execute";
    }
  }
  return policy;
}
