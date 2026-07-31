/**
 * El agente recibe OCR embebido (`### Archivo adjunto: …`), pero el chat web
 * debe mostrar chips de archivo + texto del usuario — nunca el OCR crudo.
 */

export type ChatAttachmentDisplayMeta = {
  fileName: string;
  truncated?: boolean;
  sizeBytes?: number;
};

const ATTACHMENT_HEADER_RE = /^### Archivo adjunto:\s*(.+?)\s*$/gm;

export function stripEmbeddedAttachmentOcr(content: string): string {
  const marker = "### Archivo adjunto:";
  const idx = content.indexOf(marker);
  if (idx < 0) return content;
  return content
    .slice(0, idx)
    .replace(/\n*-{3,}\s*$/g, "")
    .trim();
}

export function parseAttachmentMetaFromContent(
  content: string
): ChatAttachmentDisplayMeta[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const match of content.matchAll(ATTACHMENT_HEADER_RE)) {
    const fileName = match[1]?.trim();
    if (!fileName || seen.has(fileName)) continue;
    seen.add(fileName);
    names.push(fileName);
  }
  return names.map((fileName) => ({ fileName }));
}

export function attachmentMetaFromPayload(
  payload: Record<string, unknown> | null | undefined
): ChatAttachmentDisplayMeta[] {
  const raw = payload?.attachments;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (typeof record.fileName !== "string" || !record.fileName.trim()) {
      return [];
    }
    const meta: ChatAttachmentDisplayMeta = {
      fileName: record.fileName,
    };
    if (record.truncated === true) meta.truncated = true;
    if (typeof record.sizeBytes === "number") meta.sizeBytes = record.sizeBytes;
    return [meta];
  });
}

export function resolveUserMessageDisplay(params: {
  content: string;
  structuredPayload?: Record<string, unknown> | null;
}): {
  userText: string;
  attachments: ChatAttachmentDisplayMeta[];
} {
  const payload = params.structuredPayload;
  const fromPayload = attachmentMetaFromPayload(payload);
  const attachments =
    fromPayload.length > 0
      ? fromPayload
      : parseAttachmentMetaFromContent(params.content);

  if (payload && typeof payload.userText === "string") {
    return { userText: payload.userText, attachments };
  }

  return {
    userText: stripEmbeddedAttachmentOcr(params.content),
    attachments,
  };
}

export function buildUserMessageStructuredPayload(params: {
  message: string;
  attachments: Array<{
    fileName: string;
    sizeBytes?: number;
    truncated?: boolean;
  }>;
}): Record<string, unknown> {
  const userText = stripEmbeddedAttachmentOcr(params.message);
  const attachments =
    params.attachments.length > 0
      ? params.attachments.map((attachment) => ({
          fileName: attachment.fileName,
          ...(typeof attachment.sizeBytes === "number"
            ? { sizeBytes: attachment.sizeBytes }
            : {}),
          ...(attachment.truncated ? { truncated: true } : {}),
        }))
      : parseAttachmentMetaFromContent(params.message);

  return {
    userText,
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}
