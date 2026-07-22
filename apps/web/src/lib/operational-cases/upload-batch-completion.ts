/**
 * Shared upload-batch completion: documents or photos, decided by current_step.
 * Channel-agnostic handler used by text «listo», Telegram button, and web inbox.
 */
import {
  createServerClient,
  getOperationalCase,
  listOperationalCaseDocuments,
} from "@agents/db";
import type { OperationalCase } from "@agents/types";
import { operationalCaseDocumentRequestTargetFromContext } from "@agents/types";
import {
  completeDocumentBatchForCase,
  DOCUMENTS_UPLOAD_REQUESTED_NOTIFICATION_KIND,
  type DocumentBatchCompletionStatus,
} from "./document-batch-completion";
import {
  completePhotoBatchForCase,
  countRawPhotos,
  photosBatchAdvancedAckText,
  photosBatchInsufficientAckText,
  RAW_PHOTOS_MIN_COUNT,
  type PhotoBatchCompletionStatus,
} from "./photo-batch-completion";
import { resolvePropertyDisplayLabel } from "./property-display-label";

type DbClient = ReturnType<typeof createServerClient>;

export { DOCUMENTS_UPLOAD_REQUESTED_NOTIFICATION_KIND };
export const UPLOAD_BATCH_CONFIRMATION_PURPOSE = "upload_batch_confirmation";
export const UPLOAD_BATCH_DONE_CALLBACK_PREFIX = "upload_done:";

export type UploadBatchKind = "documents" | "photos";

export type UploadBatchCompletionStatus =
  | "advanced"
  | "already_advanced"
  | "insufficient"
  | "no_files"
  | "wrong_step"
  | "failed";

export interface UploadBatchCompletionResult {
  status: UploadBatchCompletionStatus;
  batchKind: UploadBatchKind | null;
  case: OperationalCase;
  fileCount: number;
  minimumRequired: number | null;
  ackText: string;
}

function documentsAckText(status: DocumentBatchCompletionStatus): string {
  if (status === "no_documents") {
    return "Aún no veo documentos registrados en el caso. Sube al menos uno y luego escribe “listo”.";
  }
  if (status === "failed") {
    return "Registré tu confirmación, pero no pude avanzar el caso en este momento. Intenta de nuevo en unos segundos.";
  }
  // advanced | already_advanced
  return "Gracias, ya registré que terminaste de enviar documentos. Voy a procesarlos y te aviso el siguiente paso.";
}

function mapDocumentStatus(
  status: DocumentBatchCompletionStatus
): UploadBatchCompletionStatus {
  if (status === "no_documents") return "no_files";
  if (status === "already_advanced") return "already_advanced";
  if (status === "failed") return "failed";
  return "advanced";
}

function mapPhotoStatus(
  status: PhotoBatchCompletionStatus
): UploadBatchCompletionStatus {
  if (status === "no_photos") return "no_files";
  if (status === "insufficient_photos") return "insufficient";
  if (status === "already_advanced") return "already_advanced";
  if (status === "wrong_step") return "wrong_step";
  if (status === "failed") return "failed";
  return "advanced";
}

export function resolveUploadBatchKind(
  opCase: OperationalCase | null | undefined
): UploadBatchKind | null {
  if (!opCase) return null;
  if (opCase.current_step === "photos_requested") return "photos";
  if (
    (opCase.current_step === "awaiting_documents" ||
      opCase.current_step === "documents_received") &&
    operationalCaseDocumentRequestTargetFromContext(opCase.context_jsonb) ===
      "internal_user"
  ) {
    return "documents";
  }
  return null;
}

export async function completeUploadBatch(params: {
  db: DbClient;
  caseId: string;
  channel: "web" | "telegram";
  source: string;
}): Promise<UploadBatchCompletionResult> {
  const current = await getOperationalCase(params.db, params.caseId);
  if (!current) {
    throw new Error("case_not_found");
  }
  const batchKind = resolveUploadBatchKind(current);
  if (!batchKind) {
    return {
      status: "wrong_step",
      batchKind: null,
      case: current,
      fileCount: 0,
      minimumRequired: null,
      ackText:
        "Este caso no está esperando confirmación de carga de documentos o fotos.",
    };
  }

  if (batchKind === "photos") {
    const completion = await completePhotoBatchForCase({
      db: params.db,
      caseId: params.caseId,
      channel: params.channel,
      source: params.source,
    });
    const status = mapPhotoStatus(completion.status);
    let ackText: string;
    if (status === "insufficient" || status === "no_files") {
      ackText = photosBatchInsufficientAckText(completion.photoCount);
    } else if (status === "failed") {
      ackText =
        "Registré tu confirmación, pero no pude avanzar el caso en este momento. Intenta de nuevo en unos segundos.";
    } else if (status === "wrong_step") {
      ackText =
        "Este caso no está esperando confirmación de carga de documentos o fotos.";
    } else {
      ackText = photosBatchAdvancedAckText(completion.photoCount);
    }
    return {
      status,
      batchKind: "photos",
      case: completion.case,
      fileCount: completion.photoCount,
      minimumRequired: RAW_PHOTOS_MIN_COUNT,
      ackText,
    };
  }

  const completion = await completeDocumentBatchForCase({
    db: params.db,
    caseId: params.caseId,
    channel: params.channel,
    source: params.source,
  });
  return {
    status: mapDocumentStatus(completion.status),
    batchKind: "documents",
    case: completion.case,
    fileCount: completion.documentCount,
    minimumRequired: 1,
    ackText: documentsAckText(completion.status),
  };
}

export async function countCaseUploadFiles(params: {
  db: DbClient;
  opCase: OperationalCase;
  batchKind: UploadBatchKind;
}): Promise<number> {
  if (params.batchKind === "photos") {
    return countRawPhotos(params.opCase.context_jsonb);
  }
  const docs = await listOperationalCaseDocuments(params.db, {
    caseId: params.opCase.id,
    statuses: ["received"],
  });
  return docs.length;
}

/** Copy for cron / inbox reminder when advisor uploaded but did not confirm. */
export function formatUploadBatchConfirmationReminderText(params: {
  batchKind: UploadBatchKind;
  fileCount: number;
  context: Record<string, unknown> | null | undefined;
}): string {
  const label = resolvePropertyDisplayLabel(params.context);
  if (params.batchKind === "documents") {
    return [
      `Registré los documentos que enviaste para **${label}**, pero aún necesito tu confirmación para revisarlos.`,
      "",
      "Pulsa **Terminé de subir** o responde **«listo»**.",
    ].join("\n");
  }
  if (params.fileCount < RAW_PHOTOS_MIN_COUNT) {
    return [
      `Registré ${params.fileCount} de las ${RAW_PHOTOS_MIN_COUNT} fotos mínimas de **${label}**.`,
      "",
      "Cuando completes la carga, pulsa **Terminé de subir** o responde **«listo»**.",
    ].join("\n");
  }
  return [
    `Registré ${params.fileCount} fotos de **${label}**. Para avanzar necesito que confirmes que terminaste.`,
    "",
    "Pulsa **Terminé de subir** o responde **«listo»**.",
  ].join("\n");
}

export function isUploadBatchNotificationKind(kind: string | null | undefined): boolean {
  return (
    kind === "photos_upload_requested" ||
    kind === DOCUMENTS_UPLOAD_REQUESTED_NOTIFICATION_KIND
  );
}

export function uploadBatchKindFromNotificationKind(
  kind: string | null | undefined
): UploadBatchKind | null {
  if (kind === "photos_upload_requested") return "photos";
  if (kind === DOCUMENTS_UPLOAD_REQUESTED_NOTIFICATION_KIND) return "documents";
  return null;
}
