import {
  operationalCaseDocumentRequestTargetFromContext,
  type OperationalCase,
  type ToolApprovalPolicy,
} from "@agents/types";

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
  // Crear el borrador es trabajo mecánico interno. La decisión humana ocurre
  // después, en contract_review (enviar/corregir), no antes de renderizar.
  "generate_document_from_template",
] as const;

export function buildOperationalCaseCronToolApprovalPolicy(
  opCase?: Pick<OperationalCase, "context_jsonb"> | null
): ToolApprovalPolicy {
  const policy: ToolApprovalPolicy = Object.fromEntries(
    OPERATIONAL_CASE_CRON_AUTO_EXECUTE_TOOLS.map((toolId) => [
      toolId,
      "auto_execute" as const,
    ])
  );
  // Ruta interna: nunca proponer comunicación al propietario/contacto externo.
  if (
    opCase &&
    operationalCaseDocumentRequestTargetFromContext(opCase.context_jsonb) ===
      "internal_user"
  ) {
    policy.telegram_send_message_to_contact = "deny";
  }
  return policy;
}
