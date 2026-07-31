import assert from "node:assert/strict";
import { looksLikeDocumentBatchComplete } from "@/lib/operational-cases/document-batch-completion";
import {
  buildUserMessageStructuredPayload,
  parseAttachmentMetaFromContent,
  resolveUserMessageDisplay,
  stripEmbeddedAttachmentOcr,
} from "./attachment-message-display";

const ocrDump = [
  "### Archivo adjunto: Boleta Registral Las Fuentes.pdf",
  "-- 1 of 1 --",
  "",
  "---",
  "### Archivo adjunto: PREDIAL 2023.pdf",
  "-- 1 of 1 --",
].join("\n");

assert.equal(stripEmbeddedAttachmentOcr(ocrDump), "");
assert.equal(
  stripEmbeddedAttachmentOcr(`notas del asesor\n\n---\n${ocrDump}`),
  "notas del asesor"
);

assert.deepEqual(parseAttachmentMetaFromContent(ocrDump), [
  { fileName: "Boleta Registral Las Fuentes.pdf" },
  { fileName: "PREDIAL 2023.pdf" },
]);

const resolved = resolveUserMessageDisplay({ content: ocrDump });
assert.equal(resolved.userText, "");
assert.equal(resolved.attachments.length, 2);

const withPayload = resolveUserMessageDisplay({
  content: ocrDump,
  structuredPayload: {
    userText: "aquí van",
    attachments: [{ fileName: "a.pdf", truncated: true }],
  },
});
assert.equal(withPayload.userText, "aquí van");
assert.deepEqual(withPayload.attachments, [
  { fileName: "a.pdf", truncated: true },
]);

const persisted = buildUserMessageStructuredPayload({
  message: ocrDump,
  attachments: [
    { fileName: "Boleta Registral Las Fuentes.pdf", sizeBytes: 10 },
    { fileName: "PREDIAL 2023.pdf", sizeBytes: 20 },
  ],
});
assert.equal(persisted.userText, "");
assert.deepEqual(persisted.attachments, [
  { fileName: "Boleta Registral Las Fuentes.pdf", sizeBytes: 10 },
  { fileName: "PREDIAL 2023.pdf", sizeBytes: 20 },
]);

// Paridad Telegram caption+listo: el OCR no debe ocultar el cierre de lote.
const uploadPlusListo = `listo\n\n---\n${ocrDump}`;
assert.equal(stripEmbeddedAttachmentOcr(uploadPlusListo), "listo");
assert.equal(
  looksLikeDocumentBatchComplete(stripEmbeddedAttachmentOcr(uploadPlusListo)),
  true
);
assert.equal(
  looksLikeDocumentBatchComplete(uploadPlusListo),
  false,
  "el detector exacto no debe mirar el dump OCR completo"
);

console.log("attachment-message-display.selftest: ok");
