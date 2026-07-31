import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import * as XLSX from "xlsx";

const MAX_EXTRACTED_CHARS = 24_000;

const TEXT_EXTENSIONS = new Set([
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
]);

const TEXT_MIME_PREFIXES = ["text/"];
const TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/csv",
]);

const IMAGE_EXTENSIONS = new Set([
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
]);

function extensionForFileName(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  if (dot < 0) return "";
  return fileName.slice(dot + 1).toLowerCase();
}

function isTextLike(fileName: string, mimeType: string): boolean {
  const extension = extensionForFileName(fileName);
  if (TEXT_EXTENSIONS.has(extension)) return true;
  if (TEXT_MIME_TYPES.has(mimeType)) return true;
  return TEXT_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix));
}

/** Paridad Telegram: fotos del inmueble en chat (photos_requested / adjuntos). */
export function isChatImageAttachment(params: {
  fileName: string;
  mimeType: string;
}): boolean {
  const mime = params.mimeType.toLowerCase();
  if (mime.startsWith("image/")) return true;
  return IMAGE_EXTENSIONS.has(extensionForFileName(params.fileName));
}

function truncateExtractedText(text: string): {
  text: string;
  truncated: boolean;
} {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (normalized.length <= MAX_EXTRACTED_CHARS) {
    return { text: normalized, truncated: false };
  }
  return {
    text: `${normalized.slice(0, MAX_EXTRACTED_CHARS)}\n\n[... contenido truncado ...]`,
    truncated: true,
  };
}

async function extractPdfText(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return result.text ?? "";
  } finally {
    await parser.destroy();
  }
}

async function extractDocxText(buffer: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer });
  return result.value ?? "";
}

async function extractXlsxText(buffer: Buffer): Promise<string> {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheets: string[] = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const csv = XLSX.utils.sheet_to_csv(sheet).trim();
    if (csv) {
      sheets.push(`## Hoja: ${sheetName}\n${csv}`);
    }
  }
  return sheets.join("\n\n");
}

export async function extractAttachmentText(params: {
  fileName: string;
  mimeType: string;
  buffer: Buffer;
}): Promise<{ text: string; truncated: boolean }> {
  const { fileName, mimeType, buffer } = params;
  const lowerMime = mimeType.toLowerCase();

  const extension = extensionForFileName(fileName);

  // Imágenes: sin OCR; se staged y el caso las registra en raw_photos
  // (paridad Telegram sendPhoto / document image).
  if (isChatImageAttachment({ fileName, mimeType: lowerMime })) {
    return {
      text: `[Imagen adjunta: ${fileName}]`,
      truncated: false,
    };
  }

  if (lowerMime === "application/pdf" || extension === "pdf") {
    const text = await extractPdfText(buffer);
    return truncateExtractedText(text);
  }

  if (
    extension === "docx" ||
    lowerMime ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    const text = await extractDocxText(buffer);
    return truncateExtractedText(text);
  }

  if (
    extension === "xlsx" ||
    lowerMime ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  ) {
    const text = await extractXlsxText(buffer);
    return truncateExtractedText(text);
  }

  if (isTextLike(fileName, lowerMime)) {
    const text = buffer.toString("utf8");
    return truncateExtractedText(text);
  }

  throw new Error(
    "Tipo de archivo no soportado. Usa fotos (JPG/PNG/WebP/HEIC), PDF, Word (.docx), Excel (.xlsx) o archivos de texto (.txt, .md, .csv, .json)."
  );
}

export const CHAT_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
/** Fotos de teléfono suelen superar 5 MB; Telegram acepta ~10 MB. */
export const CHAT_IMAGE_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

export const CHAT_ATTACHMENT_ACCEPT =
  "image/*,.jpg,.jpeg,.png,.webp,.heic,.heif,.gif,.bmp,.tif,.tiff,.pdf,.docx,.xlsx,.txt,.md,.csv,.json,.xml,.html,.log,.yaml,.yml,text/*,application/pdf,application/json,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
