import type { DbClient } from "../client";
import type {
  OperationalCaseDocument,
  OperationalCaseDocumentExtractionStatus,
  OperationalCaseDocumentSource,
  OperationalCaseDocumentStatus,
} from "@agents/types";

export const CASE_DOCUMENTS_BUCKET = "case-documents";

function isMissingOperationalCaseDocumentsTable(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const record = error as { code?: unknown; message?: unknown };
  return (
    record.code === "42P01" ||
    (typeof record.message === "string" &&
      record.message.includes("operational_case_documents"))
  );
}

export interface CreateOperationalCaseDocumentInput {
  caseId: string;
  userId: string;
  kind: string;
  displayName?: string | null;
  storageBucket?: string;
  storagePath: string;
  originalName?: string | null;
  contentType?: string | null;
  fileSizeBytes?: number | null;
  sha256?: string | null;
  source?: OperationalCaseDocumentSource;
  sourceMetadata?: Record<string, unknown>;
  blocking?: boolean;
  status?: OperationalCaseDocumentStatus;
  extractionStatus?: OperationalCaseDocumentExtractionStatus;
}

export async function createOperationalCaseDocument(
  db: DbClient,
  input: CreateOperationalCaseDocumentInput
): Promise<OperationalCaseDocument> {
  const { data, error } = await db
    .from("operational_case_documents")
    .insert({
      case_id: input.caseId,
      user_id: input.userId,
      kind: input.kind,
      display_name: input.displayName ?? null,
      storage_bucket: input.storageBucket ?? CASE_DOCUMENTS_BUCKET,
      storage_path: input.storagePath,
      original_name: input.originalName ?? null,
      content_type: input.contentType ?? null,
      file_size_bytes: input.fileSizeBytes ?? null,
      sha256: input.sha256 ?? null,
      source: input.source ?? "unknown",
      source_metadata_jsonb: input.sourceMetadata ?? {},
      blocking: input.blocking ?? false,
      status: input.status ?? "received",
      extraction_status: input.extractionStatus ?? "pending",
    })
    .select("*")
    .single();
  if (error) throw error;
  return data as OperationalCaseDocument;
}

export async function listOperationalCaseDocuments(
  db: DbClient,
  input: { caseId: string; statuses?: OperationalCaseDocumentStatus[] }
): Promise<OperationalCaseDocument[]> {
  let query = db
    .from("operational_case_documents")
    .select("*")
    .eq("case_id", input.caseId)
    .order("created_at", { ascending: false });
  if (input.statuses?.length) {
    query = query.in("status", input.statuses);
  }
  const { data, error } = await query;
  if (isMissingOperationalCaseDocumentsTable(error)) return [];
  if (error) throw error;
  return (data ?? []) as OperationalCaseDocument[];
}

export async function getOperationalCaseDocument(
  db: DbClient,
  documentId: string
): Promise<OperationalCaseDocument | null> {
  const { data, error } = await db
    .from("operational_case_documents")
    .select("*")
    .eq("id", documentId)
    .maybeSingle();
  if (error) throw error;
  return (data as OperationalCaseDocument | null) ?? null;
}

export async function findExtractedOperationalCaseDocumentByHash(
  db: DbClient,
  input: { caseId: string; kind: string; sha256: string; excludeDocumentId?: string }
): Promise<OperationalCaseDocument | null> {
  let query = db
    .from("operational_case_documents")
    .select("*")
    .eq("case_id", input.caseId)
    .eq("kind", input.kind)
    .eq("sha256", input.sha256)
    .in("extraction_status", ["ok", "low_confidence"])
    .neq("status", "superseded")
    .order("extracted_at", { ascending: false })
    .limit(1);
  if (input.excludeDocumentId) {
    query = query.neq("id", input.excludeDocumentId);
  }
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return (data as OperationalCaseDocument | null) ?? null;
}

export async function updateOperationalCaseDocumentExtraction(
  db: DbClient,
  input: {
    documentId: string;
    status: OperationalCaseDocumentExtractionStatus;
    model?: string | null;
    extraction?: Record<string, unknown>;
  }
): Promise<OperationalCaseDocument> {
  const { data, error } = await db
    .from("operational_case_documents")
    .update({
      extraction_status: input.status,
      extraction_model: input.model ?? null,
      extraction_jsonb: input.extraction ?? {},
      extracted_at: new Date().toISOString(),
    })
    .eq("id", input.documentId)
    .select("*")
    .single();
  if (error) throw error;
  return data as OperationalCaseDocument;
}
