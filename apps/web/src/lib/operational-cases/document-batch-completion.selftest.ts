import assert from "node:assert/strict";
import { looksLikeDocumentBatchComplete } from "./document-batch-completion";
import { inferCaseDocumentKind } from "./case-document-ingestion";

for (const positive of [
  "listo",
  "Listo",
  "  listo  ",
  "ya está",
  "ya estan",
  "terminé",
  "eso es todo",
  "ya mandé todo",
  "ya te mandé todo",
  "documentos enviados",
]) {
  assert.equal(
    looksLikeDocumentBatchComplete(positive),
    true,
    `expected batch-complete for: ${positive}`
  );
}

for (const negative of [
  "aquí va el primero",
  "listo para enviar mañana",
  "todavía no",
  "te mando la escritura",
  "",
]) {
  assert.equal(
    looksLikeDocumentBatchComplete(negative),
    false,
    `expected NOT batch-complete for: ${negative}`
  );
}

assert.equal(
  inferCaseDocumentKind({ fileName: "INSTITUTO NACIONAL ELECTORAL (3).pdf" }),
  "ine"
);
assert.equal(
  inferCaseDocumentKind({ fileName: "credencial para votar.jpg" }),
  "ine"
);
assert.equal(
  inferCaseDocumentKind({ fileName: "INE CONCHIS.pdf" }),
  "ine"
);
assert.equal(
  inferCaseDocumentKind({ fileName: "boleta registral.pdf" }),
  "boleta_registral"
);

console.log("document-batch-completion.selftest passed");
