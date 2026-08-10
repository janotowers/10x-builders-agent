import type {
  AttachmentChannel,
  AttachmentRetention,
  AttachmentRole,
  AttachmentValidationStatus,
  MessageAttachment,
  UserFile,
  UserFileSource,
  UserFileStatus,
} from "@agents/types";
import type { DbClient } from "../client";

export const USER_FILES_BUCKET = "user-files";

export interface CreateUserFileInput {
  fileId?: string;
  userId: string;
  bucket?: string;
  path: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  source?: UserFileSource;
  status?: Extract<UserFileStatus, "pending_upload" | "uploaded">;
  validationStatus?: AttachmentValidationStatus;
  validationMetadata?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  retention?: AttachmentRetention;
  expiresAt?: string | null;
}

export async function createUserFile(
  db: DbClient,
  input: CreateUserFileInput
): Promise<UserFile> {
  const { data, error } = await db
    .from("user_files")
    .insert({
      ...(input.fileId ? { id: input.fileId } : {}),
      user_id: input.userId,
      bucket: input.bucket ?? USER_FILES_BUCKET,
      path: input.path,
      original_name: input.originalName,
      mime_type: input.mimeType,
      size_bytes: input.sizeBytes,
      sha256: input.sha256,
      source: input.source ?? "upload",
      status: input.status ?? "pending_upload",
      validation_status: input.validationStatus ?? "pending",
      validation_metadata_jsonb: input.validationMetadata ?? {},
      metadata_jsonb: input.metadata ?? {},
      retention: input.retention ?? "standard",
      expires_at: input.expiresAt ?? null,
    })
    .select("*")
    .single();
  if (error) throw error;
  return data as UserFile;
}

export async function getUserFile(
  db: DbClient,
  params: { userId: string; fileId: string }
): Promise<UserFile | null> {
  const { data, error } = await db
    .from("user_files")
    .select("*")
    .eq("user_id", params.userId)
    .eq("id", params.fileId)
    .maybeSingle();
  if (error) throw error;
  return (data as UserFile | null) ?? null;
}

export async function findUserFileByHash(
  db: DbClient,
  params: { userId: string; sha256: string }
): Promise<UserFile | null> {
  const { data, error } = await db
    .from("user_files")
    .select("*")
    .eq("user_id", params.userId)
    .eq("sha256", params.sha256)
    .neq("status", "deleted")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as UserFile | null) ?? null;
}

/** CAS: only the owner can mark a pending metadata row as uploaded. */
export async function markUserFileUploaded(
  db: DbClient,
  params: { userId: string; fileId: string }
): Promise<UserFile | null> {
  const { data, error } = await db
    .from("user_files")
    .update({ status: "uploaded" satisfies UserFileStatus })
    .eq("user_id", params.userId)
    .eq("id", params.fileId)
    .eq("status", "pending_upload")
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return (data as UserFile | null) ?? null;
}

/** CAS processing claim: duplicate workers cannot process the same file. */
export async function claimUserFileProcessing(
  db: DbClient,
  params: { userId: string; fileId: string }
): Promise<UserFile | null> {
  const { data, error } = await db
    .from("user_files")
    .update({
      status: "processing" satisfies UserFileStatus,
      processing_started_at: new Date().toISOString(),
      processing_error_jsonb: null,
    })
    .eq("user_id", params.userId)
    .eq("id", params.fileId)
    .eq("status", "uploaded")
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return (data as UserFile | null) ?? null;
}

/** CAS completion: stale workers cannot overwrite terminal state. */
export async function markUserFileReady(
  db: DbClient,
  params: {
    userId: string;
    fileId: string;
    validationMetadata?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }
): Promise<UserFile | null> {
  const { data, error } = await db
    .from("user_files")
    .update({
      status: "ready" satisfies UserFileStatus,
      validation_status: "accepted" satisfies AttachmentValidationStatus,
      validation_metadata_jsonb: params.validationMetadata ?? {},
      metadata_jsonb: params.metadata ?? {},
      processing_error_jsonb: null,
      ready_at: new Date().toISOString(),
    })
    .eq("user_id", params.userId)
    .eq("id", params.fileId)
    .eq("status", "processing")
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return (data as UserFile | null) ?? null;
}

/** CAS failure from an active pre-terminal lifecycle state. */
export async function markUserFileFailed(
  db: DbClient,
  params: {
    userId: string;
    fileId: string;
    validationStatus?: Extract<AttachmentValidationStatus, "rejected" | "failed">;
    error: Record<string, unknown>;
    validationMetadata?: Record<string, unknown>;
  }
): Promise<UserFile | null> {
  const { data, error } = await db
    .from("user_files")
    .update({
      status: "failed" satisfies UserFileStatus,
      validation_status: params.validationStatus ?? "failed",
      validation_metadata_jsonb: params.validationMetadata ?? {},
      processing_error_jsonb: params.error,
    })
    .eq("user_id", params.userId)
    .eq("id", params.fileId)
    .in("status", ["pending_upload", "uploaded", "processing"])
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return (data as UserFile | null) ?? null;
}

export async function markUserFileDeleted(
  db: DbClient,
  params: { userId: string; fileId: string }
): Promise<UserFile | null> {
  const { data, error } = await db
    .from("user_files")
    .update({
      status: "deleted" satisfies UserFileStatus,
      deleted_at: new Date().toISOString(),
    })
    .eq("user_id", params.userId)
    .eq("id", params.fileId)
    .neq("status", "deleted")
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return (data as UserFile | null) ?? null;
}

export interface CreateMessageAttachmentInput {
  userId: string;
  fileId: string;
  sessionId: string;
  messageId?: string | null;
  turnId?: string | null;
  channel: AttachmentChannel;
  role: AttachmentRole;
  ordinal?: number;
  metadata?: Record<string, unknown>;
  expiresAt?: string | null;
}

export async function createMessageAttachment(
  db: DbClient,
  input: CreateMessageAttachmentInput
): Promise<MessageAttachment> {
  const { data, error } = await db
    .from("message_attachments")
    .insert({
      user_id: input.userId,
      file_id: input.fileId,
      session_id: input.sessionId,
      message_id: input.messageId ?? null,
      turn_id: input.turnId ?? null,
      channel: input.channel,
      role: input.role,
      ordinal: input.ordinal ?? 0,
      metadata_jsonb: input.metadata ?? {},
      expires_at: input.expiresAt ?? null,
    })
    .select("*")
    .single();
  if (error) throw error;
  return data as MessageAttachment;
}

export async function listMessageAttachments(
  db: DbClient,
  params: {
    userId: string;
    sessionId: string;
    messageId?: string;
    turnId?: string;
  }
): Promise<MessageAttachment[]> {
  let query = db
    .from("message_attachments")
    .select("*")
    .eq("user_id", params.userId)
    .eq("session_id", params.sessionId);
  if (params.messageId) query = query.eq("message_id", params.messageId);
  if (params.turnId) query = query.eq("turn_id", params.turnId);
  const { data, error } = await query.order("ordinal", { ascending: true });
  if (error) throw error;
  return (data ?? []) as MessageAttachment[];
}
