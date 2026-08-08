import type { DbClient } from "@agents/db";
import type { OperationalCaseDocument } from "@agents/types";
import { sendGmailMessage } from "./send-message";

const MAX_GMAIL_ATTACHMENT_BYTES = 18 * 1024 * 1024;

type GmailToolAttachment = Pick<
  OperationalCaseDocument,
  | "id"
  | "user_id"
  | "status"
  | "storage_bucket"
  | "storage_path"
  | "original_name"
  | "display_name"
  | "content_type"
  | "file_size_bytes"
>;

type DownloadedAttachment = {
  filename: string;
  contentType: string;
  content: Buffer;
};

export interface ExecuteGmailSendToolInput {
  db: DbClient;
  userId: string;
  to: string;
  subject: string;
  body: string;
  documents: GmailToolAttachment[];
}

export interface GmailSendToolDeps {
  download?: (
    db: DbClient,
    document: GmailToolAttachment
  ) => Promise<Buffer>;
  send?: typeof sendGmailMessage;
}

async function downloadDocument(
  db: DbClient,
  document: GmailToolAttachment
): Promise<Buffer> {
  const { data, error } = await db.storage
    .from(document.storage_bucket)
    .download(document.storage_path);
  if (error || !data) {
    throw new Error(`gmail_attachment_download_failed:${document.id}`);
  }
  return Buffer.from(await data.arrayBuffer());
}

export async function executeGmailSendTool(
  input: ExecuteGmailSendToolInput,
  deps: GmailSendToolDeps = {}
) {
  let declaredBytes = 0;
  for (const document of input.documents) {
    if (document.user_id !== input.userId) {
      return {
        ok: false as const,
        status: "gmail_attachment_forbidden" as const,
        message: "Un adjunto no pertenece a esta cuenta.",
      };
    }
    if (document.status !== "received") {
      return {
        ok: false as const,
        status: "gmail_attachment_unavailable" as const,
        message: "Un adjunto ya no está vigente.",
      };
    }
    declaredBytes += document.file_size_bytes ?? 0;
  }
  if (declaredBytes > MAX_GMAIL_ATTACHMENT_BYTES) {
    return {
      ok: false as const,
      status: "gmail_attachments_too_large" as const,
      message: "Los adjuntos exceden el límite seguro de 18 MB.",
    };
  }

  const download = deps.download ?? downloadDocument;
  const attachments: DownloadedAttachment[] = [];
  let actualBytes = 0;
  for (const document of input.documents) {
    const content = await download(input.db, document);
    actualBytes += content.byteLength;
    if (actualBytes > MAX_GMAIL_ATTACHMENT_BYTES) {
      return {
        ok: false as const,
        status: "gmail_attachments_too_large" as const,
        message: "Los adjuntos exceden el límite seguro de 18 MB.",
      };
    }
    attachments.push({
      filename:
        document.original_name?.trim() ||
        document.display_name?.trim() ||
        `documento-${document.id}`,
      contentType: document.content_type?.trim() || "application/octet-stream",
      content,
    });
  }

  const send = deps.send ?? sendGmailMessage;
  return send({
    db: input.db,
    userId: input.userId,
    to: input.to,
    subject: input.subject,
    body: input.body,
    attachments,
  });
}

export const __gmailToolExecutorInternals = {
  MAX_GMAIL_ATTACHMENT_BYTES,
};
