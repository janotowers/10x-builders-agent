/**
 * Generic Case-to-Case relationships and lineage (ADR-109 / Technical Plan TD-7).
 *
 * Cross-domain on purpose: this is a shared-kernel primitive, not a Relationship
 * Operations table. Edges are Organization-contained (ADR-109 §9) and are ended
 * rather than deleted so lineage stays reconstructible. Relationship mutations
 * never modify either Case row (ADR-109 §4).
 */

/**
 * R1 vocabulary. Directed except `transaction_association`, which is a
 * non-destructive business association: recognizing a Transaction boundary does
 * not close or supersede the Opportunity, which stays open alongside it.
 *
 * Mirrors the CHECK constraint in the case_relationships migration.
 */
export type CaseRelationshipType =
  | "duplicate_of"
  | "superseded_by"
  | "split_from"
  | "transaction_association";

export const CASE_RELATIONSHIP_TYPES: readonly CaseRelationshipType[] = [
  "duplicate_of",
  "superseded_by",
  "split_from",
  "transaction_association",
] as const;

/** Lineage-bearing types, as distinct from business association. */
export const LINEAGE_RELATIONSHIP_TYPES: readonly CaseRelationshipType[] = [
  "duplicate_of",
  "superseded_by",
  "split_from",
] as const;

export type CaseRelationshipStatus = "active" | "ended";

export type CaseRelationshipActorKind = "human" | "agent" | "system";

export interface CaseRelationship {
  id: string;
  organization_id: string;
  from_case_id: string;
  to_case_id: string;
  relationship_type: CaseRelationshipType;
  status: CaseRelationshipStatus;
  created_by_user_id: string | null;
  actor_kind: CaseRelationshipActorKind;
  reason: string | null;
  evidence_refs_jsonb: Record<string, unknown>;
  provenance_jsonb: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  ended_at: string | null;
}
