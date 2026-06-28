import type { ToolApprovalPolicy } from "@agents/types";

/** Tools that must run without HITL during Settings → Preparación operativa. */
export const SETTINGS_TEST_AUTO_EXECUTE_TOOLS = [
  "telegram_send_message_to_contact",
  "operational_case_update_state",
  "operational_case_add_event",
] as const;

type SettingsTestToolPolicyOptions = {
  documentRequestTarget?: "internal_user" | "external_contact" | null;
  autoExecuteContractDraftGeneration?: boolean;
};

export function buildSettingsTestToolApprovalPolicy(
  extraToolIds?: Iterable<string>,
  options?: SettingsTestToolPolicyOptions
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
  if (options?.documentRequestTarget === "internal_user") {
    policy.telegram_send_message_to_contact = "deny";
  }
  if (options?.autoExecuteContractDraftGeneration) {
    policy.generate_document_from_template = "auto_execute";
  }
  return policy;
}
