import assert from "node:assert/strict";
import JSZip from "jszip";
import type { AttachmentEnvelope, RuntimeInputAttachment, UserFile } from "@agents/types";
import {
  readRuntimeAttachment,
  searchRuntimeAttachments,
} from "@agents/agent";
import {
  normalizeAttachmentEnvelope,
  normalizeAttachmentEnvelopes,
} from "./envelope";
import { extractValidatedAttachmentText } from "./extraction";
import {
  assertRuntimeAttachmentEligible,
  AttachmentRuntimeError,
} from "./runtime";
import {
  ATTACHMENT_MAX_ZIP_ENTRY_BYTES,
  validateAttachmentMetadata,
  validateZipMetrics,
} from "./format-policy";
import {
  buildUserFileStoragePath,
  isOwnedUserFilePath,
  prepareAttachmentForStorage,
  safeAttachmentPathSegment,
  sha256Hex,
  storeAttachment,
  type AttachmentStoragePort,
} from "./storage";

function testFormatMatrix(): void {
  const accepted = [
    ["report.pdf", "application/pdf", "pdf"],
    [
      "contract.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "docx",
    ],
    [
      "book.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "xlsx",
    ],
    [
      "deck.pptx",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "pptx",
    ],
    ["notes.txt", "text/plain; charset=utf-8", "text"],
    ["photo.png", "image/png", "image"],
  ] as const;
  for (const [fileName, mimeType, expectedFormat] of accepted) {
    const result = validateAttachmentMetadata({
      fileName,
      mimeType,
      sizeBytes: 10,
    });
    assert.equal(result.ok, true, fileName);
    if (result.ok) assert.equal(result.format, expectedFormat);
  }

  const legacyDoc = validateAttachmentMetadata({
    fileName: "legacy.doc",
    mimeType: "application/msword",
    sizeBytes: 10,
  });
  assert.equal(legacyDoc.ok, false);
  if (!legacyDoc.ok) assert.equal(legacyDoc.code, "legacy_doc_not_supported");

  const legacyXls = validateAttachmentMetadata({
    fileName: "legacy.xls",
    mimeType: "application/vnd.ms-excel",
    sizeBytes: 10,
  });
  assert.equal(legacyXls.ok, false);
  if (!legacyXls.ok) assert.equal(legacyXls.code, "legacy_xls_parser_unsafe");
  // Studio must not promise .xls until a safe extractor ships; keep rejection explicit.
  assert.notEqual(legacyXls.ok, true, ".xls remains rejected");

  for (const fileName of ["macro.docm", "macro.xlsm", "macro.pptm"]) {
    const result = validateAttachmentMetadata({
      fileName,
      mimeType: "application/octet-stream",
      sizeBytes: 10,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "macro_format_not_supported");
  }

  const spoofed = validateAttachmentMetadata({
    fileName: "photo.png",
    mimeType: "application/pdf",
    sizeBytes: 10,
  });
  assert.equal(spoofed.ok, false);
  if (!spoofed.ok) assert.equal(spoofed.code, "mime_extension_mismatch");
}

function testHashesAndPaths(): void {
  assert.equal(
    sha256Hex(Buffer.from("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
  );
  assert.equal(safeAttachmentPathSegment("../../ Résumé 2026.pdf"), "Resume-2026.pdf");
  const path = buildUserFileStoragePath({
    userId: "user_1",
    fileId: "file_1",
    fileName: "../../ Résumé 2026.pdf",
  });
  assert.equal(path, "users/user_1/uploads/file_1/Resume-2026.pdf");
  assert.equal(isOwnedUserFilePath(path, "user_1"), true);
  assert.equal(
    isOwnedUserFilePath("users/other/uploads/file_1/report.pdf", "user_1"),
    false
  );
  assert.equal(
    isOwnedUserFilePath("users/user_1/uploads/../other/report.pdf", "user_1"),
    false
  );
}

function testLegacyEnvelopeMigration(): void {
  const legacy = {
    fileName: "predial.pdf",
    mimeType: "application/pdf",
    sizeBytes: 123,
    storageBucket: "case-documents",
    storagePath: "user_1/chat-staging/predial.pdf",
    sha256: "legacy-hash-value",
    suggestedKind: "predial",
  };
  assert.deepEqual(normalizeAttachmentEnvelope(legacy, { userId: "user_1" }), {
    version: 1,
    ...legacy,
  });
  assert.equal(
    normalizeAttachmentEnvelope(
      { ...legacy, storagePath: "other/chat-staging/predial.pdf" },
      { userId: "user_1" }
    ),
    null
  );
  const current = {
    version: 1,
    ...legacy,
    storageBucket: "user-files",
    storagePath: "users/user_1/uploads/file_1/predial.pdf",
    fileId: "file_1",
    channel: "web",
    role: "input",
  };
  assert.deepEqual(
    normalizeAttachmentEnvelopes([null, current], { userId: "user_1" }),
    [current]
  );
}

function testZipGuardContract(): void {
  assert.deepEqual(
    validateZipMetrics([
      { name: "safe.xml", compressedBytes: 50, uncompressedBytes: 100 },
    ]),
    { ok: true, entryCount: 1, uncompressedBytes: 100 }
  );
  const oversized = validateZipMetrics([
    {
      name: "huge.xml",
      compressedBytes: 1_000_000,
      uncompressedBytes: ATTACHMENT_MAX_ZIP_ENTRY_BYTES + 1,
    },
  ]);
  assert.equal(oversized.ok, false);
  if (!oversized.ok) assert.equal(oversized.code, "zip_entry_too_large");

  const bomb = validateZipMetrics([
    { name: "bomb.xml", compressedBytes: 1, uncompressedBytes: 101 },
  ]);
  assert.equal(bomb.ok, false);
  if (!bomb.ok) assert.equal(bomb.code, "zip_compression_ratio_too_high");
}

async function testStorageSeam(): Promise<void> {
  const bytes = Buffer.from("hello");
  const uploads: Array<{ path: string; bytes: Uint8Array }> = [];
  const storage: AttachmentStoragePort = {
    async upload(input) {
      uploads.push({ path: input.path, bytes: input.bytes });
    },
    async download() {
      return bytes;
    },
    async remove() {},
  };
  const prepared = prepareAttachmentForStorage({
    userId: "user_1",
    fileId: "file_1",
    fileName: "notes.txt",
    mimeType: "text/plain",
    bytes,
  });
  const stored = await storeAttachment(storage, {
    userId: "user_1",
    fileId: "file_1",
    fileName: "notes.txt",
    mimeType: "text/plain",
    bytes,
  });
  assert.deepEqual(stored, prepared);
  assert.equal(uploads[0]?.path, "users/user_1/uploads/file_1/notes.txt");
  assert.equal(uploads[0]?.bytes, bytes);
}

async function testPptxExtraction(): Promise<void> {
  const deck = new JSZip();
  deck.file(
    "ppt/slides/slide1.xml",
    '<p:sld xmlns:a="a" xmlns:p="p"><a:t>Quarter &amp; Results</a:t><a:t>42%</a:t></p:sld>'
  );
  const pptxBytes = await deck.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
  });
  const pptx = await extractValidatedAttachmentText({
    fileName: "results.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    bytes: pptxBytes,
  });
  assert.match(pptx.text, /Quarter & Results 42%/);
}

function runtimeFile(overrides: Partial<UserFile> = {}): UserFile {
  return {
    id: "file_1",
    user_id: "user_1",
    bucket: "user-files",
    path: "users/user_1/uploads/file_1/notes.txt",
    original_name: "notes.txt",
    mime_type: "text/plain",
    size_bytes: 11,
    sha256: "a".repeat(64),
    source: "upload",
    status: "ready",
    validation_status: "accepted",
    validation_metadata_jsonb: { format: "text" },
    scan_status: "not_scanned",
    scan_metadata_jsonb: {},
    processing_error_jsonb: null,
    metadata_jsonb: {},
    retention: "standard",
    expires_at: null,
    processing_started_at: null,
    ready_at: new Date(0).toISOString(),
    deleted_at: null,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    ...overrides,
  };
}

function runtimeEnvelope(
  channel: "web" | "telegram" = "web"
): AttachmentEnvelope {
  return {
    version: 1,
    fileId: "file_1",
    fileName: "notes.txt",
    mimeType: "text/plain",
    sizeBytes: 11,
    storageBucket: "user-files",
    storagePath: "users/user_1/uploads/file_1/notes.txt",
    sha256: "a".repeat(64),
    channel,
    role: "input",
  };
}

function testRuntimeEligibilityAndChannelParity(): void {
  assert.doesNotThrow(() =>
    assertRuntimeAttachmentEligible({
      file: runtimeFile(),
      envelope: runtimeEnvelope("web"),
      userId: "user_1",
    })
  );
  for (const file of [
    runtimeFile({ user_id: "other" }),
    runtimeFile({ status: "processing" }),
    runtimeFile({ validation_status: "rejected" }),
    runtimeFile({ scan_status: "flagged" }),
  ]) {
    assert.throws(
      () =>
        assertRuntimeAttachmentEligible({
          file,
          envelope: runtimeEnvelope(),
          userId: "user_1",
        }),
      AttachmentRuntimeError
    );
  }
  const web = runtimeEnvelope("web");
  const telegram = runtimeEnvelope("telegram");
  assert.deepEqual(
    { ...web, channel: undefined },
    { ...telegram, channel: undefined }
  );
}

async function testTelegramDocxAndTxtPath(): Promise<void> {
  const txt = await extractValidatedAttachmentText({
    fileName: "telegram-note.txt",
    mimeType: "text/plain",
    bytes: Buffer.from("telegram text evidence"),
  });
  assert.equal(txt.text, "telegram text evidence");

  const docx = new JSZip();
  docx.file(
    "[Content_Types].xml",
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
  );
  docx.file(
    "_rels/.rels",
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
  );
  docx.file(
    "word/document.xml",
    '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Telegram DOCX evidence</w:t></w:r></w:p></w:body></w:document>'
  );
  const bytes = await docx.generateAsync({ type: "uint8array" });
  const extracted = await extractValidatedAttachmentText({
    fileName: "telegram.docx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    bytes,
  });
  assert.match(extracted.text, /Telegram DOCX evidence/);
}

function testBoundedRuntimeReadAndSearch(): void {
  const attachment: RuntimeInputAttachment = {
    id: "file_1",
    fileName: "notes.txt",
    mimeType: "text/plain",
    sizeBytes: 30_000,
    sha256: "a".repeat(64),
    channel: "telegram",
    role: "input",
    format: "text",
    extractedText: `${"x".repeat(13_000)} needle ${"y".repeat(500)}`,
    provenance: {
      kind: "message_attachment",
      sessionId: "session_1",
      turnId: "turn_1",
      source: "external_copy",
      validationStatus: "accepted",
      scanStatus: "not_scanned",
    },
  };
  const runtimeInput = { attachments: [attachment] };
  const read = readRuntimeAttachment(runtimeInput, {
    attachmentId: "file_1",
    maxChars: 99_999,
  });
  assert.equal(read.status, "ok");
  if (read.status === "ok") assert.equal(read.text.length, 12_000);
  const search = searchRuntimeAttachments(runtimeInput, {
    query: "needle",
    maxResults: 99,
  });
  assert.equal(search.status, "ok");
  if (search.status === "ok") {
    assert.equal(search.count, 1);
    assert.ok(String(search.matches[0]?.snippet).length <= 246);
  }
}

async function main(): Promise<void> {
  testFormatMatrix();
  testHashesAndPaths();
  testLegacyEnvelopeMigration();
  testZipGuardContract();
  await testStorageSeam();
  await testPptxExtraction();
  testRuntimeEligibilityAndChannelParity();
  await testTelegramDocxAndTxtPath();
  testBoundedRuntimeReadAndSearch();
  console.log("attachments.selftest: all 9 cases passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
