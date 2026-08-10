import { randomUUID } from "node:crypto";
import {
  claimUserFileProcessing,
  createMessageAttachment,
  createUserFile,
  getUserFile,
  listMessageAttachments,
  markUserFileFailed,
  markUserFileReady,
  markUserFileUploaded,
  type DbClient,
} from "@agents/db";
import type {
  AgentRuntimeInput,
  AttachmentChannel,
  AttachmentEnvelope,
  RuntimeInputAttachment,
  UserFile,
  UserFileSource,
} from "@agents/types";
import { normalizeAttachmentEnvelopes } from "./envelope";
import { extractValidatedAttachmentText } from "./extraction";
import { isOwnedUserFilePath, storeAttachment, USER_FILES_BUCKET } from "./storage";
import { validateAttachmentMetadata } from "./format-policy";

export class AttachmentRuntimeError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AttachmentRuntimeError";
  }
}

function storagePort(db: DbClient) {
  return {
    async upload(input: {
      bucket: string;
      path: string;
      bytes: Uint8Array;
      mimeType: string;
      upsert: false;
    }) {
      const { error } = await db.storage
        .from(input.bucket)
        .upload(input.path, input.bytes, {
          contentType: input.mimeType,
          upsert: input.upsert,
        });
      if (error) throw error;
    },
    async download(input: { bucket: string; path: string }) {
      const { data, error } = await db.storage.from(input.bucket).download(input.path);
      if (error || !data) throw error ?? new Error("attachment_download_failed");
      return new Uint8Array(await data.arrayBuffer());
    },
    async remove(input: { bucket: string; paths: string[] }) {
      const { error } = await db.storage.from(input.bucket).remove(input.paths);
      if (error) throw error;
    },
  };
}

export async function ingestGenericAttachment(params: {
  db: DbClient;
  userId: string;
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
  channel: AttachmentChannel;
  source?: UserFileSource;
  metadata?: Record<string, unknown>;
}): Promise<{
  envelope: AttachmentEnvelope;
  text: string;
  truncated: boolean;
  format: string;
}> {
  const fileId = randomUUID();
  const validation = validateAttachmentMetadata({
    fileName: params.fileName,
    mimeType: params.mimeType,
    sizeBytes: params.bytes.byteLength,
  });
  if (!validation.ok) {
    throw new AttachmentRuntimeError(`attachment_validation:${validation.code}`);
  }

  const stored = await storeAttachment(storagePort(params.db), {
    userId: params.userId,
    fileId,
    fileName: params.fileName,
    mimeType: params.mimeType,
    bytes: params.bytes,
    source: params.source,
  });

  try {
    await createUserFile(params.db, {
      fileId,
      userId: params.userId,
      bucket: stored.bucket,
      path: stored.path,
      originalName: stored.originalName,
      mimeType: stored.mimeType,
      sizeBytes: stored.sizeBytes,
      sha256: stored.sha256,
      source: stored.source,
      status: "pending_upload",
      validationStatus: "accepted",
      validationMetadata: stored.validationMetadata,
      metadata: {
        ...params.metadata,
        channel: params.channel,
      },
      retention: stored.retention,
      expiresAt: stored.expiresAt,
    });
    if (!(await markUserFileUploaded(params.db, { userId: params.userId, fileId }))) {
      throw new Error("attachment_upload_transition_failed");
    }
    if (!(await claimUserFileProcessing(params.db, { userId: params.userId, fileId }))) {
      throw new Error("attachment_processing_claim_failed");
    }

    const extracted =
      validation.format === "image"
        ? { text: "", truncated: false }
        : await extractValidatedAttachmentText({
            fileName: stored.originalName,
            mimeType: stored.mimeType,
            bytes: params.bytes,
          });
    const metadata = {
      ...params.metadata,
      channel: params.channel,
      format: validation.format,
      ...(validation.format === "image"
        ? {}
        : {
            extraction: {
              text: extracted.text,
              truncated: extracted.truncated,
              chars: extracted.text.length,
            },
          }),
    };
    if (
      !(await markUserFileReady(params.db, {
        userId: params.userId,
        fileId,
        validationMetadata: stored.validationMetadata,
        metadata,
      }))
    ) {
      throw new Error("attachment_ready_transition_failed");
    }

    return {
      envelope: {
        version: 1,
        fileId,
        fileName: stored.originalName,
        mimeType: stored.mimeType,
        sizeBytes: stored.sizeBytes,
        storageBucket: stored.bucket,
        storagePath: stored.path,
        sha256: stored.sha256,
        channel: params.channel,
        role: "input",
        retention: stored.retention,
      },
      text: extracted.text,
      truncated: extracted.truncated,
      format: validation.format,
    };
  } catch (error) {
    await markUserFileFailed(params.db, {
      userId: params.userId,
      fileId,
      error: {
        code: "attachment_processing_failed",
        message: error instanceof Error ? error.message : String(error),
      },
    }).catch(() => undefined);
    await storagePort(params.db)
      .remove({ bucket: stored.bucket, paths: [stored.path] })
      .catch(() => undefined);
    throw error;
  }
}

function extractionFromMetadata(metadata: Record<string, unknown>): {
  text?: string;
  truncated?: boolean;
} {
  const raw = metadata.extraction;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const extraction = raw as Record<string, unknown>;
  return {
    ...(typeof extraction.text === "string" ? { text: extraction.text } : {}),
    ...(extraction.truncated === true ? { truncated: true } : {}),
  };
}

export function assertRuntimeAttachmentEligible(params: {
  file: UserFile;
  envelope: AttachmentEnvelope;
  userId: string;
  nowMs?: number;
}): void {
  const { file, envelope } = params;
  if (file.user_id !== params.userId) {
    throw new AttachmentRuntimeError("attachment_not_owned");
  }
  if (
    file.status !== "ready" ||
    file.validation_status !== "accepted" ||
    (file.scan_status !== "not_scanned" && file.scan_status !== "clean")
  ) {
    throw new AttachmentRuntimeError("attachment_not_safe_and_ready");
  }
  if (
    file.expires_at &&
    Date.parse(file.expires_at) <= (params.nowMs ?? Date.now())
  ) {
    throw new AttachmentRuntimeError("attachment_expired");
  }
  if (
    file.bucket !== USER_FILES_BUCKET ||
    !isOwnedUserFilePath(file.path, params.userId) ||
    envelope.fileId !== file.id ||
    envelope.storageBucket !== file.bucket ||
    envelope.storagePath !== file.path ||
    envelope.fileName !== file.original_name ||
    envelope.mimeType !== file.mime_type ||
    envelope.sizeBytes !== file.size_bytes ||
    envelope.sha256 !== file.sha256
  ) {
    throw new AttachmentRuntimeError("attachment_envelope_mismatch");
  }
}

export async function resolveAttachmentRuntimeInput(params: {
  db: DbClient;
  userId: string;
  sessionId: string;
  turnId: string;
  channel: AttachmentChannel;
  envelopes: readonly unknown[];
}): Promise<AgentRuntimeInput | undefined> {
  const envelopes = normalizeAttachmentEnvelopes(params.envelopes, {
    userId: params.userId,
  });
  const resolved: RuntimeInputAttachment[] = [];
  const existingAssociations = await listMessageAttachments(params.db, {
    userId: params.userId,
    sessionId: params.sessionId,
    turnId: params.turnId,
  });

  for (const [ordinal, envelope] of envelopes.entries()) {
    if (!envelope.fileId) continue; // Legacy case-staging envelope.
    const file = await getUserFile(params.db, {
      userId: params.userId,
      fileId: envelope.fileId,
    });
    if (!file) throw new AttachmentRuntimeError("attachment_not_owned");
    assertRuntimeAttachmentEligible({
      file,
      envelope,
      userId: params.userId,
    });

    if (!existingAssociations.some((item) => item.file_id === file.id)) {
      await createMessageAttachment(params.db, {
        userId: params.userId,
        fileId: file.id,
        sessionId: params.sessionId,
        turnId: params.turnId,
        channel: params.channel,
        role: "input",
        ordinal,
        metadata: { envelope_version: envelope.version },
      });
    }
    const extraction = extractionFromMetadata(file.metadata_jsonb);
    const format =
      typeof file.validation_metadata_jsonb.format === "string"
        ? file.validation_metadata_jsonb.format
        : "unknown";
    resolved.push({
      id: file.id,
      fileName: file.original_name,
      mimeType: file.mime_type,
      sizeBytes: file.size_bytes,
      sha256: file.sha256,
      channel: params.channel,
      role: "input",
      format,
      ...(extraction.text !== undefined
        ? { extractedText: extraction.text }
        : {}),
      ...(extraction.truncated
        ? { extractedTextTruncated: true }
        : {}),
      provenance: {
        kind: "message_attachment",
        sessionId: params.sessionId,
        ...(params.turnId ? { turnId: params.turnId } : {}),
        source: file.source,
        validationStatus: "accepted",
        scanStatus: file.scan_status === "clean" ? "clean" : "not_scanned",
      },
    });
  }
  return resolved.length > 0 ? { attachments: resolved } : undefined;
}
