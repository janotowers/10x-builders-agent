// Impact plane (flexible-workflows plan, Phase 3 / Slice 3.1;
// Technical Plan §11, analysis §7.3). Facts are append-only claims with
// provenance; artifacts pin the inputs they were computed from; approvals
// pin the evidence they were granted against.
//
// Scope guard (implementation-plan rule 13): only the four impact tables
// plus account_assets versioning. The §11 "additional classes" (knowledge
// artifact, executable artifact, situational software, turn artifact) have
// no types here.

/**
 * Shared status vocabulary of the impact plane (Technical Plan §11,
 * definitions in analysis §6.5 — keep distinct):
 *  - current: input hash still matches the declared inputs.
 *  - stale: a declared input changed (mechanical, computed by the engine).
 *  - suspended: mechanically withheld (approvals: evidence_hash mismatch).
 *    Never an automatic revocation — that is a human business act.
 *  - invalid: failed verification.
 *  - superseded: replaced by a newer row.
 */
export const IMPACT_STATUSES = [
  "current",
  "stale",
  "suspended",
  "invalid",
  "superseded",
] as const;

export type ImpactStatus = (typeof IMPACT_STATUSES)[number];

export const CASE_FACT_SOURCE_KINDS = [
  "user",
  "external_contact",
  "document",
  "integration",
  "derived",
] as const;

export type CaseFactSourceKind = (typeof CASE_FACT_SOURCE_KINDS)[number];

export const CASE_APPROVAL_DECISIONS = [
  "approved",
  "rejected",
  "suspended",
  "revoked",
] as const;

export type CaseApprovalDecision = (typeof CASE_APPROVAL_DECISIONS)[number];

/**
 * Edge kinds of artifact_inputs. `account_asset` (finding 16): templates and
 * watermarks are inputs of generated artifacts and are neither facts nor
 * artifacts; the edge's input_id references the consumed
 * account_asset_versions row (pinned version), never the mutable asset.
 */
export const ARTIFACT_INPUT_KINDS = ["fact", "artifact", "account_asset"] as const;

export type ArtifactInputKind = (typeof ARTIFACT_INPUT_KINDS)[number];

/**
 * Append-only commercial fact with provenance. A correction never updates
 * value_jsonb in place: it inserts a new row and points the prior row's
 * `superseded_by` at it (the only mutation the DB trigger allows).
 */
export interface CaseFact {
  id: string;
  case_id: string;
  user_id: string;
  fact_key: string;
  value_jsonb: unknown;
  source_kind: CaseFactSourceKind;
  source_ref: string | null;
  confidence: number | null;
  superseded_by: string | null;
  recorded_at: string;
}

export interface CaseArtifact {
  id: string;
  case_id: string;
  user_id: string;
  artifact_type: string;
  content_jsonb: Record<string, unknown>;
  /**
   * Canonical hash over the consumed inputs (Slice 3.2 generalizes
   * property-identity-signature.ts). For account_asset inputs it is computed
   * over the consumed version's content_hash.
   */
  input_hash: string;
  status: ImpactStatus;
  produced_by_work_item_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface ArtifactInput {
  artifact_id: string;
  user_id: string;
  input_kind: ArtifactInputKind;
  /** case_facts.id | case_artifacts.id | account_asset_versions.id per kind. */
  input_id: string;
  created_at: string;
}

/**
 * Approval pinned to the evidence it saw. evidence_hash mismatch →
 * `suspended` (mechanical, Slice 3.2); re-approval inserts a new row that
 * supersedes the prior one (Slice 3.3). `revoked` is a human business act.
 */
export interface CaseApproval {
  id: string;
  case_id: string;
  user_id: string;
  approval_kind: string;
  decision: CaseApprovalDecision;
  decided_by: string | null;
  decided_at: string;
  evidence_hash: string;
  evidence_snapshot_jsonb: Record<string, unknown>;
  superseded_by: string | null;
  rationale: string | null;
}

/**
 * Immutable per-replacement record of an account asset (Technical Plan §11,
 * finding 16). Replacing an asset creates the next version; nothing rewrites
 * the version an existing artifact's input_hash was computed from.
 * content_hash is null only for pre-backfill version-1 rows.
 */
export interface AccountAssetVersion {
  id: string;
  account_asset_id: string;
  user_id: string;
  version_number: number;
  asset_key: string;
  content_hash: string | null;
  storage_bucket: string;
  storage_path: string;
  content_type: string | null;
  file_size_bytes: number | null;
  created_at: string;
}
