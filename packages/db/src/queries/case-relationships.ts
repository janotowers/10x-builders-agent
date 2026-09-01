import type {
  CaseRelationship,
  CaseRelationshipActorKind,
  CaseRelationshipType,
} from "@agents/types";
import type { DbClient } from "../client";

/**
 * Generic Case-to-Case relationships (ADR-109 / Technical Plan TD-7).
 *
 * ADR-109 §4: a relationship mutation NEVER touches either Case row. Nothing in
 * this module updates `operational_cases` — creating a `superseded_by` edge does
 * not close the superseded Case, and a `transaction_association` leaves the
 * Opportunity open alongside the Transaction. Lifecycle changes to a Case are a
 * separate, separately authorized decision.
 *
 * ADR-109 §9: edges are Organization-contained. The database enforces it with
 * composite foreign keys on both endpoints, so a cross-Organization edge cannot
 * be written even if a caller tries.
 *
 * ADR-109 §8: lineage mutations carry authority and evidence — actor, reason and
 * evidence references are recorded so the edge can be explained later.
 */

export async function createCaseRelationship(
  db: DbClient,
  params: {
    organizationId: string;
    fromCaseId: string;
    toCaseId: string;
    relationshipType: CaseRelationshipType;
    createdByUserId?: string | null;
    actorKind?: CaseRelationshipActorKind;
    reason?: string | null;
    evidenceRefs?: Record<string, unknown>;
    provenance?: Record<string, unknown>;
  }
): Promise<CaseRelationship> {
  if (params.fromCaseId === params.toCaseId) {
    throw new Error("createCaseRelationship: a Case cannot relate to itself");
  }
  const { data, error } = await db
    .from("case_relationships")
    .insert({
      organization_id: params.organizationId,
      from_case_id: params.fromCaseId,
      to_case_id: params.toCaseId,
      relationship_type: params.relationshipType,
      created_by_user_id: params.createdByUserId ?? null,
      actor_kind: params.actorKind ?? "human",
      reason: params.reason ?? null,
      evidence_refs_jsonb: params.evidenceRefs ?? {},
      provenance_jsonb: params.provenance ?? {},
    })
    .select("*")
    .single();
  if (error) throw error;
  return data as CaseRelationship;
}

/** Active edges where the Case is either endpoint. */
export async function listCaseRelationships(
  db: DbClient,
  params: {
    organizationId: string;
    caseId: string;
    includeEnded?: boolean;
  }
): Promise<CaseRelationship[]> {
  let query = db
    .from("case_relationships")
    .select("*")
    .eq("organization_id", params.organizationId)
    .or(`from_case_id.eq.${params.caseId},to_case_id.eq.${params.caseId}`);
  if (!params.includeEnded) query = query.eq("status", "active");
  const { data, error } = await query.order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as CaseRelationship[];
}

/**
 * Ends an edge instead of deleting it, so lineage stays reconstructible: the
 * fact that two Cases were once considered duplicates is itself evidence.
 */
export async function endCaseRelationship(
  db: DbClient,
  params: {
    organizationId: string;
    relationshipId: string;
    reason?: string | null;
  }
): Promise<CaseRelationship> {
  const now = new Date().toISOString();
  const { data, error } = await db
    .from("case_relationships")
    .update({
      status: "ended",
      ended_at: now,
      updated_at: now,
      ...(params.reason ? { reason: params.reason } : {}),
    })
    .eq("organization_id", params.organizationId)
    .eq("id", params.relationshipId)
    .eq("status", "active")
    .select("*")
    .single();
  if (error) throw error;
  return data as CaseRelationship;
}
