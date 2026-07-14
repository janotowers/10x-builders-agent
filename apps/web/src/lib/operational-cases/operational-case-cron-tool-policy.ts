import type { ToolApprovalPolicy } from "@agents/types";

/**
 * Case-runner bookkeeping is validated by the operational-case adapters
 * (case ownership, expected version and transition guards), so it must not
 * create technical HITL. External side effects and commercial decisions are
 * intentionally absent and keep their catalog-defined approval behavior.
 */
export const OPERATIONAL_CASE_CRON_AUTO_EXECUTE_TOOLS = [
  "operational_case_update_intake",
  "operational_case_update_state",
  "operational_case_add_event",
  "operational_case_list_documents",
] as const;

export function buildOperationalCaseCronToolApprovalPolicy(): ToolApprovalPolicy {
  return Object.fromEntries(
    OPERATIONAL_CASE_CRON_AUTO_EXECUTE_TOOLS.map((toolId) => [
      toolId,
      "auto_execute" as const,
    ])
  );
}
