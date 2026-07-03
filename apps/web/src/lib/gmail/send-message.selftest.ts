import assert from "node:assert/strict";
import { __gmailMimeInternals } from "./send-message";

const plainMime = __gmailMimeInternals.buildPlainTextEmail({
  to: "owner@example.com",
  subject: "Contrato de comisión para revisión · Caso …180e4cfc",
  body: "Línea con acento: revisión",
});
assert.match(plainMime, /Subject: =\?UTF-8\?B\?.+\?=/);
assert.match(plainMime, /Content-Transfer-Encoding: base64/);

const multipartMime = __gmailMimeInternals.buildMultipartEmail({
  to: "owner@example.com",
  subject: "Contrato de comisión para revisión · Propiedad: Castañeda",
  body: "Texto con acentos y eñe",
  attachments: [
    {
      filename: "Contrato revisión dueño.pdf",
      contentType: "application/pdf",
      content: Buffer.from("fake-content", "utf8"),
    },
  ],
});
assert.match(multipartMime, /Subject: =\?UTF-8\?B\?.+\?=/);
assert.match(multipartMime, /Content-Transfer-Encoding: base64/);
assert.match(multipartMime, /filename\*=UTF-8''Contrato%20revisi%C3%B3n%20due%C3%B1o\.pdf/);

console.log("send-message.selftest: ok");
