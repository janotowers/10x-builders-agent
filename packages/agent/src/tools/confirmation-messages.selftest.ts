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
