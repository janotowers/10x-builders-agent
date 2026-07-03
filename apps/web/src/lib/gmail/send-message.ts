import type { DbClient } from "@agents/db";
import { getGoogleGmailAccessToken } from "@agents/db";

function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function containsOnlyAscii(value: string): boolean {
  return /^[\x20-\x7E]*$/.test(value);
}

function encodeMimeHeaderValue(value: string): string {
  const sanitized = sanitizeHeaderValue(value);
  if (!sanitized) return "";
  if (containsOnlyAscii(sanitized)) return sanitized;
  return `=?UTF-8?B?${Buffer.from(sanitized, "utf8").toString("base64")}?=`;
}

function encodeHeaderParamUtf8(value: string): string {
  return encodeURIComponent(sanitizeHeaderValue(value))
    .replace(/['()]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/\*/g, "%2A");
}

function encodeTextPartBase64(value: string): string {
  return base64WithLineBreaks(Buffer.from(value.replace(/\r\n/g, "\n"), "utf8"));
}

function buildPlainTextEmail(params: {
  to: string;
  subject: string;
  body: string;
}): string {
  const to = sanitizeHeaderValue(params.to);
  const subject = encodeMimeHeaderValue(params.subject);
  return [
    `To: ${to}`,
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "MIME-Version: 1.0",
    "",
    encodeTextPartBase64(params.body),
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
  const subject = encodeMimeHeaderValue(params.subject);
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
    "Content-Transfer-Encoding: base64",
    "",
    encodeTextPartBase64(params.body),
  ];

  for (const attachment of params.attachments) {
    const filename = sanitizeHeaderValue(attachment.filename).replace(/"/g, "");
    const encodedFilename = encodeHeaderParamUtf8(filename);
    const contentType =
      sanitizeHeaderValue(attachment.contentType) || "application/octet-stream";
    lines.push(
      `--${boundary}`,
      `Content-Type: ${contentType}; name="${filename}"; name*=UTF-8''${encodedFilename}`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${filename}"; filename*=UTF-8''${encodedFilename}`,
      "",
      base64WithLineBreaks(attachment.content)
    );
  }
  lines.push(`--${boundary}--`, "");
  return lines.join("\r\n");
}

export const __gmailMimeInternals = {
  encodeMimeHeaderValue,
  buildPlainTextEmail,
  buildMultipartEmail,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Gmail/Google API errors usually arrive as `{ error: { code, message,
 * status, errors: [{ reason, message }] } }`, not as a plain string. The
 * previous implementation only handled the string case and collapsed
 * everything else to a generic `gmail_send_failed`, hiding the real cause
 * (bad scope, disabled API, revoked token, etc). This extracts a useful
 * human-readable detail plus a machine-readable code/reason for auditing.
 */
function parseGmailErrorPayload(
  payload: Record<string, unknown>,
  httpStatus: number
): { detail: string; code: string | number | null; reason: string | null } {
  const rawError = payload.error;

  if (isRecord(rawError)) {
    const message =
      typeof rawError.message === "string" && rawError.message.trim()
        ? rawError.message.trim()
        : null;
    const status =
      typeof rawError.status === "string" && rawError.status.trim()
        ? rawError.status.trim()
        : null;
    const code =
      typeof rawError.code === "number" || typeof rawError.code === "string"
        ? rawError.code
        : httpStatus;
    let reason: string | null = status;
    const errorsList = rawError.errors;
    if (Array.isArray(errorsList) && errorsList.length > 0) {
      const first = errorsList[0];
      if (isRecord(first) && typeof first.reason === "string" && first.reason.trim()) {
        reason = first.reason.trim();
      }
    }
    const detail = message ?? status ?? `HTTP ${httpStatus}`;
    return { detail, code, reason };
  }

  if (typeof rawError === "string" && rawError.trim()) {
    return { detail: rawError.trim(), code: httpStatus, reason: null };
  }
  if (typeof payload.message === "string" && payload.message.trim()) {
    return { detail: payload.message.trim(), code: httpStatus, reason: null };
  }
  return { detail: `HTTP ${httpStatus}`, code: httpStatus, reason: null };
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
    const { detail, code, reason } = parseGmailErrorPayload(payload, response.status);
    return {
      ok: false as const,
      status: "gmail_send_failed" as const,
      message: `No pude enviar el correo por Gmail: ${detail}`,
      errorCode: code,
      errorReason: reason,
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
