/**
 * Enlaces de descarga de documentos del caso sin sesión web (p. ej. Telegram).
 * El middleware redirige /api/operational-cases/.../download a /login si no hay cookie.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { siteBaseUrl } from "./generated-case-document";

/** TTL por defecto para enlaces en notificaciones externas. */
export const CASE_DOCUMENT_DOWNLOAD_TOKEN_TTL_SECONDS = 48 * 60 * 60;

export type CaseDocumentDownloadTokenPayload = {
  caseId: string;
  userId: string;
  documentKey: string;
  /** Presente en tokens legacy (path embebido); los nuevos usan huella `h`. */
  outputPath?: string;
  pathFingerprint?: string;
  exp: number;
};

type CompactTokenBodyV2 = {
  c: string;
  u: string;
  d: string;
  e: number;
  h: string;
};

type CompactTokenBodyLegacy = {
  c: string;
  u: string;
  d: string;
  p: string;
  e: number;
};

function downloadTokenSecret(): string | null {
  const secret =
    process.env.CASE_DOCUMENT_DOWNLOAD_SECRET?.trim() ||
    process.env.CRON_SECRET?.trim() ||
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    "";
  return secret || null;
}

/** Huella corta del output_path (evita meter el path completo en la URL). */
export function caseDocumentOutputPathFingerprint(outputPath: string): string {
  return createHash("sha256")
    .update(outputPath.trim())
    .digest("base64url")
    .slice(0, 12);
}

export function createCaseDocumentDownloadToken(params: {
  caseId: string;
  userId: string;
  documentKey: string;
  outputPath: string;
  ttlSeconds?: number;
}): string | null {
  const secret = downloadTokenSecret();
  if (!secret) return null;

  const caseId = params.caseId.trim();
  const userId = params.userId.trim();
  const documentKey = params.documentKey.trim();
  const outputPath = params.outputPath.trim();
  if (!caseId || !userId || !documentKey || !outputPath) return null;

  const exp =
    Math.floor(Date.now() / 1000) +
    (params.ttlSeconds ?? CASE_DOCUMENT_DOWNLOAD_TOKEN_TTL_SECONDS);
  const body: CompactTokenBodyV2 = {
    c: caseId,
    u: userId,
    d: documentKey,
    e: exp,
    h: caseDocumentOutputPathFingerprint(outputPath),
  };
  const bodyB64 = Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
  const sig = createHmac("sha256", secret).update(bodyB64).digest("base64url");
  return `${bodyB64}.${sig}`;
}

function parseTokenBody(
  body: CompactTokenBodyV2 | CompactTokenBodyLegacy
): CaseDocumentDownloadTokenPayload | null {
  if (
    typeof body.c !== "string" ||
    typeof body.u !== "string" ||
    typeof body.d !== "string" ||
    typeof body.e !== "number"
  ) {
    return null;
  }
  if (body.e < Math.floor(Date.now() / 1000)) return null;

  if ("p" in body && typeof body.p === "string") {
    return {
      caseId: body.c.trim(),
      userId: body.u.trim(),
      documentKey: body.d.trim(),
      outputPath: body.p.trim(),
      exp: body.e,
    };
  }

  if ("h" in body && typeof body.h === "string") {
    return {
      caseId: body.c.trim(),
      userId: body.u.trim(),
      documentKey: body.d.trim(),
      pathFingerprint: body.h.trim(),
      exp: body.e,
    };
  }

  return null;
}

export function verifyCaseDocumentDownloadToken(
  token: string
): CaseDocumentDownloadTokenPayload | null {
  const secret = downloadTokenSecret();
  if (!secret) return null;

  const trimmed = token.trim();
  const dot = trimmed.lastIndexOf(".");
  if (dot <= 0) return null;

  const bodyB64 = trimmed.slice(0, dot);
  const sig = trimmed.slice(dot + 1);
  if (!bodyB64 || !sig) return null;

  const expected = createHmac("sha256", secret).update(bodyB64).digest("base64url");
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (
    sigBuf.length !== expectedBuf.length ||
    !timingSafeEqual(sigBuf, expectedBuf)
  ) {
    return null;
  }

  try {
    const body = JSON.parse(
      Buffer.from(bodyB64, "base64url").toString("utf8")
    ) as CompactTokenBodyV2 | CompactTokenBodyLegacy;
    return parseTokenBody(body);
  } catch {
    return null;
  }
}

export function buildPublicCaseDocumentDownloadUrl(token: string): string {
  const path = `/api/public/operational-cases/documents/download?token=${encodeURIComponent(token)}`;
  const base = siteBaseUrl();
  return base ? `${base}${path}` : path;
}

/** URL absoluta usable desde Telegram / correo (sin cookie de sesión). */
export function buildExternalCaseDocumentDownloadUrl(params: {
  caseId: string;
  userId: string;
  documentKey: string;
  outputPath: string;
  ttlSeconds?: number;
}): string | null {
  const token = createCaseDocumentDownloadToken(params);
  if (!token) return null;
  const url = buildPublicCaseDocumentDownloadUrl(token);
  return url.startsWith("http") ? url : null;
}
