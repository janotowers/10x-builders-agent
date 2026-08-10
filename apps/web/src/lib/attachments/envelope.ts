import type {
  AttachmentChannel,
  AttachmentEnvelope,
  AttachmentRetention,
  AttachmentRole,
} from "@agents/types";
import { isOwnedUserFilePath } from "./storage";

const CHANNELS = new Set<AttachmentChannel>([
  "web",
  "telegram",
  "email",
  "api",
  "system",
]);
const ROLES = new Set<AttachmentRole>(["input", "output"]);
const RETENTIONS = new Set<AttachmentRetention>([
  "temporary",
  "session",
  "standard",
  "retained",
]);

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function optionalString(
  record: Record<string, unknown>,
  key: string
): string | undefined {
  return nonEmptyString(record[key]) ? record[key] : undefined;
}

export function isOwnedLegacyAttachmentPath(
  path: string,
  userId: string
): boolean {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(userId)) return false;
  if (path.includes("\\") || path.includes("\0")) return false;
  const segments = path.split("/");
  return (
    segments.length >= 2 &&
    segments[0] === userId &&
    segments.every(
      (segment) => segment.length > 0 && segment !== "." && segment !== ".."
    )
  );
}

export function isAttachmentPathOwnedByUser(
  path: string,
  userId: string
): boolean {
  return (
    isOwnedUserFilePath(path, userId) ||
    isOwnedLegacyAttachmentPath(path, userId)
  );
}

/**
 * Migrates a current `PendingAttachmentRef`-compatible object or validates a
 * V1 generic envelope. It does not mutate the caller's object.
 */
export function normalizeAttachmentEnvelope(
  value: unknown,
  options?: { userId?: string }
): AttachmentEnvelope | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    !nonEmptyString(record.fileName) ||
    !nonEmptyString(record.mimeType) ||
    !nonEmptyString(record.storageBucket) ||
    !nonEmptyString(record.storagePath) ||
    !nonEmptyString(record.sha256) ||
    typeof record.sizeBytes !== "number" ||
    !Number.isSafeInteger(record.sizeBytes) ||
    record.sizeBytes < 0
  ) {
    return null;
  }
  if (record.version !== undefined && record.version !== 1) return null;
  if (
    options?.userId &&
    !isAttachmentPathOwnedByUser(record.storagePath, options.userId)
  ) {
    return null;
  }

  const channel =
    typeof record.channel === "string" &&
    CHANNELS.has(record.channel as AttachmentChannel)
      ? (record.channel as AttachmentChannel)
      : undefined;
  const role =
    typeof record.role === "string" && ROLES.has(record.role as AttachmentRole)
      ? (record.role as AttachmentRole)
      : undefined;
  const retention =
    typeof record.retention === "string" &&
    RETENTIONS.has(record.retention as AttachmentRetention)
      ? (record.retention as AttachmentRetention)
      : undefined;

  return {
    version: 1,
    fileName: record.fileName,
    mimeType: record.mimeType,
    sizeBytes: record.sizeBytes,
    storageBucket: record.storageBucket,
    storagePath: record.storagePath,
    sha256: record.sha256,
    ...(optionalString(record, "fileId")
      ? { fileId: optionalString(record, "fileId") }
      : {}),
    ...(optionalString(record, "suggestedKind")
      ? { suggestedKind: optionalString(record, "suggestedKind") }
      : {}),
    ...(channel ? { channel } : {}),
    ...(optionalString(record, "sessionId")
      ? { sessionId: optionalString(record, "sessionId") }
      : {}),
    ...(optionalString(record, "turnId")
      ? { turnId: optionalString(record, "turnId") }
      : {}),
    ...(role ? { role } : {}),
    ...(retention ? { retention } : {}),
    ...(optionalString(record, "expiresAt")
      ? { expiresAt: optionalString(record, "expiresAt") }
      : {}),
  };
}

export function normalizeAttachmentEnvelopes(
  values: readonly unknown[],
  options?: { userId?: string }
): AttachmentEnvelope[] {
  return values.flatMap((value) => {
    const normalized = normalizeAttachmentEnvelope(value, options);
    return normalized ? [normalized] : [];
  });
}
