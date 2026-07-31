import {
  internalCaseMediaRegisteredKind,
  looksLikeRawPhotoUpload,
} from "./append-raw-photo";

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

assert(
  looksLikeRawPhotoUpload({ contentType: "image/jpeg", fileName: "a.bin" }),
  "image mime"
);
assert(
  looksLikeRawPhotoUpload({ contentType: "application/octet-stream", fileName: "fachada.jpg" }),
  "jpg ext"
);
assert(
  looksLikeRawPhotoUpload({ contentType: "application/octet-stream", fileName: "sala.HEIC" }),
  "heic ext"
);
assert(
  !looksLikeRawPhotoUpload({
    contentType: "application/pdf",
    fileName: "predial.pdf",
  }),
  "pdf not photo"
);
assert(
  !looksLikeRawPhotoUpload({
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    fileName: "contrato.docx",
  }),
  "docx not photo"
);

assert(
  internalCaseMediaRegisteredKind("photos_requested") === "photo_registered",
  "photos step"
);
assert(
  internalCaseMediaRegisteredKind("awaiting_documents") === "document_registered",
  "docs step"
);
assert(
  internalCaseMediaRegisteredKind("documents_received") === "document_registered",
  "docs received"
);
assert(
  internalCaseMediaRegisteredKind("contract_pending") === "document_registered",
  "other step"
);

console.log("append-raw-photo.selftest.ts: ok");
