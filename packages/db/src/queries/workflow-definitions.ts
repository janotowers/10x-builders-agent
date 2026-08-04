import type {
  WorkflowDefinition,
  WorkflowDefinitionStatus,
  WorkflowGraph,
} from "@agents/types";
import type { DbClient } from "../client";

// Slice 1.1: workflow-definition queries. Published definitions are immutable
// (DB trigger enforces it); customization is by explicit fork with lineage.
// Every tenant-scoped read takes a required userId.

export async function getWorkflowDefinitionById(
  db: DbClient,
  definitionId: string
): Promise<WorkflowDefinition | null> {
  const { data, error } = await db
    .from("workflow_definitions")
    .select("*")
    .eq("id", definitionId)
    .maybeSingle();
  if (error) throw error;
  return (data as WorkflowDefinition) ?? null;
}

/**
 * Fetch a definition by id asserting the expected version (evidence and case
 * pins carry both; a mismatch means the caller's pin is corrupt).
 */
export async function getPublishedDefinition(
  db: DbClient,
  definitionId: string,
  version: number
): Promise<WorkflowDefinition | null> {
  const definition = await getWorkflowDefinitionById(db, definitionId);
  if (!definition) return null;
  if (definition.version !== version) return null;
  return definition;
}

/**
 * Resolution order when starting a case (Technical Plan §5.1.1): the user's
 * latest published private definition for the case type, else the latest
 * published global.
 */
export async function getLatestPublishedDefinitionForUser(
  db: DbClient,
  userId: string,
  caseType: string
): Promise<WorkflowDefinition | null> {
  const { data: privateRows, error: privateError } = await db
    .from("workflow_definitions")
    .select("*")
    .eq("user_id", userId)
    .eq("case_type", caseType)
    .eq("status", "published")
    .order("version", { ascending: false })
    .limit(1);
  if (privateError) throw privateError;
  if (privateRows && privateRows.length > 0) {
    return privateRows[0] as WorkflowDefinition;
  }
  const { data: globalRows, error: globalError } = await db
    .from("workflow_definitions")
    .select("*")
    .is("user_id", null)
    .eq("owner_scope", "global")
    .eq("case_type", caseType)
    .eq("status", "published")
    .order("version", { ascending: false })
    .limit(1);
  if (globalError) throw globalError;
  return (globalRows?.[0] as WorkflowDefinition) ?? null;
}

export interface InsertDraftDefinitionInput {
  userId: string | null;
  caseType: string;
  workflowKey?: string;
  version: number;
  industry?: string | null;
  domainTags?: string[];
  graph: WorkflowGraph;
  definitionHash: string;
  derivedFromDefinitionId?: string | null;
  derivedFromVersion?: number | null;
  businessSpec?: Record<string, unknown>;
  implementationSpec?: Record<string, unknown>;
  provenance?: Record<string, unknown>;
}

export async function insertDraftDefinition(
  db: DbClient,
  input: InsertDraftDefinitionInput
): Promise<WorkflowDefinition> {
  const { data, error } = await db
    .from("workflow_definitions")
    .insert({
      owner_scope: input.userId ? "user" : "global",
      user_id: input.userId,
      case_type: input.caseType,
      workflow_key: input.workflowKey ?? input.caseType,
      version: input.version,
      status: "draft" satisfies WorkflowDefinitionStatus,
      industry: input.industry ?? null,
      domain_tags: input.domainTags ?? [],
      business_spec_jsonb: input.businessSpec ?? {},
      implementation_spec_jsonb: input.implementationSpec ?? {},
      graph_jsonb: input.graph,
      definition_hash: input.definitionHash,
      derived_from_definition_id: input.derivedFromDefinitionId ?? null,
      derived_from_version: input.derivedFromVersion ?? null,
      provenance_jsonb: input.provenance ?? {},
    })
    .select("*")
    .single();
  if (error) throw error;
  return data as WorkflowDefinition;
}

/**
 * Explicit fork (§5.1.1): copies graph/specs from the source definition into a
 * private draft v1 for the user, recording lineage. Forks never auto-adopt
 * later versions of the source.
 */
export async function forkDefinition(
  db: DbClient,
  userId: string,
  sourceDefinitionId: string
): Promise<WorkflowDefinition> {
  const source = await getWorkflowDefinitionById(db, sourceDefinitionId);
  if (!source) throw new Error(`workflow definition ${sourceDefinitionId} not found`);
  if (source.status !== "published") {
    throw new Error("only published definitions can be forked");
  }
  const { data: existing, error: existingError } = await db
    .from("workflow_definitions")
    .select("version")
    .eq("user_id", userId)
    .eq("case_type", source.case_type)
    .order("version", { ascending: false })
    .limit(1);
  if (existingError) throw existingError;
  const nextVersion = ((existing?.[0]?.version as number | undefined) ?? 0) + 1;
  return insertDraftDefinition(db, {
    userId,
    caseType: source.case_type,
    workflowKey: source.workflow_key,
    version: nextVersion,
    industry: source.industry,
    domainTags: source.domain_tags,
    graph: source.graph_jsonb,
    definitionHash: source.definition_hash,
    derivedFromDefinitionId: source.id,
    derivedFromVersion: source.version,
    businessSpec: source.business_spec_jsonb,
    implementationSpec: source.implementation_spec_jsonb,
    provenance: {
      forked_from: source.id,
      forked_from_version: source.version,
      forked_at: new Date().toISOString(),
    },
  });
}

/**
 * Flip draft → validated (Slice 4.2-2): se llama SOLO después de que todos
 * los gates §5.4 + simulación pasaron y su evidencia quedó registrada. El
 * flip es informativo (la publicación re-corre los gates de todos modos).
 */
export async function markDefinitionValidated(
  db: DbClient,
  definitionId: string
): Promise<WorkflowDefinition> {
  const { data, error } = await db
    .from("workflow_definitions")
    .update({ status: "validated" satisfies WorkflowDefinitionStatus })
    .eq("id", definitionId)
    .eq("status", "draft")
    .select("*")
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new Error(
      `workflow definition ${definitionId} not in draft (cannot mark validated)`
    );
  }
  return data as WorkflowDefinition;
}

/**
 * Descarta un borrador/validado propio. Published/deprecated quedan
 * protegidos por el trigger SQL de DELETE; este filtro evita incluso
 * intentar el borrado.
 */
export async function deleteDraftDefinition(
  db: DbClient,
  input: { userId: string; definitionId: string }
): Promise<void> {
  const { data, error } = await db
    .from("workflow_definitions")
    .delete()
    .eq("id", input.definitionId)
    .eq("user_id", input.userId)
    .in("status", ["draft", "validated"])
    .select("id")
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new Error(
      `workflow definition ${input.definitionId} not deletable (missing, not owned, or not draft/validated)`
    );
  }
}

/**
 * Publish a draft/validated definition. Immutability after publication is
 * enforced by the DB trigger; this only performs the status flip.
 */
export async function publishDefinition(
  db: DbClient,
  definitionId: string,
  publishedBy: string | null
): Promise<WorkflowDefinition> {
  const { data, error } = await db
    .from("workflow_definitions")
    .update({
      status: "published" satisfies WorkflowDefinitionStatus,
      published_at: new Date().toISOString(),
      published_by: publishedBy,
    })
    .eq("id", definitionId)
    .in("status", ["draft", "validated"])
    .select("*")
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new Error(
      `workflow definition ${definitionId} not publishable (missing or already published/deprecated)`
    );
  }
  return data as WorkflowDefinition;
}

/**
 * Catálogo del tenant (Slice 2.7-2/2.7-6): definiciones globales + las
 * privadas del usuario. JAMÁS expone privadas de otros tenants. No requiere
 * gate de admin: es lectura del propio tenant.
 */
export async function listWorkflowDefinitionsVisibleToUser(
  db: DbClient,
  userId: string
): Promise<WorkflowDefinition[]> {
  const { data: globals, error: globalError } = await db
    .from("workflow_definitions")
    .select("*")
    .is("user_id", null)
    .eq("owner_scope", "global")
    .order("case_type", { ascending: true })
    .order("version", { ascending: false });
  if (globalError) throw globalError;
  const { data: own, error: ownError } = await db
    .from("workflow_definitions")
    .select("*")
    .eq("user_id", userId)
    .order("case_type", { ascending: true })
    .order("version", { ascending: false });
  if (ownError) throw ownError;
  return [
    ...((own ?? []) as WorkflowDefinition[]),
    ...((globals ?? []) as WorkflowDefinition[]),
  ];
}

/** Admin-wide listing (caller must gate on is_ungga_admin). */
export async function listWorkflowDefinitionsForCaseType(
  db: DbClient,
  caseType: string
): Promise<WorkflowDefinition[]> {
  const { data, error } = await db
    .from("workflow_definitions")
    .select("*")
    .eq("case_type", caseType)
    .order("owner_scope", { ascending: true })
    .order("version", { ascending: false });
  if (error) throw error;
  return (data ?? []) as WorkflowDefinition[];
}
