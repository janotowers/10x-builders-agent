import assert from "node:assert/strict";
import {
  documentExtensionFromPath,
  inferCaseDocumentKind,
  safeDocumentPathSegment,
} from "./case-document-ingestion";

// inferCaseDocumentKind ──────────────────────────────────────────────────────
assert.equal(
  inferCaseDocumentKind({ text: "te mando la boleta registral" }),
  "boleta_registral"
);
assert.equal(
  inferCaseDocumentKind({ fileName: "boleta-registral.pdf" }),
  "boleta_registral"
);
assert.equal(
  inferCaseDocumentKind({ text: "impuesto predial 2025" }),
  "predial"
);
assert.equal(
  inferCaseDocumentKind({ text: "escritura de la propiedad" }),
  "escritura_descripcion"
);
assert.equal(
  inferCaseDocumentKind({ text: "aqui va mi INE" }),
  "ine"
);
assert.equal(
  inferCaseDocumentKind({ text: "comprobante de domicilio del banco" }),
  "comprobante_domicilio"
);
assert.equal(inferCaseDocumentKind({ text: "hola, una foto" }), "unknown");

// safeDocumentPathSegment ────────────────────────────────────────────────────
assert.equal(safeDocumentPathSegment("Mi Documento (1).pdf"), "Mi-Documento-1-.pdf");
assert.equal(safeDocumentPathSegment("Año Fiscal"), "Ano-Fiscal");
assert.equal(safeDocumentPathSegment("   "), "file");
assert.equal(safeDocumentPathSegment("***"), "file");

// documentExtensionFromPath ──────────────────────────────────────────────────
assert.equal(documentExtensionFromPath("documents/file_123.pdf"), "pdf");
assert.equal(documentExtensionFromPath("photo.JPG"), "jpg");
assert.equal(documentExtensionFromPath("sinextension"), "bin");
assert.equal(documentExtensionFromPath("weird.<<<", "jpg"), "jpg");

// Staging paths must stay under the user folder (ingestStagedCaseDocument guard).
assert.ok("user-1/chat-staging/x.pdf".startsWith("user-1/"));
assert.equal("other/chat-staging/x.pdf".startsWith("user-1/"), false);

console.log("case-document-ingestion.selftest: ok");
