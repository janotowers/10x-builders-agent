import JSZip, { type JSZipObject } from "jszip";
import { extractAttachmentText } from "@/lib/chat/extract-attachment-text";
import {
  validateAttachmentMetadata,
  validateZipMetrics,
  type ZipEntryMetrics,
} from "./format-policy";

const MAX_EXTRACTED_CHARS = 24_000;

type ZipObjectWithMetrics = JSZipObject & {
  _data?: {
    compressedSize?: number;
    uncompressedSize?: number;
  };
  unsafeOriginalName?: string;
};

function zipEntryMetrics(entry: JSZipObject): ZipEntryMetrics {
  const internal = entry as ZipObjectWithMetrics;
  const compressedBytes = internal._data?.compressedSize;
  const uncompressedBytes = internal._data?.uncompressedSize;
  if (
    !entry.dir &&
    (!Number.isSafeInteger(compressedBytes) ||
      !Number.isSafeInteger(uncompressedBytes) ||
      compressedBytes === undefined ||
      uncompressedBytes === undefined ||
      compressedBytes < 0 ||
      uncompressedBytes < 0)
  ) {
    throw new Error("attachment_zip_metrics_unavailable");
  }
  return {
    name: entry.name,
    compressedBytes: compressedBytes ?? 0,
    uncompressedBytes: uncompressedBytes ?? 0,
    directory: entry.dir,
  };
}

function assertSafeZipEntryName(entry: JSZipObject): void {
  const unsafeName = (entry as ZipObjectWithMetrics).unsafeOriginalName;
  const name = unsafeName ?? entry.name;
  const segments = name.replace(/\\/g, "/").split("/");
  if (
    name.startsWith("/") ||
    /^[a-zA-Z]:/.test(name) ||
    segments.some((segment) => segment === "..")
  ) {
    throw new Error("attachment_zip_unsafe_path");
  }
}

export async function loadGuardedOfficeArchive(
  bytes: Uint8Array
): Promise<JSZip> {
  const zip = await JSZip.loadAsync(bytes, {
    createFolders: false,
    checkCRC32: false,
  });
  const entries = Object.values(zip.files);
  entries.forEach(assertSafeZipEntryName);
  const guard = validateZipMetrics(entries.map(zipEntryMetrics));
  if (!guard.ok) throw new Error(`attachment_zip_guard:${guard.code}`);
  return zip;
}

function truncate(text: string): { text: string; truncated: boolean } {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (normalized.length <= MAX_EXTRACTED_CHARS) {
    return { text: normalized, truncated: false };
  }
  return {
    text: `${normalized.slice(0, MAX_EXTRACTED_CHARS)}\n\n[... content truncated ...]`,
    truncated: true,
  };
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCodePoint(Number(code))
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16))
    )
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

async function extractPptxText(zip: JSZip): Promise<string> {
  const slides = Object.values(zip.files)
    .filter(
      (entry) =>
        !entry.dir && /^ppt\/slides\/slide\d+\.xml$/i.test(entry.name)
    )
    .sort((a, b) => {
      const aNumber = Number(a.name.match(/slide(\d+)\.xml$/i)?.[1] ?? 0);
      const bNumber = Number(b.name.match(/slide(\d+)\.xml$/i)?.[1] ?? 0);
      return aNumber - bNumber;
    });
  const extracted: string[] = [];
  for (const [index, slide] of slides.entries()) {
    const xml = await slide.async("string");
    const runs = [...xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/gi)]
      .map((match) => decodeXmlText(match[1] ?? "").trim())
      .filter(Boolean);
    if (runs.length > 0) {
      extracted.push(`## Slide ${index + 1}\n${runs.join(" ")}`);
    }
  }
  return extracted.join("\n\n");
}

/**
 * Validates the MIME/extension/size matrix before extraction. ZIP-based Office
 * formats are central-directory guarded before mammoth/xlsx/slide inflation.
 */
export async function extractValidatedAttachmentText(params: {
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
}): Promise<{ text: string; truncated: boolean }> {
  const validation = validateAttachmentMetadata({
    fileName: params.fileName,
    mimeType: params.mimeType,
    sizeBytes: params.bytes.byteLength,
  });
  if (!validation.ok) {
    throw new Error(`attachment_validation:${validation.code}`);
  }

  let guardedZip: JSZip | null = null;
  if (validation.zipContainer) {
    guardedZip = await loadGuardedOfficeArchive(params.bytes);
  }
  if (validation.format === "pptx") {
    return truncate(await extractPptxText(guardedZip!));
  }

  return extractAttachmentText({
    fileName: params.fileName,
    mimeType: validation.mimeType,
    buffer: Buffer.from(params.bytes),
  });
}
