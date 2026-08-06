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
import { REQUIRED_PROPERTY_DOCUMENTS } from "./case-document-collection";
import {
  completeDocumentBatchForCase,
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
import {
  DOCUMENTS_UPLOAD_REQUESTED_NOTIFICATION_KIND,
  isUploadBatchNotificationKind,
  PHOTOS_UPLOAD_REQUESTED_NOTIFICATION_KIND,
  UPLOAD_BATCH_CONFIRMATION_PURPOSE,
  UPLOAD_BATCH_DONE_CALLBACK_PREFIX,
  uploadBatchKindFromNotificationKind,
} from "./upload-batch-shared";

type DbClient = ReturnType<typeof createServerClient>;

export {
  DOCUMENTS_UPLOAD_REQUESTED_NOTIFICATION_KIND,
  isUploadBatchNotificationKind,
  PHOTOS_UPLOAD_REQUESTED_NOTIFICATION_KIND,
  UPLOAD_BATCH_CONFIRMATION_PURPOSE,
  UPLOAD_BATCH_DONE_CALLBACK_PREFIX,
  uploadBatchKindFromNotificationKind,
};

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

/** Map a classified document kind onto a checklist key (if any). */
export function checklistKeyForDocumentKind(
  kind: string | null | undefined
): string | null {
  if (!kind) return null;
  const normalized = kind.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "boleta_registral" || normalized.includes("boleta")) {
    return "boleta_registral";
  }
  if (normalized.startsWith("escritura") || normalized.includes("escritura")) {
    return "escritura_descripcion";
  }
  if (normalized === "predial" || normalized.includes("predial")) {
    return "predial";
  }
  if (
    normalized === "ine" ||
    normalized.startsWith("ine_") ||
    normalized.includes("identificacion") ||
    normalized.includes("pasaporte")
  ) {
    return "ine";
  }
  if (
    normalized === "comprobante_domicilio" ||
    normalized.includes("comprobante_domicilio") ||
    normalized.includes("domicilio")
  ) {
    return "comprobante_domicilio";
  }
  return null;
}

export function missingIdealDocumentLabels(params: {
  coveredKinds: Array<string | null | undefined>;
}): string[] {
  const covered = new Set(
    params.coveredKinds
      .map((kind) => checklistKeyForDocumentKind(kind))
      .filter((key): key is string => Boolean(key))
  );
  return REQUIRED_PROPERTY_DOCUMENTS.filter((doc) => !covered.has(doc.key)).map(
    (doc) => doc.label
  );
}

export function documentsAckText(params: {
  status: DocumentBatchCompletionStatus;
  propertyLabel?: string;
  missingIdealLabels?: string[];
}): string {
  if (params.status === "no_documents") {
    return "Aún no veo documentos registrados en el caso. Sube al menos uno y luego escribe “listo”.";
  }
  if (params.status === "failed") {
    return "Registré tu confirmación, pero no pude avanzar el caso en este momento. Intenta de nuevo en unos segundos.";
  }
  const label = params.propertyLabel?.trim() || "la propiedad";
  const lines = [
    `Gracias, ya registré que terminaste de enviar documentos de **${label}**. Voy a procesarlos y te aviso el siguiente paso.`,
  ];
  const missing = (params.missingIdealLabels ?? []).filter(Boolean);
  if (missing.length > 0) {
    lines.push("");
    lines.push("Documentos ideales aún no clasificados en el expediente:");
    for (const item of missing) {
      lines.push(`• ${item}`);
    }
    lines.push(
      "Si los tienes, puedes enviarlos después; no bloquean el procesamiento de lo recibido."
    );
  }
  return lines.join("\n");
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
  const docs = await listOperationalCaseDocuments(params.db, {
    caseId: params.caseId,
    statuses: ["received"],
  });
  const missingIdealLabels =
    completion.status === "advanced" || completion.status === "already_advanced"
      ? missingIdealDocumentLabels({
          coveredKinds: docs.map((doc) => doc.kind),
        })
      : [];
  return {
    status: mapDocumentStatus(completion.status),
    batchKind: "documents",
    case: completion.case,
    fileCount: completion.documentCount,
    minimumRequired: 1,
    ackText: documentsAckText({
      status: completion.status,
      propertyLabel: resolvePropertyDisplayLabel(completion.case.context_jsonb),
      missingIdealLabels,
    }),
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

