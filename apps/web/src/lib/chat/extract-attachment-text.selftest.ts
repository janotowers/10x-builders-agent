import assert from "node:assert/strict";
import {
  extractAttachmentText,
  isChatImageAttachment,
} from "./extract-attachment-text";

assert.equal(
  isChatImageAttachment({ fileName: "fachada.jpg", mimeType: "image/jpeg" }),
  true
);
assert.equal(
  isChatImageAttachment({ fileName: "foto.HEIC", mimeType: "" }),
  true
);
assert.equal(
  isChatImageAttachment({
    fileName: "contrato.pdf",
    mimeType: "application/pdf",
  }),
  false
);

void extractAttachmentText({
  fileName: "cocina.png",
  mimeType: "image/png",
  buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
}).then((image) => {
  assert.match(image.text, /Imagen adjunta: cocina\.png/);
  assert.equal(image.truncated, false);
  console.log("extract-attachment-text.selftest: ok");
});
