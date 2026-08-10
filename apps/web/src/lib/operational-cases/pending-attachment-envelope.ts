import type { AttachmentEnvelope } from "@agents/types";
import { normalizeAttachmentEnvelope } from "@/lib/attachments/envelope";

/**
 * Envelope durable de adjuntos web a través de aclaraciones multi-caso.
 * Solo referencias de staging validadas (sin OCR). El caller promueve con
 * ingestStagedCaseDocument al resolver el caso.
 */

export type PendingAttachmentRef = Omit<AttachmentEnvelope, "version"> & {
  version?: 1;
};

export function serializePendingAttachments(
  attachments: PendingAttachmentRef[]
): PendingAttachmentRef[] {
  return attachments.map((attachment) => ({
    ...(attachment.version === 1 ? { version: 1 as const } : {}),
    ...(attachment.fileId ? { fileId: attachment.fileId } : {}),
    fileName: attachment.fileName,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    storageBucket: attachment.storageBucket,
    storagePath: attachment.storagePath,
    sha256: attachment.sha256,
    ...(typeof attachment.suggestedKind === "string"
      ? { suggestedKind: attachment.suggestedKind }
      : {}),
    ...(attachment.channel ? { channel: attachment.channel } : {}),
    ...(attachment.sessionId ? { sessionId: attachment.sessionId } : {}),
    ...(attachment.turnId ? { turnId: attachment.turnId } : {}),
    ...(attachment.role ? { role: attachment.role } : {}),
    ...(attachment.retention ? { retention: attachment.retention } : {}),
    ...(attachment.expiresAt ? { expiresAt: attachment.expiresAt } : {}),
  }));
}

export function parsePendingAttachments(
  pendingMessage: Record<string, unknown> | null | undefined,
  opts?: { userId?: string }
): PendingAttachmentRef[] {
  if (!pendingMessage || typeof pendingMessage !== "object") return [];
  const raw = pendingMessage.attachments;
  if (!Array.isArray(raw)) return [];
  const userId = opts?.userId?.trim() || null;
  const parsed: PendingAttachmentRef[] = [];
  for (const item of raw) {
    const normalized = normalizeAttachmentEnvelope(item, {
      ...(userId ? { userId } : {}),
    });
    if (!normalized) continue;
    parsed.push({
      ...normalized,
      suggestedKind: normalized.suggestedKind ?? "unknown",
    });
  }
  return parsed;
}

export function buildPendingMessageEnvelope(params: {
  text: string;
  attachments?: PendingAttachmentRef[];
}): Record<string, unknown> {
  const envelope: Record<string, unknown> = {
    text: params.text,
    received_at: new Date().toISOString(),
  };
  if (params.attachments && params.attachments.length > 0) {
    envelope.attachments = serializePendingAttachments(params.attachments);
  }
  return envelope;
}
