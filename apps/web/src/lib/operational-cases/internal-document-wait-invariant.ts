import { updateOperationalCase, type DbClient } from "@agents/db";
import type { OperationalCase } from "@agents/types";

/**
 * Internal document collection is event-driven: the advisor uploads a file or
 * replies "listo". While waiting, the cron must not poll/re-run the agent,
 * otherwise it repeats the same request and may create fresh technical HITL.
 */
export function isInternalDocumentEventDrivenWait(
  opCase: OperationalCase | null | undefined
): boolean {
  return Boolean(
    opCase &&
      opCase.current_step === "awaiting_documents" &&
      opCase.status === "waiting_internal" &&
      opCase.context_jsonb?.document_request_target === "internal_user"
  );
}

export function shouldClearInternalDocumentWaitSchedule(
  opCase: OperationalCase | null | undefined
): boolean {
  return Boolean(
    isInternalDocumentEventDrivenWait(opCase) && opCase?.next_action_at
  );
}

export async function stabilizeInternalDocumentWait(
  db: DbClient,
  opCase: OperationalCase | null
): Promise<OperationalCase | null> {
  if (!opCase || !shouldClearInternalDocumentWaitSchedule(opCase)) return opCase;
  return (
    (await updateOperationalCase(db, opCase.id, opCase.version, {
      nextActionAt: null,
    })) ?? opCase
  );
}
