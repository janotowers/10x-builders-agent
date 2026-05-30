/**
 * Clasificación de superficie de tools para readiness vs runtime.
 * Patrones: PATTERN_TOOL_SURFACE_CLASSIFICATION, PATTERN_CASE_INTAKE_PRECONDITION
 *
 * - `allowed_tools` en SKILL.md = runtime (el agente puede invocarlas).
 * - readiness-visible = tarjeta N1 y prerequisito N3/N4.
 * - internal = persistencia/plataforma; validadas en detalle técnico N3/N4.
 */

export type ToolSurfaceKind =
  | "business_integration"
  | "external_action"
  | "internal_notification"
  | "internal_platform"
  | "internal_domain"
  | "scenario_only"
  | "infrastructure";

const TOOL_SURFACE_BY_ID: Record<string, ToolSurfaceKind> = {
  operational_case_create: "scenario_only",
  operational_case_update_state: "internal_platform",
  operational_case_add_event: "internal_platform",
  operational_case_persist_comparables_analysis: "internal_domain",
  operational_case_list_documents: "business_integration",
  operational_case_extract_document_fields: "business_integration",
  operational_case_register_document: "internal_platform",
  notify_user: "internal_notification",
  telegram_send_message_to_contact: "external_action",
  easybroker_search_listings: "business_integration",
  easybroker_search_closed_deals: "business_integration",
  bigquery_lookup_local_comparables: "business_integration",
  easybroker_create_listing: "business_integration",
  easybroker_upload_images: "business_integration",
  ungga_publish_listing: "business_integration",
  generate_document_from_template: "business_integration",
  image_watermark: "business_integration",
  calendar_create_event: "business_integration",
  calendar_list_events: "business_integration",
  calendar_list_tasks: "business_integration",
  get_user_preferences: "infrastructure",
  list_enabled_tools: "infrastructure",
  read_skill_reference: "infrastructure",
};

/** Pasos de preparación / intake (no numerados como flujo operativo en UI). */
export const INTAKE_PREPARATION_STEP_KEYS = new Set(["intake"]);

export function toolSurfaceKind(toolId: string): ToolSurfaceKind {
  return TOOL_SURFACE_BY_ID[toolId] ?? "business_integration";
}

export function isReadinessVisibleTool(toolId: string): boolean {
  const kind = toolSurfaceKind(toolId);
  return (
    kind === "business_integration" ||
    kind === "external_action" ||
    kind === "internal_notification"
  );
}

export function isInternalOperationalTool(toolId: string): boolean {
  const kind = toolSurfaceKind(toolId);
  return (
    kind === "internal_platform" ||
    kind === "internal_domain" ||
    kind === "infrastructure"
  );
}

export function isScenarioOnlyTool(toolId: string): boolean {
  return toolSurfaceKind(toolId) === "scenario_only";
}

export function isIntakePreparationStep(stepKey: string): boolean {
  return INTAKE_PREPARATION_STEP_KEYS.has(stepKey);
}

export type FlowToolRef = { tool_id: string };

export type FlowStepToolsSource = {
  step_key: string;
  step_skills?: Array<{ skill_tools?: FlowToolRef[] }>;
  step_tools?: FlowToolRef[];
};

/** IDs de tools que exigen N1 antes de N3/N4. */
export function readinessToolIdsForStep(step: FlowStepToolsSource): string[] {
  const fromSkills = (step.step_skills ?? []).flatMap((skill) =>
    (skill.skill_tools ?? []).map((t) => t.tool_id)
  );
  const fromStep = (step.step_tools ?? []).map((t) => t.tool_id);
  return Array.from(
    new Set([...fromSkills, ...fromStep].filter((id) => isReadinessVisibleTool(id)))
  );
}

export function readinessToolIdsForSkill(skillTools: FlowToolRef[] | undefined): string[] {
  return Array.from(
    new Set((skillTools ?? []).map((t) => t.tool_id).filter(isReadinessVisibleTool))
  );
}

export function partitionFlowSteps<T extends { step_key: string }>(steps: T[]): {
  preparationSteps: T[];
  operationalSteps: T[];
} {
  const preparationSteps: T[] = [];
  const operationalSteps: T[] = [];
  for (const step of steps) {
    if (isIntakePreparationStep(step.step_key)) {
      preparationSteps.push(step);
    } else if (step.step_key !== "transversal_tools") {
      operationalSteps.push(step);
    }
  }
  return { preparationSteps, operationalSteps };
}

export function toolSurfaceLabel(kind: ToolSurfaceKind): string {
  switch (kind) {
    case "business_integration":
      return "Integración de negocio";
    case "external_action":
      return "Acción externa";
    case "internal_notification":
      return "Notificación interna";
    case "internal_platform":
      return "Plataforma / persistencia";
    case "internal_domain":
      return "Dominio interno";
    case "scenario_only":
      return "Escenario de alta";
    case "infrastructure":
      return "Infraestructura";
    default:
      return "Tool";
  }
}
