import assert from "node:assert/strict";
import {
  REQUIRED_PROPERTY_DOCUMENTS,
  buildDocumentChecklistLines,
  buildDocumentReceivedAck,
  buildMediaGroupReceivedAck,
  buildPhotoMediaGroupReceivedAck,
  documentKindHint,
  looksLikeDocumentUploadSideText,
} from "./case-document-collection";

// Lista canónica: exactamente un documento bloqueante (boleta).
const blocking = REQUIRED_PROPERTY_DOCUMENTS.filter((doc) => doc.blocking);
assert.equal(blocking.length, 1, "debe haber un único documento bloqueante");
assert.equal(blocking[0]!.key, "boleta_registral");
assert.equal(REQUIRED_PROPERTY_DOCUMENTS[0]!.key, "boleta_registral");

// Checklist incluye el bloqueante con su nota y cubre todos los documentos.
const lines = buildDocumentChecklistLines();
assert.equal(lines.length, REQUIRED_PROPERTY_DOCUMENTS.length);
assert.ok(
  lines.some((line) => line.includes("indispensable")),
  "el checklist debe marcar el documento indispensable"
);
assert.ok(lines.every((line) => line.startsWith("• ")));
assert.ok(lines.some((line) => /predial/i.test(line)));
assert.ok(lines.some((line) => /boleta/i.test(line)));

// markBlocking=false omite la nota.
const plainLines = buildDocumentChecklistLines({ markBlocking: false });
assert.ok(!plainLines.some((line) => line.includes("indispensable")));

// Ack rico: nombre del archivo + pista por tipo + recordatorio de "listo".
const boletaAck = buildDocumentReceivedAck({
  originalName: "Boleta Registral Las Fuentes.pdf",
  kind: "boleta_registral",
});
assert.ok(boletaAck.includes("«Boleta Registral Las Fuentes.pdf»"));
assert.ok(boletaAck.includes("referencia principal para validar titularidad"));
assert.ok(boletaAck.includes('"listo"'));

const predialAck = buildDocumentReceivedAck({
  originalName: "PREDIAL 2023.pdf",
  kind: "predial",
});
assert.ok(predialAck.includes("superficies de terreno y construcción"));

// Sin nombre → fallback genérico; tipo sin pista → sin pista pegada.
const ineAck = buildDocumentReceivedAck({ originalName: null, kind: "ine" });
assert.ok(ineAck.includes("Recibí el archivo, gracias."));
assert.equal(documentKindHint("ine"), null);
assert.equal(documentKindHint(undefined), null);

// Detección de texto lateral de subida.
for (const positive of [
  "Documentos adjuntos",
  "documentos",
  "archivos adjuntos",
  "ahí van los documentos",
  "te mando los documentos",
  "aquí están los archivos",
  "te comparto la escritura",
  // Regresión: el bug previo usaba `\\badjunt\\b` y no matcheaba "adjunto"
  // (la vocal final rompe la frontera). El caption real del álbum era este:
  "Adjunto documentos",
  "Adjunto los documentos",
  "adjunté la escritura",
  "anexo comprobante",
]) {
  assert.equal(
    looksLikeDocumentUploadSideText(positive),
    true,
    `esperaba side-text para: ${positive}`
  );
}
for (const negative of [
  "",
  "listo",
  "interno",
  "quiero opcionar otra propiedad",
  "¿cuántos leads tuvimos en marzo y cuántos cerraron contrato al final?",
  "Casa en venta en Las Fuentes",
]) {
  assert.equal(
    looksLikeDocumentUploadSideText(negative),
    false,
    `no esperaba side-text para: ${negative}`
  );
}

// Acuse consolidado de álbum: cuenta + nombres + recordatorio de "listo".
const groupAck = buildMediaGroupReceivedAck([
  { originalName: "Boleta Registral.pdf" },
  { originalName: "Escritura.pdf" },
  { originalName: "INE.pdf" },
]);
assert.ok(groupAck.includes("Recibí 3 documentos"));
assert.ok(groupAck.includes("«Boleta Registral.pdf»"));
assert.ok(groupAck.includes("«Escritura.pdf»"));
assert.ok(groupAck.includes('«listo»'));

// Un solo documento → singular.
const singleGroupAck = buildMediaGroupReceivedAck([
  { originalName: "Escritura.pdf" },
]);
assert.ok(singleGroupAck.includes("Recibí 1 documento y lo registré en el caso."));

// Con `kind`, el acuse en bloque incluye la pista por documento (detalle que
// antes sólo aparecía en el acuse por archivo).
const detailedGroupAck = buildMediaGroupReceivedAck([
  { originalName: "Boleta.pdf", kind: "boleta_registral" },
  { originalName: "Predial.pdf", kind: "predial" },
  { originalName: "INE.pdf", kind: "ine" },
]);
assert.ok(
  detailedGroupAck.includes(
    "«Boleta.pdf» — La usaré como referencia principal para validar titularidad."
  )
);
assert.ok(
  detailedGroupAck.includes("«Predial.pdf» — La usaré para validar superficies")
);
// `ine` no tiene pista → línea sin guion de detalle.
assert.ok(detailedGroupAck.includes("• «INE.pdf»"));
assert.ok(!detailedGroupAck.includes("«INE.pdf» —"));

// Archivos sin nombre → sin línea de nombres, pero conserva la cuenta.
const namelessGroupAck = buildMediaGroupReceivedAck([
  { originalName: null },
  { originalName: "  " },
]);
assert.ok(namelessGroupAck.includes("Recibí 2 documentos"));
assert.ok(!namelessGroupAck.includes("• «"));

const photoGroupAck = buildPhotoMediaGroupReceivedAck([
  { originalName: "fachada.jpeg" },
  { originalName: "cocina.jpeg" },
]);
assert.match(photoGroupAck, /Recibí 2 fotos/);
assert.match(photoGroupAck, /«fachada\.jpeg»/);
assert.match(photoGroupAck, /todas las fotos/);
assert.doesNotMatch(photoGroupAck, /documentos/);
assert.doesNotMatch(photoGroupAck, /procesarlos/);

console.log("case-document-collection.selftest: ok");
