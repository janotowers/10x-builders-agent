/**
 * Envelope durable de adjuntos web a través de aclaraciones multi-caso.
 * Solo referencias de staging validadas (sin OCR). El caller promueve con
 * ingestStagedCaseDocument al resolver el caso.
 */

export type PendingAttachmentRef = {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  storageBucket: string;
  storagePath: string;
  sha256: string;
  suggestedKind?: string;
};

export function serializePendingAttachments(
  attachments: PendingAttachmentRef[]
): PendingAttachmentRef[] {
  return attachments.map((attachment) => ({
    fileName: attachment.fileName,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    storageBucket: attachment.storageBucket,
    storagePath: attachment.storagePath,
    sha256: attachment.sha256,
    ...(typeof attachment.suggestedKind === "string"
      ? { suggestedKind: attachment.suggestedKind }
      : {}),
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
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (
      typeof record.fileName !== "string" ||
      typeof record.mimeType !== "string" ||
      typeof record.storageBucket !== "string" ||
      typeof record.storagePath !== "string" ||
      typeof record.sha256 !== "string"
    ) {
      continue;
    }
    if (userId && !record.storagePath.startsWith(`${userId}/`)) {
      continue;
    }
    const ref: PendingAttachmentRef = {
      fileName: record.fileName,
      mimeType: record.mimeType,
      sizeBytes:
        typeof record.sizeBytes === "number" && Number.isFinite(record.sizeBytes)
          ? record.sizeBytes
          : 0,
      storageBucket: record.storageBucket,
      storagePath: record.storagePath,
      sha256: record.sha256,
    };
    if (typeof record.suggestedKind === "string") {
      ref.suggestedKind = record.suggestedKind;
    } else {
      ref.suggestedKind = "unknown";
    }
    parsed.push(ref);
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
