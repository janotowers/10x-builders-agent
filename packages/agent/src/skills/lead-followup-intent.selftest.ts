import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@agents/types";
import { turnHasLeadIdentifier } from "./lead-followup-intent";

function msg(role: AgentMessage["role"], content: string): AgentMessage {
  return {
    id: randomUUID(),
    session_id: "s",
    role,
    content,
    created_at: new Date().toISOString(),
  };
}

function run(): void {
  assert.equal(
    turnHasLeadIdentifier({ message: undefined, priorMessages: [] }),
    false,
    "empty message"
  );

  assert.equal(
    turnHasLeadIdentifier({
      message: "Ayúdame a escribir un WhatsApp para darle seguimiento a un lead",
      priorMessages: [],
    }),
    false,
    "generic ask without identifier"
  );

  assert.equal(
    turnHasLeadIdentifier({
      message: "Su teléfono es 5215512345678",
      priorMessages: [],
    }),
    true,
    "explicit phone is enough"
  );

  assert.equal(
    turnHasLeadIdentifier({
      message: "su correo es julieta@example.com",
      priorMessages: [],
    }),
    true,
    "email is enough"
  );

  assert.equal(
    turnHasLeadIdentifier({
      message: "Su nombre es Julieta Evelia",
      priorMessages: [
        msg(
          "user",
          "Ayúdame a escribir un WhatsApp para darle seguimiento a un lead"
        ),
        msg(
          "assistant",
          "Claro, ¿cuál es el nombre del lead, su teléfono o su correo?"
        ),
      ],
    }),
    true,
    "name reply that answers an explicit question is in scope"
  );

  assert.equal(
    turnHasLeadIdentifier({
      message: "Ayúdame a escribir un WhatsApp para el lead Julieta Evelia",
      priorMessages: [],
    }),
    true,
    "explicit lead name in the current turn is enough"
  );

  assert.equal(
    turnHasLeadIdentifier({
      message: "El lead se llama Julieta Evelia",
      priorMessages: [],
    }),
    true,
    "explicit se llama pattern is enough"
  );

  assert.equal(
    turnHasLeadIdentifier({
      message: "Su nombre es Julieta Evelia",
      priorMessages: [
        msg("user", "Cuántos leads tuvimos en abril?"),
        msg("assistant", "Total de leads en abril: 510"),
      ],
    }),
    true,
    "explicit name in the current turn is in scope even without a recent question"
  );

  assert.equal(
    turnHasLeadIdentifier({
      message: "Ayúdame a escribir un WhatsApp para darle seguimiento a un lead",
      priorMessages: [
        msg("user", "Su nombre es Julieta Evelia"),
        msg("assistant", "Aquí tienes un mensaje para Julieta Evelia: ..."),
      ],
    }),
    false,
    "names from old turns do not count as in-scope identifiers"
  );

  console.log("skills/lead-followup-intent.selftest: ok");
}

run();
