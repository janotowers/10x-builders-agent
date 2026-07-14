import type { ToolApprovalPolicy } from "@agents/types";

/** Tools that must run without HITL during Settings → Preparación operativa. */
export const SETTINGS_TEST_AUTO_EXECUTE_TOOLS = [
  "telegram_send_message_to_contact",
  "operational_case_update_state",
  "operational_case_add_event",
] as const;

/**
 * Tools de publicación (riesgo medium/high) que en E2E se auto-ejecutan
 * cuando ya hubo aprobación de negocio por destino (`publish_approvals`).
 * Evita doble HITL: negocio (Telegram) + técnico (tool).
 */
export const SETTINGS_TEST_PUBLISH_AUTO_EXECUTE_TOOLS = [
  "image_watermark",
  "easybroker_create_listing",
  "easybroker_upload_images",
  "easybroker_publish_listing",
  "ungga_publish_listing",
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

/**
 * Política al reanudar un HITL técnico de un tick E2E (`source=agent_e2e`).
 * Sin esto, el resume de Telegram/web vuelve a pedir confirmación en el
 * siguiente tool_call high-risk del mismo turno (p. ej. reintento de
 * easybroker_create_listing tras un validation_error).
 */
export function buildAgentE2EResumeToolApprovalPolicy(): ToolApprovalPolicy {
  return buildSettingsTestToolApprovalPolicy(["generate_document_from_template"]);
}

export function isAgentE2EToolCall(toolCall: {
  metadata_jsonb?: { source?: string | null } | null;
}): boolean {
  return toolCall.metadata_jsonb?.source === "agent_e2e";
}
