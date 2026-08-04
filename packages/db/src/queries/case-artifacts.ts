/**
 * Queries del plano de impacto: case_artifacts + artifact_inputs
 * (Slice 3.1; Technical Plan §11).
 *
 * Las aristas (artifact_inputs) son las dependencias DECLARADAS por la
 * metodología del workflow — el sistema nunca infiere dependencias por
 * nombre de campo. input_id apunta a case_facts.id / case_artifacts.id /
 * account_asset_versions.id según input_kind; no hay FK polimórfica, la
 * integridad la garantiza esta capa.
 */
import type { DbClient } from "../client";
import type {
  ArtifactInput,
  ArtifactInputKind,
  CaseArtifact,
  ImpactStatus,
} from "@agents/types";

export interface ArtifactInputSpec {
  kind: ArtifactInputKind;
  id: string;
}

export interface CreateCaseArtifactInput {
  userId: string;
  caseId: string;
  artifactType: string;
  content: Record<string, unknown>;
  inputHash: string;
  inputs: ArtifactInputSpec[];
  producedByWorkItemId?: string | null;
  /** Artefacto anterior que este reemplaza: se marca `superseded`. */
  supersedesArtifactId?: string | null;
}

export async function createCaseArtifact(
  db: DbClient,
  input: CreateCaseArtifactInput
): Promise<CaseArtifact> {
  const { data, error } = await db
    .from("case_artifacts")
    .insert({
      case_id: input.caseId,
      user_id: input.userId,
      artifact_type: input.artifactType,
      content_jsonb: input.content,
      input_hash: input.inputHash,
      status: "current",
      produced_by_work_item_id: input.producedByWorkItemId ?? null,
    })
    .select("*")
    .single();
  if (error) throw error;
  const artifact = data as CaseArtifact;

  for (const edge of input.inputs) {
    const { error: edgeError } = await db.from("artifact_inputs").insert({
      artifact_id: artifact.id,
      user_id: input.userId,
      input_kind: edge.kind,
      input_id: edge.id,
    });
    if (edgeError) throw edgeError;
  }

  if (input.supersedesArtifactId) {
    const prior = await getCaseArtifactById(
      db,
      input.userId,
      input.supersedesArtifactId
    );
    if (prior && prior.status !== "superseded") {
      await updateCaseArtifactStatus(db, {
        userId: input.userId,
        artifactId: prior.id,
        status: "superseded",
        expectedVersion: prior.version,
      });
    }
  }

  return artifact;
}

export async function getCaseArtifactById(
  db: DbClient,
  userId: string,
  artifactId: string
): Promise<CaseArtifact | null> {
  const { data, error } = await db
    .from("case_artifacts")
    .select("*")
    .eq("user_id", userId)
    .eq("id", artifactId)
    .maybeSingle();
  if (error) throw error;
  return (data as CaseArtifact | null) ?? null;
}

export interface ListCaseArtifactsOptions {
  artifactType?: string;
  statuses?: ImpactStatus[];
}

export async function listCaseArtifactsForCase(
  db: DbClient,
  userId: string,
  caseId: string,
  opts: ListCaseArtifactsOptions = {}
): Promise<CaseArtifact[]> {
  let query = db
    .from("case_artifacts")
    .select("*")
    .eq("user_id", userId)
    .eq("case_id", caseId)
    .order("created_at", { ascending: false });
  if (opts.artifactType) query = query.eq("artifact_type", opts.artifactType);
  if (opts.statuses && opts.statuses.length > 0) {
    query = query.in("status", opts.statuses);
  }
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as CaseArtifact[];
}

export async function listArtifactInputs(
  db: DbClient,
  userId: string,
  artifactId: string
): Promise<ArtifactInput[]> {
  const { data, error } = await db
    .from("artifact_inputs")
    .select("*")
    .eq("user_id", userId)
    .eq("artifact_id", artifactId);
  if (error) throw error;
  return (data ?? []) as ArtifactInput[];
}

/**
 * Lookup inverso del motor de impacto (Slice 3.2): entrada cambiada →
 * artefactos que la declararon. Un artefacto sin aristas jamás aparece aquí
 * (guardia contra sobre-invalidación).
 */
export async function listArtifactsDependingOnInput(
  db: DbClient,
  userId: string,
  inputId: string,
  opts: { inputKind?: ArtifactInputKind } = {}
): Promise<CaseArtifact[]> {
  let edgeQuery = db
    .from("artifact_inputs")
    .select("*")
    .eq("user_id", userId)
    .eq("input_id", inputId);
  if (opts.inputKind) edgeQuery = edgeQuery.eq("input_kind", opts.inputKind);
  const { data: edgeData, error: edgeError } = await edgeQuery;
  if (edgeError) throw edgeError;
  const artifactIds = [
    ...new Set(
      ((edgeData ?? []) as ArtifactInput[]).map((edge) => edge.artifact_id)
    ),
  ];
  if (artifactIds.length === 0) return [];

  const { data, error } = await db
    .from("case_artifacts")
    .select("*")
    .eq("user_id", userId)
    .in("id", artifactIds);
  if (error) throw error;
  return (data ?? []) as CaseArtifact[];
}

export interface UpdateCaseArtifactStatusInput {
  userId: string;
  artifactId: string;
  status: ImpactStatus;
  /** CAS de optimistic locking (mismo patrón que operational_cases). */
  expectedVersion: number;
}

export interface CaseImpactSummary {
  caseId: string;
  staleArtifacts: number;
  invalidArtifacts: number;
  suspendedApprovals: number;
}

/**
 * Conteos por caso para los indicadores de la case view (Slice 3.5-2):
 * artefactos desactualizados/invalidados + aprobaciones suspendidas vigentes.
 * Solo números — el wording broker-safe vive en la capa de UI.
 */
export async function summarizeCaseImpact(
  db: DbClient,
  userId: string,
  caseIds: string[]
): Promise<Map<string, CaseImpactSummary>> {
  const result = new Map<string, CaseImpactSummary>();
  if (caseIds.length === 0) return result;
  const ensure = (caseId: string): CaseImpactSummary => {
    let entry = result.get(caseId);
    if (!entry) {
      entry = {
        caseId,
        staleArtifacts: 0,
        invalidArtifacts: 0,
        suspendedApprovals: 0,
      };
      result.set(caseId, entry);
    }
    return entry;
  };

  const { data: artifactData, error: artifactError } = await db
    .from("case_artifacts")
    .select("case_id, status")
    .eq("user_id", userId)
    .in("case_id", caseIds)
    .in("status", ["stale", "invalid"]);
  if (artifactError) throw artifactError;
  for (const row of (artifactData ?? []) as Array<{
    case_id: string;
    status: string;
  }>) {
    const entry = ensure(row.case_id);
    if (row.status === "stale") entry.staleArtifacts += 1;
    else entry.invalidArtifacts += 1;
  }

  const { data: approvalData, error: approvalError } = await db
    .from("case_approvals")
    .select("case_id")
    .eq("user_id", userId)
    .in("case_id", caseIds)
    .eq("decision", "suspended")
    .is("superseded_by", null);
  if (approvalError) throw approvalError;
  for (const row of (approvalData ?? []) as Array<{ case_id: string }>) {
    ensure(row.case_id).suspendedApprovals += 1;
  }

  return result;
}

/**
 * Flip de estado guardado por versión. Devuelve null si el CAS pierde
 * (otro actor movió el artefacto primero) — el caller relee y decide.
 */
export async function updateCaseArtifactStatus(
  db: DbClient,
  input: UpdateCaseArtifactStatusInput
): Promise<CaseArtifact | null> {
  const { data, error } = await db
    .from("case_artifacts")
    .update({
      status: input.status,
      version: input.expectedVersion + 1,
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.artifactId)
    .eq("user_id", input.userId)
    .eq("version", input.expectedVersion)
    .select("*");
  if (error) throw error;
  const rows = (data ?? []) as CaseArtifact[];
  return rows.length === 1 ? rows[0] : null;
}
