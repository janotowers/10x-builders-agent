import { updateOperationalCase, type DbClient } from "@agents/db";
import type { OperationalCase } from "@agents/types";

/** Internal document collection is event-driven. */
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

/**
 * Todos los lotes internos son event-driven: el asesor sube archivos o
 * responde "listo". El cron no debe re-ejecutar al agente mientras espera;
 * hacerlo repite la solicitud. Fotos usa la misma frontera determinística.
 */
export function isInternalUploadEventDrivenWait(
  opCase: OperationalCase | null | undefined
): boolean {
  return Boolean(
    opCase &&
      opCase.status === "waiting_internal" &&
      (isInternalDocumentEventDrivenWait(opCase) ||
        opCase.current_step === "photos_requested")
  );
}

export function shouldClearInternalDocumentWaitSchedule(
  opCase: OperationalCase | null | undefined
): boolean {
  return Boolean(
    isInternalUploadEventDrivenWait(opCase) && opCase?.next_action_at
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
