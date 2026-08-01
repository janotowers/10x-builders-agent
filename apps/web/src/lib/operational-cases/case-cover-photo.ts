/**
 * Portada de caso para previews web (p. ej. resumen final ↔ EasyBroker).
 * Telegram ya obtiene OG del link; en chat web usamos foto del caso.
 */
import { CASE_DOCUMENTS_BUCKET } from "@agents/db";
import {
  normalizePhotoSourcePath,
  parsePhotoManifest,
  resolveRawPhotoPaths,
} from "./photo-manifest";

export type CaseCoverStorageRef = {
  kind: "storage";
  bucket: string;
  path: string;
  contentType: string;
};

export type CaseCoverExternalUrl = {
  kind: "url";
  url: string;
  contentType: string;
};

export type CaseCoverPhotoRef = CaseCoverStorageRef | CaseCoverExternalUrl;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function guessImageContentType(pathOrUrl: string): string {
  const lower = pathOrUrl.toLowerCase().split("?")[0] ?? pathOrUrl.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  return "image/jpeg";
}

export function parseStorageRef(ref: string): {
  bucket: string;
  path: string;
} | null {
  const normalized = normalizePhotoSourcePath(ref);
  if (!normalized || /^https?:\/\//i.test(normalized)) return null;
  const idx = normalized.indexOf(":");
  if (idx <= 0) {
    return {
      bucket: CASE_DOCUMENTS_BUCKET,
      path: normalized.replace(/^\/+/, ""),
    };
  }
  const bucket = normalized.slice(0, idx).trim();
  const path = normalized.slice(idx + 1).replace(/^\/+/, "");
  if (!bucket || !path) return null;
  return { bucket, path };
}

export function caseCoverPhotoApiPath(caseId: string): string {
  return `/api/operational-cases/${encodeURIComponent(caseId)}/photos/cover`;
}

function asHttpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const url = value.trim();
  return /^https?:\/\//i.test(url) ? url : null;
}

/**
 * Túneles / localhost no sirven bien como `<img>` (intersticial ngrok, host caído).
 * Se omiten incluso como fallback de `public_url`.
 */
export function isUnreliableCoverPublicUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host.endsWith(".ngrok-free.dev") ||
      host.endsWith(".ngrok-free.app") ||
      host.endsWith(".ngrok.io") ||
      host.endsWith(".ngrok.app") ||
      host.endsWith(".loca.lt") ||
      host.endsWith(".trycloudflare.com")
    );
  } catch {
    return true;
  }
}

function coverFromHttpUrl(url: string): CaseCoverExternalUrl | null {
  if (isUnreliableCoverPublicUrl(url)) return null;
  return {
    kind: "url",
    url,
    contentType: guessImageContentType(url),
  };
}

function coverFromStoragePath(path: string): CaseCoverStorageRef | null {
  const storage = parseStorageRef(path);
  if (!storage) return null;
  return {
    kind: "storage",
    bucket: storage.bucket,
    path: storage.path,
    contentType: guessImageContentType(storage.path),
  };
}

/**
 * Portada del caso: prioriza storage durable; `public_url` solo como fallback
 * (y nunca túneles/dev hosts).
 */
export function resolveCaseCoverPhotoRef(
  contextJsonb: unknown
): CaseCoverPhotoRef | null {
  const context = isRecord(contextJsonb) ? contextJsonb : {};
  const manifest = parsePhotoManifest(context.photo_manifest);
  const first = manifest[0];
  if (first) {
    const preferred =
      (typeof first.watermarked_path === "string" &&
        first.watermarked_path.trim()) ||
      first.source_path;
    if (preferred) {
      const preferredUrl = asHttpUrl(preferred);
      if (preferredUrl) {
        const fromUrl = coverFromHttpUrl(preferredUrl);
        if (fromUrl) return fromUrl;
      } else {
        const fromStorage = coverFromStoragePath(preferred);
        if (fromStorage) return fromStorage;
      }
    }

    const publicUrl = asHttpUrl(first.public_url);
    if (publicUrl) {
      const fromPublic = coverFromHttpUrl(publicUrl);
      if (fromPublic) return fromPublic;
    }
  }

  const rawPath = resolveRawPhotoPaths(context.raw_photos)[0];
  if (!rawPath) return null;
  const rawUrl = asHttpUrl(rawPath);
  if (rawUrl) return coverFromHttpUrl(rawUrl);
  return coverFromStoragePath(rawPath);
}

export function extractEasybrokerUrlFromContext(
  contextJsonb: unknown
): string | null {
  const context = isRecord(contextJsonb) ? contextJsonb : {};
  const published = isRecord(context.published) ? context.published : {};
  const easybroker = isRecord(published.easybroker)
    ? published.easybroker
    : {};
  for (const key of ["public_url", "url", "agent_url"] as const) {
    const value = easybroker[key];
    if (typeof value === "string" && /^https?:\/\//i.test(value.trim())) {
      return value.trim();
    }
  }
  return null;
}

/** Extrae URL EasyBroker del texto del resumen final (mensajes ya espejados). */
export function extractEasybrokerUrlFromSummaryText(text: string): string | null {
  const labeled = text.match(
    /EasyBroker:\s*(https?:\/\/[^\s)\]>"']+)/i
  );
  if (labeled?.[1]) return labeled[1];
  const bare = text.match(
    /https?:\/\/(?:www\.)?easybroker\.com\/[^\s)\]>"']+/i
  );
  return bare?.[0] ?? null;
}

export type ListingPublishedCoverAttachment = {
  fileName: string;
  downloadUrl: string;
  contentType: string;
  href?: string;
  label?: string;
};

/**
 * Adjunto de portada para espejo web del resumen final.
 * `downloadUrl` es ruta estable autenticada (no signed URL efímera).
 */
export function buildListingPublishedSummaryCoverAttachment(params: {
  caseId: string;
  contextJsonb?: unknown;
  text?: string;
}): ListingPublishedCoverAttachment | null {
  const caseId = params.caseId.trim();
  if (!caseId) return null;

  if (
    params.contextJsonb !== undefined &&
    !resolveCaseCoverPhotoRef(params.contextJsonb)
  ) {
    return null;
  }

  const href =
    extractEasybrokerUrlFromContext(params.contextJsonb) ??
    (typeof params.text === "string"
      ? extractEasybrokerUrlFromSummaryText(params.text)
      : null);

  return {
    fileName: "Portada de la propiedad",
    downloadUrl: caseCoverPhotoApiPath(caseId),
    contentType: "image/jpeg",
    ...(href ? { href, label: "Ver en EasyBroker" } : {}),
  };
}
