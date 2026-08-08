import assert from "node:assert/strict";
import { buildToolConfirmationMessage } from "./confirmation-messages";

assert.equal(
  buildToolConfirmationMessage("easybroker_publish_listing", {}),
  "Confirma publicar la propiedad en EasyBroker."
);
assert.equal(
  buildToolConfirmationMessage("ungga_publish_listing", {
    action: "prepare_draft",
  }),
  "Confirma preparar el borrador de publicación en Ungga."
);
assert.match(
  buildToolConfirmationMessage("telegram_send_message_to_contact", {
    message: "Hola, ¿me puedes enviar la boleta?",
  }),
  /contacto externo/
);
assert.match(
  buildToolConfirmationMessage("gmail_send_email", {
    to: "owner@example.com",
    subject: "Seguimiento",
    body: "Hola, te comparto el seguimiento.",
    evidence_summary: "Documento Word aprobado por el asesor",
    attachment_document_ids: ["doc-1"],
  }),
  /Destinatario: owner@example\.com[\s\S]*Adjuntos del caso: 1[\s\S]*Evidencia revisada/
);
assert.match(
  buildToolConfirmationMessage("operational_case_update_state", {
    current_step: "awaiting_documents",
  }),
  /actualizar el caso en curso/
);
assert.match(
  buildToolConfirmationMessage("mystery_tool", { foo: "bar" }),
  /Confirma esta acción \(mystery_tool\)/
);
assert.doesNotMatch(
  buildToolConfirmationMessage("mystery_tool", {}),
  /Confirma ejecutar la herramienta/
);

console.log("confirmation-messages.selftest: ok");
