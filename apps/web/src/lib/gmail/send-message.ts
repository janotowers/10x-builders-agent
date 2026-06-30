import type { DbClient } from "@agents/db";
import { getGoogleGmailAccessToken } from "@agents/db";

function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function buildPlainTextEmail(params: {
  to: string;
  subject: string;
  body: string;
}): string {
  const to = sanitizeHeaderValue(params.to);
  const subject = sanitizeHeaderValue(params.subject);
  const body = params.body.replace(/\r\n/g, "\n");
  return [
    `To: ${to}`,
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=UTF-8",
    "MIME-Version: 1.0",
    "",
    body,
  ].join("\r\n");
}

type GmailAttachment = {
  filename: string;
  contentType: string;
  content: Buffer;
};

function base64WithLineBreaks(content: Buffer): string {
  const encoded = content.toString("base64");
  return encoded.replace(/.{1,76}/g, "$&\r\n").trim();
}

function buildMultipartEmail(params: {
  to: string;
  subject: string;
  body: string;
  attachments: GmailAttachment[];
}): string {
  const to = sanitizeHeaderValue(params.to);
  const subject = sanitizeHeaderValue(params.subject);
  const body = params.body.replace(/\r\n/g, "\n");
  const boundary = `boundary_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;
  const lines: string[] = [
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 7bit",
    "",
    body,
  ];

  for (const attachment of params.attachments) {
    const filename = sanitizeHeaderValue(attachment.filename).replace(/"/g, "");
    const contentType =
      sanitizeHeaderValue(attachment.contentType) || "application/octet-stream";
    lines.push(
      `--${boundary}`,
      `Content-Type: ${contentType}; name="${filename}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${filename}"`,
      "",
      base64WithLineBreaks(attachment.content)
    );
  }
  lines.push(`--${boundary}--`, "");
  return lines.join("\r\n");
}

export async function sendGmailMessage(params: {
  db: DbClient;
  userId: string;
  to: string;
  subject: string;
  body: string;
  attachments?: GmailAttachment[];
}) {
  const accessToken = await getGoogleGmailAccessToken(params.db, params.userId);
  if (!accessToken) {
    return {
      ok: false as const,
      status: "gmail_not_connected" as const,
      message:
        "No hay una conexión activa de Gmail para este usuario. Conecta Gmail en Settings > Integrations > Connections.",
    };
  }

  const mime =
    params.attachments && params.attachments.length > 0
      ? buildMultipartEmail({
          to: params.to,
          subject: params.subject,
          body: params.body,
          attachments: params.attachments,
        })
      : buildPlainTextEmail({
          to: params.to,
          subject: params.subject,
          body: params.body,
        });
  const raw = Buffer.from(mime, "utf8").toString("base64url");

  const response = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw }),
    }
  );

  const payload = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!response.ok) {
    const detail =
      typeof payload.error === "string"
        ? payload.error
        : typeof payload.message === "string"
        ? payload.message
        : "gmail_send_failed";
    return {
      ok: false as const,
      status: "gmail_send_failed" as const,
      message: `No pude enviar el correo por Gmail: ${detail}`,
      details: payload,
    };
  }

  return {
    ok: true as const,
    status: "sent" as const,
    messageId:
      typeof payload.id === "string" && payload.id.trim()
        ? payload.id
        : null,
  };
}
