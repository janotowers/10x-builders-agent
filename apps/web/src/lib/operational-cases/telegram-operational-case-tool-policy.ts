import type { OperationalCase, ToolApprovalPolicy } from "@agents/types";

export function buildTelegramOperationalCaseToolApprovalPolicy(
  opCase: Pick<OperationalCase, "current_step"> | null | undefined
): ToolApprovalPolicy | undefined {
  if (!opCase) return undefined;

  const policy: ToolApprovalPolicy = {
    operational_case_update_intake: "auto_execute",
  };

  if (opCase.current_step === "intake") {
    policy.operational_case_create = "auto_execute";
    policy.operational_case_update_state = "deny";
  }

  return policy;
}
