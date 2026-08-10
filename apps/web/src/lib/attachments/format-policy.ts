export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
export const ATTACHMENT_MAX_ZIP_ENTRIES = 2_000;
export const ATTACHMENT_MAX_ZIP_ENTRY_BYTES = 20 * 1024 * 1024;
export const ATTACHMENT_MAX_ZIP_UNCOMPRESSED_BYTES = 60 * 1024 * 1024;
export const ATTACHMENT_MAX_ZIP_COMPRESSION_RATIO = 100;

export type AttachmentFormat =
  | "pdf"
  | "docx"
  | "xlsx"
  | "pptx"
  | "text"
  | "image";

export interface AttachmentFormatRule {
  format: AttachmentFormat;
  extensions: readonly string[];
  mimeTypes: readonly string[];
  zipContainer: boolean;
}

const RULES: readonly AttachmentFormatRule[] = [
  {
    format: "pdf",
    extensions: ["pdf"],
    mimeTypes: ["application/pdf"],
    zipContainer: false,
  },
  {
    format: "docx",
    extensions: ["docx"],
    mimeTypes: [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
    zipContainer: true,
  },
  {
    format: "xlsx",
    extensions: ["xlsx"],
    mimeTypes: [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ],
    zipContainer: true,
  },
  {
    format: "pptx",
    extensions: ["pptx"],
    mimeTypes: [
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ],
    zipContainer: true,
  },
  {
    format: "text",
    extensions: [
      "txt",
      "md",
      "csv",
      "json",
      "xml",
      "html",
      "htm",
      "log",
      "yaml",
      "yml",
    ],
    mimeTypes: [
      "text/plain",
      "text/markdown",
      "text/csv",
      "text/xml",
      "text/html",
      "text/yaml",
      "application/json",
      "application/xml",
      "application/csv",
    ],
    zipContainer: false,
  },
  {
    format: "image",
    extensions: [
      "jpg",
      "jpeg",
      "png",
      "webp",
      "heic",
      "heif",
      "gif",
      "bmp",
      "tif",
      "tiff",
    ],
    mimeTypes: [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/heic",
      "image/heif",
      "image/gif",
      "image/bmp",
      "image/tiff",
    ],
    zipContainer: false,
  },
] as const;

const REJECTED_EXTENSIONS = new Map<string, string>([
  ["doc", "legacy_doc_not_supported"],
  ["dot", "legacy_doc_not_supported"],
  ["xls", "legacy_xls_parser_unsafe"],
  ["docm", "macro_format_not_supported"],
  ["dotm", "macro_format_not_supported"],
  ["xlsm", "macro_format_not_supported"],
  ["xltm", "macro_format_not_supported"],
  ["xlam", "macro_format_not_supported"],
  ["pptm", "macro_format_not_supported"],
  ["potm", "macro_format_not_supported"],
  ["ppsm", "macro_format_not_supported"],
]);

const GENERIC_MIME_TYPES = new Set(["", "application/octet-stream"]);

export function attachmentExtension(fileName: string): string {
  const normalized = fileName.trim();
  const dot = normalized.lastIndexOf(".");
  return dot >= 0 ? normalized.slice(dot + 1).toLowerCase() : "";
}

export type AttachmentValidationResult =
  | {
      ok: true;
      format: AttachmentFormat;
      extension: string;
      mimeType: string;
      zipContainer: boolean;
      maxBytes: number;
    }
  | {
      ok: false;
      code:
        | "empty_file"
        | "file_too_large"
        | "missing_extension"
        | "legacy_doc_not_supported"
        | "legacy_xls_parser_unsafe"
        | "macro_format_not_supported"
        | "unsupported_extension"
        | "mime_extension_mismatch";
      message: string;
    };

export function validateAttachmentMetadata(params: {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  maxBytes?: number;
}): AttachmentValidationResult {
  const maxBytes = params.maxBytes ?? ATTACHMENT_MAX_BYTES;
  if (!Number.isSafeInteger(params.sizeBytes) || params.sizeBytes <= 0) {
    return { ok: false, code: "empty_file", message: "File must not be empty." };
  }
  if (params.sizeBytes > maxBytes) {
    return {
      ok: false,
      code: "file_too_large",
      message: `File exceeds the ${maxBytes} byte limit.`,
    };
  }

  const extension = attachmentExtension(params.fileName);
  if (!extension) {
    return {
      ok: false,
      code: "missing_extension",
      message: "A supported file extension is required.",
    };
  }
  const explicitRejection = REJECTED_EXTENSIONS.get(extension);
  if (explicitRejection) {
    return {
      ok: false,
      code: explicitRejection as
        | "legacy_doc_not_supported"
        | "legacy_xls_parser_unsafe"
        | "macro_format_not_supported",
      message:
        explicitRejection === "legacy_doc_not_supported"
          ? "Legacy Word .doc files are not supported; convert to .docx."
          : explicitRejection === "legacy_xls_parser_unsafe"
            ? "Legacy Excel .xls files are disabled because the available parser has unresolved security advisories; convert to .xlsx."
          : "Macro-enabled Office formats are not supported.",
    };
  }

  const rule = RULES.find((candidate) =>
    candidate.extensions.includes(extension)
  );
  if (!rule) {
    return {
      ok: false,
      code: "unsupported_extension",
      message: `Unsupported file extension: .${extension}`,
    };
  }

  const mimeType = params.mimeType.trim().toLowerCase().split(";")[0] ?? "";
  const mimeMatches =
    GENERIC_MIME_TYPES.has(mimeType) ||
    rule.mimeTypes.includes(mimeType) ||
    (rule.format === "text" && mimeType.startsWith("text/"));
  if (!mimeMatches) {
    return {
      ok: false,
      code: "mime_extension_mismatch",
      message: `MIME type ${mimeType || "(empty)"} does not match .${extension}.`,
    };
  }

  return {
    ok: true,
    format: rule.format,
    extension,
    mimeType: mimeType || "application/octet-stream",
    zipContainer: rule.zipContainer,
    maxBytes,
  };
}

export interface ZipEntryMetrics {
  name: string;
  compressedBytes: number;
  uncompressedBytes: number;
  directory?: boolean;
}

export type ZipGuardResult =
  | { ok: true; entryCount: number; uncompressedBytes: number }
  | {
      ok: false;
      code:
        | "zip_too_many_entries"
        | "zip_entry_too_large"
        | "zip_uncompressed_too_large"
        | "zip_compression_ratio_too_high";
      entry?: string;
    };

/**
 * Pure guard contract for ZIP-based Office files. Callers must obtain metrics
 * from the archive central directory before inflating entry contents.
 */
export function validateZipMetrics(
  entries: readonly ZipEntryMetrics[]
): ZipGuardResult {
  const files = entries.filter((entry) => !entry.directory);
  if (files.length > ATTACHMENT_MAX_ZIP_ENTRIES) {
    return { ok: false, code: "zip_too_many_entries" };
  }

  let total = 0;
  for (const entry of files) {
    if (entry.uncompressedBytes > ATTACHMENT_MAX_ZIP_ENTRY_BYTES) {
      return {
        ok: false,
        code: "zip_entry_too_large",
        entry: entry.name,
      };
    }
    total += entry.uncompressedBytes;
    if (total > ATTACHMENT_MAX_ZIP_UNCOMPRESSED_BYTES) {
      return {
        ok: false,
        code: "zip_uncompressed_too_large",
        entry: entry.name,
      };
    }
    const denominator = Math.max(1, entry.compressedBytes);
    if (
      entry.uncompressedBytes / denominator >
      ATTACHMENT_MAX_ZIP_COMPRESSION_RATIO
    ) {
      return {
        ok: false,
        code: "zip_compression_ratio_too_high",
        entry: entry.name,
      };
    }
  }
  return { ok: true, entryCount: files.length, uncompressedBytes: total };
}
