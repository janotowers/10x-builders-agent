/**
 * Queries del plano de impacto: case_approvals (Slice 3.1; Technical Plan
 * §11).
 *
 * Una aprobación pinea la evidencia que vio (evidence_hash + snapshot).
 * Cuando la base cambia, el motor de impacto (Slice 3.2) la SUSPENDE — acto
 * mecánico reversible — y nunca la revoca automáticamente (revoked es un
 * acto de negocio humano). Re-aprobar inserta una fila nueva que reemplaza
 * la anterior vía superseded_by (Slice 3.3).
 */
import type { DbClient } from "../client";
import type { CaseApproval, CaseApprovalDecision } from "@agents/types";

export interface InsertCaseApprovalInput {
  userId: string;
  caseId: string;
  approvalKind: string;
  decision: Extract<CaseApprovalDecision, "approved" | "rejected" | "revoked">;
  evidenceHash: string;
  evidenceSnapshot: Record<string, unknown>;
  decidedBy?: string | null;
  rationale?: string | null;
  /** Aprobación anterior que esta decisión reemplaza (re-aprobación 3.3). */
  supersedesApprovalId?: string | null;
}

export interface InsertCaseApprovalResult {
  approval: CaseApproval;
  superseded: CaseApproval | null;
}

export async function insertCaseApproval(
  db: DbClient,
  input: InsertCaseApprovalInput
): Promise<InsertCaseApprovalResult> {
  const { data, error } = await db
    .from("case_approvals")
    .insert({
      case_id: input.caseId,
      user_id: input.userId,
      approval_kind: input.approvalKind,
      decision: input.decision,
      decided_by: input.decidedBy ?? null,
      evidence_hash: input.evidenceHash,
      evidence_snapshot_jsonb: input.evidenceSnapshot,
      rationale: input.rationale ?? null,
    })
    .select("*")
    .single();
  if (error) throw error;
  const approval = data as CaseApproval;

  let superseded: CaseApproval | null = null;
  if (input.supersedesApprovalId) {
    const { data: supersededData, error: supersedeError } = await db
      .from("case_approvals")
      .update({ superseded_by: approval.id })
      .eq("id", input.supersedesApprovalId)
      .eq("user_id", input.userId)
      .is("superseded_by", null)
      .select("*");
    if (supersedeError) throw supersedeError;
    const rows = (supersededData ?? []) as CaseApproval[];
    superseded = rows.length === 1 ? rows[0] : null;
  }

  return { approval, superseded };
}

export async function getCaseApprovalById(
  db: DbClient,
  userId: string,
  approvalId: string
): Promise<CaseApproval | null> {
  const { data, error } = await db
    .from("case_approvals")
    .select("*")
    .eq("user_id", userId)
    .eq("id", approvalId)
    .maybeSingle();
  if (error) throw error;
  return (data as CaseApproval | null) ?? null;
}

export async function listCaseApprovalsForCase(
  db: DbClient,
  userId: string,
  caseId: string,
  opts: { approvalKind?: string; includeSuperseded?: boolean } = {}
): Promise<CaseApproval[]> {
  let query = db
    .from("case_approvals")
    .select("*")
    .eq("user_id", userId)
    .eq("case_id", caseId)
    .order("decided_at", { ascending: false });
  if (opts.approvalKind) query = query.eq("approval_kind", opts.approvalKind);
  if (!opts.includeSuperseded) query = query.is("superseded_by", null);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as CaseApproval[];
}

/** Decisión vigente (no reemplazada) más reciente para una clase de aprobación. */
export async function getLatestCaseApproval(
  db: DbClient,
  userId: string,
  caseId: string,
  approvalKind: string
): Promise<CaseApproval | null> {
  const rows = await listCaseApprovalsForCase(db, userId, caseId, {
    approvalKind,
  });
  return rows[0] ?? null;
}

export interface SuspendCaseApprovalResult {
  approval: CaseApproval | null;
  /** false: la fila ya no estaba en `approved` (carrera u otro estado). */
  suspended: boolean;
}

/**
 * Suspensión mecánica (Slice 3.2): approved → suspended cuando el
 * evidence_hash ya no coincide con la base vigente. Guardada por decision
 * para que dos corridas del motor sean idempotentes. La re-aprobación NUNCA
 * pasa por aquí: requiere decisión humana e inserta fila nueva
 * (insertCaseApproval + supersedesApprovalId).
 */
export async function suspendCaseApproval(
  db: DbClient,
  input: { userId: string; approvalId: string }
): Promise<SuspendCaseApprovalResult> {
  const { data, error } = await db
    .from("case_approvals")
    .update({ decision: "suspended" })
    .eq("id", input.approvalId)
    .eq("user_id", input.userId)
    .eq("decision", "approved")
    .select("*");
  if (error) throw error;
  const rows = (data ?? []) as CaseApproval[];
  if (rows.length === 1) return { approval: rows[0], suspended: true };
  return {
    approval: await getCaseApprovalById(db, input.userId, input.approvalId),
    suspended: false,
  };
}
