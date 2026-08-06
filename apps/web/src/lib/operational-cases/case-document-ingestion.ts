/**
 * Pipeline compartida de ingestión de documentos de caso operacional.
 *
 * Concentra la parte agnóstica de canal de recibir un documento para un caso:
 * inferir tipo, calcular hash, subir a storage y registrar la fila en
 * `operational_case_documents`. Originalmente vivía inline en el webhook de
 * Telegram; al compartirla, el chat web puede subir documentos al caso con la
 * MISMA pipeline (mismo bucket, misma clasificación, mismos invariantes).
 *
 * El módulo NO decide enrutamiento de conversación ni envía mensajes: sólo
 * recibe los bytes ya descargados y metadatos, y devuelve el documento creado.
 * Cada adapter (Telegram descarga del API de Telegram; web recibe el upload)
 * obtiene los bytes a su manera y luego llama a `ingestCaseDocument`.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  CASE_DOCUMENTS_BUCKET,
  createOperationalCaseDocument,
  createServerClient,
} from "@agents/db";
import type {
  OperationalCaseDocument,
  OperationalCaseDocumentSource,
} from "@agents/types";

type DbClient = ReturnType<typeof createServerClient>;

export function safeDocumentPathSegment(value: string): string {
  return (
    value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "file"
  );
}

export function documentExtensionFromPath(
  filePath: string,
  fallback = "bin"
): string {
  const ext = filePath.split(".").pop()?.toLowerCase();
  return ext && /^[a-z0-9]{1,8}$/.test(ext) ? ext : fallback;
}

/**
 * Clasifica el tipo de documento a partir del texto/caption y el nombre del
 * archivo. Determinístico y compartido para que web y Telegram clasifiquen
 * igual.
 */
export function inferCaseDocumentKind(params: {
  text?: string;
  fileName?: string;
}): string {
  const normalized = `${params.text ?? ""} ${params.fileName ?? ""}`
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  if (
    /boleta|boleta registral|folio real|registro publico|registral/.test(
      normalized
    )
  ) {
    return "boleta_registral";
  }
  if (
    /predial|impuesto predial|sup\.?\s*terr|sup\.?\s*const|cuenta predial/.test(
      normalized
    )
  )
    return "predial";
  if (
    /descripcion|descriptiva|metraje|superficie|escritura|testimonio|(?:^|[^a-z])esc(?:[^a-z]|$)|desdeesc/.test(
      normalized
    )
  ) {
    return "escritura_descripcion";
  }
  if (
    /\bine\b|identificacion|identidad|instituto\s+nacional\s+electoral|credencial\s+para\s+votar|credencial\s+de\s+elector/.test(
      normalized
    )
  )
    return "ine";
  if (
    /comprobante|domicilio|estado\s+de\s+cuenta|estado\s+cuenta|banco|bancario|bbva|banorte|santander|hsbc|banamex|citibanamex|scotiabank/.test(
      normalized
    )
  ) {
    return "comprobante_domicilio";
  }
  return "unknown";
}

export interface CaseDocumentPayload {
  document_id: string;
  kind: string;
  storage_bucket: string;
  storage_path: string;
  original_name: string;
  content_type: string;
  sha256: string;
}

export interface IngestedCaseDocument {
  document: OperationalCaseDocument;
  kind: string;
  sha256: string;
  payload: CaseDocumentPayload;
}

export interface IngestCaseDocumentInput {
  db: DbClient;
  caseId: string;
  userId: string;
  source: OperationalCaseDocumentSource;
  /** Nombre original del archivo (con o sin extensión). */
  fileName: string;
  contentType: string;
  bytes: Buffer;
  /** Texto/caption acompañante para clasificar el tipo de documento. */
  captionText?: string | null;
  /** Extensión a forzar (Telegram la deriva del file_path del API). */
  extension?: string;
  /** Extensión de respaldo si no se puede inferir del nombre. */
  fallbackExtension?: string;
  fileSizeBytes?: number | null;
  sourceMetadata?: Record<string, unknown>;
}

/**
 * Sube el archivo al bucket de documentos y registra la fila del caso. Devuelve
 * el documento creado y un `payload` compacto (para `associateExternalResponse`
 * o respuestas de API).
 */
export async function ingestCaseDocument(
  input: IngestCaseDocumentInput
): Promise<IngestedCaseDocument> {
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const kind = inferCaseDocumentKind({
    text: input.captionText ?? undefined,
    fileName: input.fileName,
  });
  const extension =
    input.extension ??
    documentExtensionFromPath(input.fileName, input.fallbackExtension ?? "bin");
  const baseName = safeDocumentPathSegment(
    input.fileName.replace(/\.[^.]+$/, "")
  );
  const storagePath = `${input.userId}/${input.caseId}/${randomUUID()}-${baseName}.${extension}`;

  const { error: uploadError } = await input.db.storage
    .from(CASE_DOCUMENTS_BUCKET)
    .upload(storagePath, input.bytes, {
      contentType: input.contentType,
      upsert: false,
    });
  if (uploadError) throw uploadError;

  const document = await createOperationalCaseDocument(input.db, {
    caseId: input.caseId,
    userId: input.userId,
    kind,
    displayName: kind === "unknown" ? null : kind,
    storagePath,
    originalName: input.fileName,
    contentType: input.contentType,
    fileSizeBytes: input.fileSizeBytes ?? input.bytes.byteLength,
    sha256,
    source: input.source,
    sourceMetadata: input.sourceMetadata ?? {},
    blocking: kind === "boleta_registral",
  });

  // Best-effort: pull «listo» confirmation nudge forward after each file.
  try {
    const { rescheduleUploadBatchConfirmationNudgeForCase } = await import(
      "./reschedule-upload-batch-nudge"
    );
    await rescheduleUploadBatchConfirmationNudgeForCase({
      db: input.db,
      caseId: input.caseId,
      userId: input.userId,
    });
  } catch (error) {
    console.warn(
      "[ingestCaseDocument] reschedule upload nudge failed:",
      error instanceof Error ? error.message : error
    );
  }

  return {
    document,
    kind: document.kind,
    sha256,
    payload: {
      document_id: document.id,
      kind: document.kind,
      storage_bucket: document.storage_bucket,
      storage_path: document.storage_path,
      original_name: input.fileName,
      content_type: input.contentType,
      sha256,
    },
  };
}

export interface IngestStagedCaseDocumentInput {
  db: DbClient;
  caseId: string;
  userId: string;
  source: OperationalCaseDocumentSource;
  fileName: string;
  contentType: string;
  sha256: string;
  sizeBytes: number;
  stagedBucket: string;
  stagedPath: string;
  /** Texto/caption acompañante para clasificar el tipo (texto extraído en staging). */
  captionText?: string | null;
  /** Kind ya inferido en staging; se recalcula si falta. */
  suggestedKind?: string | null;
  sourceMetadata?: Record<string, unknown>;
}

/**
 * Promueve un archivo ya subido a staging (`{userId}/chat-staging/…`) a la
 * ruta canónica del caso (`{userId}/{caseId}/…`) y registra la fila con la
 * misma lógica que `ingestCaseDocument`. Usado por el chat web tras resolver
 * el case_id al enviar el mensaje.
 */
export async function ingestStagedCaseDocument(
  input: IngestStagedCaseDocumentInput
): Promise<IngestedCaseDocument> {
  if (!input.stagedPath.startsWith(`${input.userId}/`)) {
    throw new Error("staged_path_not_owned_by_user");
  }

  const kind =
    (typeof input.suggestedKind === "string" && input.suggestedKind.trim()
      ? input.suggestedKind.trim()
      : null) ??
    inferCaseDocumentKind({
      text: input.captionText ?? undefined,
      fileName: input.fileName,
    });
  const extension = documentExtensionFromPath(input.fileName, "bin");
  const baseName = safeDocumentPathSegment(
    input.fileName.replace(/\.[^.]+$/, "")
  );
  const finalPath = `${input.userId}/${input.caseId}/${randomUUID()}-${baseName}.${extension}`;
  const bucket = input.stagedBucket || CASE_DOCUMENTS_BUCKET;

  const { error: moveError } = await input.db.storage
    .from(bucket)
    .move(input.stagedPath, finalPath);
  if (moveError) {
    // Fallback: copy + remove if move no está soportado / falla por path.
    const { error: copyError } = await input.db.storage
      .from(bucket)
      .copy(input.stagedPath, finalPath);
    if (copyError) throw moveError;
    await input.db.storage.from(bucket).remove([input.stagedPath]).catch(() => {
      // Best-effort cleanup of staging; the final object is what matters.
    });
  }

  const document = await createOperationalCaseDocument(input.db, {
    caseId: input.caseId,
    userId: input.userId,
    kind,
    displayName: kind === "unknown" ? null : kind,
    storageBucket: bucket,
    storagePath: finalPath,
    originalName: input.fileName,
    contentType: input.contentType,
    fileSizeBytes: input.sizeBytes,
    sha256: input.sha256,
    source: input.source,
    sourceMetadata: {
      ...(input.sourceMetadata ?? {}),
      staged_path: input.stagedPath,
    },
    blocking: kind === "boleta_registral",
  });

  try {
    const { rescheduleUploadBatchConfirmationNudgeForCase } = await import(
      "./reschedule-upload-batch-nudge"
    );
    await rescheduleUploadBatchConfirmationNudgeForCase({
      db: input.db,
      caseId: input.caseId,
      userId: input.userId,
    });
  } catch (error) {
    console.warn(
      "[ingestStagedCaseDocument] reschedule upload nudge failed:",
      error instanceof Error ? error.message : error
    );
  }

  return {
    document,
    kind: document.kind,
    sha256: input.sha256,
    payload: {
      document_id: document.id,
      kind: document.kind,
      storage_bucket: document.storage_bucket,
      storage_path: document.storage_path,
      original_name: input.fileName,
      content_type: input.contentType,
      sha256: input.sha256,
    },
  };
}
