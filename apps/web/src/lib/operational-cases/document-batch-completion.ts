import {
  createServerClient,
  getOperationalCase,
  insertOperationalCaseEvent,
  listOperationalCaseDocuments,
  updateOperationalCase,
} from "@agents/db";
import type { OperationalCase } from "@agents/types";

type DbClient = ReturnType<typeof createServerClient>;

/**
 * Detecta si un mensaje del usuario/contacto señala que terminó de enviar el
 * lote de documentos ("listo", "ya está", etc.). Compartido entre web chat y
 * Telegram (y canales futuros) para que la detección sea idéntica en todos.
 */
export function looksLikeDocumentBatchComplete(value: string): boolean {
  const normalized = value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  return /^(listo|ya esta|ya estan|termine|termine todo|eso es todo|ya mande todo|ya te mande todo|documentos enviados)$/.test(
    normalized
  );
}

export type DocumentBatchCompletionStatus =
  | "advanced"
  | "already_advanced"
  | "no_documents"
  | "failed";

export interface DocumentBatchCompletionResult {
  status: DocumentBatchCompletionStatus;
  case: OperationalCase;
  documentCount: number;
}

const MAX_TRANSITION_ATTEMPTS = 4;

/**
 * Marca el lote de documentos como completo y mueve el caso a
 * `documents_received / waiting_internal` de forma robusta frente a
 * concurrencia (optimistic locking): re-lee la versión y reintenta si otro
 * proceso escribió encima (p. ej. varios documentos llegando casi al mismo
 * tiempo). Sólo avanza si hay al menos un documento recibido.
 *
 * Compartido entre canales (web chat, Telegram, futuros) para que la
 * transición y su confirmación sean idénticas. El caller decide si después
 * envía el ack y/o dispara el tick del agente usando el `case` devuelto, que
 * ya trae la versión fresca y correcta.
 */
export async function completeDocumentBatchForCase(params: {
  db: DbClient;
  caseId: string;
  channel: "web" | "telegram";
  source: string;
}): Promise<DocumentBatchCompletionResult> {
  const { db, caseId, channel, source } = params;

  let current = await getOperationalCase(db, caseId);
  if (!current) {
    throw new Error("case_not_found");
  }

  const docs = await listOperationalCaseDocuments(db, {
    caseId,
    statuses: ["received"],
  });
  if (docs.length === 0) {
    return { status: "no_documents", case: current, documentCount: 0 };
  }
  if (current.current_step === "documents_received") {
    return {
      status: "already_advanced",
      case: current,
      documentCount: docs.length,
    };
  }

  for (let attempt = 0; attempt < MAX_TRANSITION_ATTEMPTS; attempt += 1) {
    const fromStep = current.current_step ?? null;
    const updated = await updateOperationalCase(db, current.id, current.version, {
      status: "waiting_internal",
      currentStep: "documents_received",
      nextActionAt: new Date().toISOString(),
    });
    if (updated) {
      await insertOperationalCaseEvent(db, {
        caseId: updated.id,
        eventType: "state_changed",
        actor: "user",
        payload: {
          source,
          channel,
          kind: "documents_batch_completed",
          from_step: fromStep,
          to_step: "documents_received",
          document_count: docs.length,
        },
      });
      return { status: "advanced", case: updated, documentCount: docs.length };
    }

    const reread = await getOperationalCase(db, caseId);
    if (!reread) {
      throw new Error("case_not_found");
    }
    current = reread;
    if (current.current_step === "documents_received") {
      return {
        status: "already_advanced",
        case: current,
        documentCount: docs.length,
      };
    }
  }

  return { status: "failed", case: current, documentCount: docs.length };
}
