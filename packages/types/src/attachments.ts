export type AttachmentChannel =
  | "web"
  | "telegram"
  | "email"
  | "api"
  | "system";

export type AttachmentRole = "input" | "output";

export type UserFileSource =
  | "upload"
  | "generated"
  | "external_copy"
  | "migrated";

export type UserFileStatus =
  | "pending_upload"
  | "uploaded"
  | "processing"
  | "ready"
  | "failed"
  | "deleted";

export type AttachmentValidationStatus =
  | "pending"
  | "accepted"
  | "rejected"
  | "failed";

/**
 * Reserved lifecycle metadata only. `not_scanned` is the default and must not
 * be interpreted as a malware-safety assertion.
 */
export type AttachmentScanStatus =
  | "not_scanned"
  | "pending"
  | "clean"
  | "flagged"
  | "failed";

export type AttachmentRetention = "temporary" | "session" | "standard" | "retained";

export interface UserFile {
  id: string;
  user_id: string;
  bucket: string;
  path: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  source: UserFileSource;
  status: UserFileStatus;
  validation_status: AttachmentValidationStatus;
  validation_metadata_jsonb: Record<string, unknown>;
  scan_status: AttachmentScanStatus;
  scan_metadata_jsonb: Record<string, unknown>;
  processing_error_jsonb: Record<string, unknown> | null;
  metadata_jsonb: Record<string, unknown>;
  retention: AttachmentRetention;
  expires_at: string | null;
  processing_started_at: string | null;
  ready_at: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MessageAttachment {
  id: string;
  user_id: string;
  file_id: string;
  session_id: string;
  message_id: string | null;
  turn_id: string | null;
  channel: AttachmentChannel;
  role: AttachmentRole;
  ordinal: number;
  metadata_jsonb: Record<string, unknown>;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Channel-neutral transport shape. Its legacy fields intentionally match
 * `PendingAttachmentRef`; existing callers can migrate without replacing their
 * current envelope in the same release.
 */
export interface AttachmentEnvelope {
  version: 1;
  fileId?: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  storageBucket: string;
  storagePath: string;
  sha256: string;
  suggestedKind?: string;
  channel?: AttachmentChannel;
  sessionId?: string;
  turnId?: string;
  role?: AttachmentRole;
  retention?: AttachmentRetention;
  expiresAt?: string;
}

/**
 * Trusted, channel-neutral attachment evidence supplied to one agent turn.
 * Storage coordinates never cross this boundary.
 *
 * `studio_qualification_fixture` is synthetic private evidence injected by
 * Studio operational tests. It must never be treated as a real user upload.
 */
export interface RuntimeInputAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  channel: AttachmentChannel;
  role: Extract<AttachmentRole, "input">;
  format: string;
  extractedText?: string;
  extractedTextTruncated?: boolean;
  provenance: {
    kind: "message_attachment" | "studio_qualification_fixture";
    sessionId: string;
    turnId?: string;
    source: UserFileSource;
    validationStatus: Extract<AttachmentValidationStatus, "accepted">;
    scanStatus: Extract<AttachmentScanStatus, "not_scanned" | "clean">;
  };
}

export interface AgentRuntimeInput {
  attachments: RuntimeInputAttachment[];
}
