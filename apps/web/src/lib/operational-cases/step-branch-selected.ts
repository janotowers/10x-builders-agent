/**
 * Audit trail de rama de paso (PATTERN_STEP_BRANCH_DECISION / Fase E).
 * Módulo separado para evitar ciclos document-request-target ↔ external-contact-link.
 */

import {
  getRecentOperationalCaseEvents,
  insertOperationalCaseEvent,
  type DbClient,
} from "@agents/db";
import type { OperationalCaseDocumentRequestTarget } from "@agents/types";

export const STEP_BRANCH_DECISION_ID_DOCUMENT_REQUEST = "document_request_target";

export type StepBranchDecidedBy =
  | "default"
  | "user"
  | "agent"
  | "test"
  | "inferred";

type EventLike = {
  event_type: string;
  payload_jsonb?: unknown;
};

/** Predicado puro para idempotencia (testeable sin DB). */
export function eventsIncludeStepBranchSelected(
  events: EventLike[],
  params: { decisionId: string; branchValue: string }
): boolean {
  return events.some((event) => {
    if (event.event_type !== "human_decision") return false;
    const payload = event.payload_jsonb;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return false;
    }
    const p = payload as Record<string, unknown>;
    return (
      p.kind === "step_branch_selected" &&
      p.decision_id === params.decisionId &&
      p.branch_value === params.branchValue
    );
  });
}

/**
 * Idempotente: no duplica si ya hay human_decision step_branch_selected
 * con el mismo decision_id + branch_value en eventos recientes.
 */
export async function recordStepBranchSelected(params: {
  db: DbClient;
  caseId: string;
  stepKey?: string | null;
  decisionId?: string;
  branchValue: OperationalCaseDocumentRequestTarget | string;
  decidedBy: StepBranchDecidedBy;
  previousValue?: string | null;
  actor?: "system" | "user" | "agent";
  reason?: string;
  source?: string;
}): Promise<boolean> {
  const decisionId = params.decisionId ?? STEP_BRANCH_DECISION_ID_DOCUMENT_REQUEST;
  const recent = await getRecentOperationalCaseEvents(params.db, params.caseId, 20);
  if (
    eventsIncludeStepBranchSelected(recent, {
      decisionId,
      branchValue: String(params.branchValue),
    })
  ) {
    return false;
  }

  const actor =
    params.actor ??
    (params.decidedBy === "user" ? "user" : "system");

  await insertOperationalCaseEvent(params.db, {
    caseId: params.caseId,
    eventType: "human_decision",
    actor,
    stepKey: params.stepKey ?? "awaiting_documents",
    payload: {
      kind: "step_branch_selected",
      decision_id: decisionId,
      branch_value: params.branchValue,
      decided_by: params.decidedBy,
      ...(params.previousValue != null
        ? { previous_value: params.previousValue }
        : {}),
      ...(params.reason ? { reason: params.reason } : {}),
      ...(params.source ? { source: params.source } : {}),
      step_key: params.stepKey ?? "awaiting_documents",
    },
  });
  return true;
}
