import { scrubEvidenceDetail } from "@agents/workflows";
import type { DbClient } from "../client";

// Slice 1.5: minimal evidence records (Technical Plan §13). Append-only
// (DB triggers); detail_jsonb always passes the secret scrubber here so the
// scrub cannot be bypassed by callers.

export type EvidenceSubjectKind =
  | "work_item_attempt"
  | "workflow_definition"
  | "case_artifact"
  | "release";

export interface EvidenceRecord {
  id: string;
  user_id: string;
  subject_kind: EvidenceSubjectKind;
  subject_id: string;
  gate: string;
  artifact_hash: string;
  result: "pass" | "fail";
  detail_jsonb: Record<string, unknown>;
  created_at: string;
}

export interface InsertEvidenceRecordInput {
  userId: string;
  subjectKind: EvidenceSubjectKind;
  subjectId: string;
  gate: string;
  artifactHash: string;
  result: "pass" | "fail";
  detail?: Record<string, unknown>;
}

export async function insertEvidenceRecord(
  db: DbClient,
  input: InsertEvidenceRecordInput
): Promise<EvidenceRecord> {
  const { data, error } = await db
    .from("evidence_records")
    .insert({
      user_id: input.userId,
      subject_kind: input.subjectKind,
      subject_id: input.subjectId,
      gate: input.gate,
      artifact_hash: input.artifactHash,
      result: input.result,
      detail_jsonb: scrubEvidenceDetail(input.detail ?? {}),
    })
    .select("*")
    .single();
  if (error) throw error;
  return data as EvidenceRecord;
}

/**
 * Atomic batch used by definition validation: one PostgREST statement avoids
 * partial gate evidence and eight sequential network/statement timeouts.
 */
export async function insertEvidenceRecords(
  db: DbClient,
  inputs: InsertEvidenceRecordInput[]
): Promise<EvidenceRecord[]> {
  if (inputs.length === 0) return [];
  const { data, error } = await db
    .from("evidence_records")
    .insert(
      inputs.map((input) => ({
        user_id: input.userId,
        subject_kind: input.subjectKind,
        subject_id: input.subjectId,
        gate: input.gate,
        artifact_hash: input.artifactHash,
        result: input.result,
        detail_jsonb: scrubEvidenceDetail(input.detail ?? {}),
      }))
    )
    .select("*");
  if (error) throw error;
  return (data ?? []) as EvidenceRecord[];
}

export async function listEvidenceForSubject(
  db: DbClient,
  params: {
    userId: string;
    subjectKind: EvidenceSubjectKind;
    subjectId: string;
    limit?: number;
  }
): Promise<EvidenceRecord[]> {
  const { data, error } = await db
    .from("evidence_records")
    .select("*")
    .eq("user_id", params.userId)
    .eq("subject_kind", params.subjectKind)
    .eq("subject_id", params.subjectId)
    .order("created_at", { ascending: false })
    .limit(Math.max(1, Math.min(params.limit ?? 50, 200)));
  if (error) throw error;
  return (data ?? []) as EvidenceRecord[];
}
