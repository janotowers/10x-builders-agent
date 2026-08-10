import { createHash } from "node:crypto";
import type {
  AttachmentRetention,
  AttachmentValidationStatus,
  UserFileSource,
} from "@agents/types";
import {
  ATTACHMENT_MAX_BYTES,
  validateAttachmentMetadata,
  type AttachmentFormat,
} from "./format-policy";

export const USER_FILES_BUCKET = "user-files";

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function safeAttachmentPathSegment(value: string): string {
  return (
    value
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^[.-]+|[.-]+$/g, "")
      .slice(0, 100) || "file"
  );
}

function assertSafeIdentifier(value: string, label: string): void {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value)) {
    throw new Error(`invalid_${label}`);
  }
}

export function buildUserFileStoragePath(params: {
  userId: string;
  fileId: string;
  fileName: string;
  area?: "uploads" | "generated" | "external";
}): string {
  assertSafeIdentifier(params.userId, "user_id");
  assertSafeIdentifier(params.fileId, "file_id");
  return `users/${params.userId}/${params.area ?? "uploads"}/${params.fileId}/${safeAttachmentPathSegment(params.fileName)}`;
}

export function isOwnedUserFilePath(path: string, userId: string): boolean {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(userId)) return false;
  if (path.includes("\\") || path.includes("\0")) return false;
  const segments = path.split("/");
  return (
    segments.length >= 5 &&
    segments[0] === "users" &&
    segments[1] === userId &&
    ["uploads", "generated", "external"].includes(segments[2] ?? "") &&
    segments.every(
      (segment) => segment.length > 0 && segment !== "." && segment !== ".."
    )
  );
}

export interface AttachmentStoragePort {
  upload(input: {
    bucket: string;
    path: string;
    bytes: Uint8Array;
    mimeType: string;
    upsert: false;
  }): Promise<void>;
  download(input: { bucket: string; path: string }): Promise<Uint8Array>;
  remove(input: { bucket: string; paths: string[] }): Promise<void>;
}

export interface StoredAttachmentDraft {
  userId: string;
  fileId: string;
  bucket: typeof USER_FILES_BUCKET;
  path: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  source: UserFileSource;
  validationStatus: Extract<AttachmentValidationStatus, "accepted">;
  validationMetadata: {
    format: AttachmentFormat;
    extension: string;
    zipContainer: boolean;
    maxBytes: number;
  };
  retention: AttachmentRetention;
  expiresAt: string | null;
}

export function prepareAttachmentForStorage(params: {
  userId: string;
  fileId: string;
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
  source?: UserFileSource;
  retention?: AttachmentRetention;
  expiresAt?: string | null;
}): StoredAttachmentDraft {
  const validation = validateAttachmentMetadata({
    fileName: params.fileName,
    mimeType: params.mimeType,
    sizeBytes: params.bytes.byteLength,
    maxBytes: ATTACHMENT_MAX_BYTES,
  });
  if (!validation.ok) {
    throw new Error(`attachment_validation:${validation.code}`);
  }
  const area =
    params.source === "generated"
      ? "generated"
      : params.source === "external_copy"
        ? "external"
        : "uploads";
  const path = buildUserFileStoragePath({
    userId: params.userId,
    fileId: params.fileId,
    fileName: params.fileName,
    area,
  });
  return {
    userId: params.userId,
    fileId: params.fileId,
    bucket: USER_FILES_BUCKET,
    path,
    originalName: params.fileName,
    mimeType: validation.mimeType,
    sizeBytes: params.bytes.byteLength,
    sha256: sha256Hex(params.bytes),
    source: params.source ?? "upload",
    validationStatus: "accepted",
    validationMetadata: {
      format: validation.format,
      extension: validation.extension,
      zipContainer: validation.zipContainer,
      maxBytes: validation.maxBytes,
    },
    retention: params.retention ?? "standard",
    expiresAt: params.expiresAt ?? null,
  };
}

export async function storeAttachment(
  storage: AttachmentStoragePort,
  params: Parameters<typeof prepareAttachmentForStorage>[0]
): Promise<StoredAttachmentDraft> {
  const draft = prepareAttachmentForStorage(params);
  if (!isOwnedUserFilePath(draft.path, params.userId)) {
    throw new Error("attachment_path_not_owned");
  }
  await storage.upload({
    bucket: draft.bucket,
    path: draft.path,
    bytes: params.bytes,
    mimeType: draft.mimeType,
    upsert: false,
  });
  return draft;
}
