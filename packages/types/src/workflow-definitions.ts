// Workflow-definition model (flexible-workflows plan, Phase 1 / Slice 1.1-1.2).
// `graph_jsonb` is the executable artifact; `operational_flow_jsonb` on
// operational_case_types remains presentation/QA metadata and is NOT runtime.

// Import type-only desde el barrel: legal en TS (se borra al compilar) y
// mantiene UN solo shape canónico de required asset (finding 16).
import type { OperationalCaseRequiredAsset } from "./index";

export type WorkflowOwnerScope = "global" | "user" | "organization";

export type WorkflowDefinitionStatus =
  | "draft"
  | "validated"
  | "published"
  | "deprecated";

export type WorkflowDefinitionVisibility = "private" | "shared_template";

export type WorkflowTransitionProposer =
  | "model"
  | "decision_handler"
  | "runtime";

export interface WorkflowGraphState {
  key: string;
  label?: string;
  kind: "operational" | "terminal";
}

export interface WorkflowGraphTransition {
  from: string;
  to: string;
  /** Named guards resolved against the code registry — never inline code. */
  guards: string[];
  authorized_proposers: WorkflowTransitionProposer[];
  approval_required: string | null;
}

export interface WorkflowGraphStepBinding {
  state: string;
  skill: string | null;
  bigquery_context?: boolean;
  /**
   * Assets de cuenta que el paso requiere (Technical Plan §5.2, finding 16;
   * Slice 2.7-5). Mismo shape que `OperationalCaseRequiredAsset` del flow.
   * Ausente en definiciones publicadas antes del port del transformer — los
   * consumidores usan el fallback del lab (Slice 2.7-4) hasta el siguiente
   * publish.
   */
  required_assets?: OperationalCaseRequiredAsset[];
}

export interface WorkflowGraphWorkTemplate {
  on_enter_state: string;
  work_type: string;
  required_capability?: string;
  depends_on?: string[];
  verification_contract?: Record<string, unknown>;
}

export interface WorkflowGraphPostcondition {
  state: string;
  checks: string[];
}

export interface WorkflowGraphApproval {
  kind: string;
  evidence_inputs: string[];
}

export interface WorkflowGraphCompletion {
  terminal_states: string[];
  required_evidence: string[];
}

export interface WorkflowGraph {
  states: WorkflowGraphState[];
  transitions: WorkflowGraphTransition[];
  step_bindings: WorkflowGraphStepBinding[];
  work_templates: WorkflowGraphWorkTemplate[];
  postconditions: WorkflowGraphPostcondition[];
  approvals: WorkflowGraphApproval[];
  impact_dependencies: Record<string, string[]>;
  completion: WorkflowGraphCompletion;
}

export interface WorkflowDefinition {
  id: string;
  owner_scope: WorkflowOwnerScope;
  user_id: string | null;
  organization_id: string | null;
  case_type: string;
  workflow_key: string;
  version: number;
  status: WorkflowDefinitionStatus;
  industry: string | null;
  domain_tags: string[];
  business_spec_jsonb: Record<string, unknown>;
  implementation_spec_jsonb: Record<string, unknown>;
  graph_jsonb: WorkflowGraph;
  definition_hash: string;
  derived_from_definition_id: string | null;
  derived_from_version: number | null;
  visibility: WorkflowDefinitionVisibility;
  published_at: string | null;
  published_by: string | null;
  provenance_jsonb: Record<string, unknown>;
  created_at: string;
}

/** Per-tenant evaluator mode (flag decided in Slice 0.5-4 / implemented in S1.4). */
export type WorkflowEnforcementMode = "off" | "advisory" | "enforcing";
