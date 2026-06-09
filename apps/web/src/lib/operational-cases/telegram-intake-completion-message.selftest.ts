import assert from "node:assert/strict";
import type { OperationalCase } from "@agents/types";
import {
  buildTelegramIntakeCompletionMessage,
  intakeJustCompleted,
  isIntakeInProgress,
} from "./telegram-intake-completion-message";

function caseStub(partial: Partial<OperationalCase> = {}): OperationalCase {
  return {
    id: "case-1",
    user_id: "user-1",
    case_type: "property_optioning",
    status: "active",
    current_step: "intake",
    context_jsonb: {},
    external_contact_jsonb: {},
    version: 1,
    created_at: "",
    updated_at: "",
    case_type_id: "type-1",
    ...partial,
  } as OperationalCase;
}

assert.equal(
  buildTelegramIntakeCompletionMessage(
    caseStub({
      context_jsonb: { property_title: "Terreno en Sendas" },
    })
  ),
  "«Terreno en Sendas» quedó registrada en el caso con estos datos:\n\n- Título / propiedad: Terreno en Sendas"
);
assert.equal(
  buildTelegramIntakeCompletionMessage(
    caseStub({
      context_jsonb: {
        property_title: "Terreno en Sendas",
        property_zone: "Sendas Residencial",
        operation_type: "Venta",
        property_type: "Terreno",
      },
    })
  ),
  [
    "«Terreno en Sendas» quedó registrada en el caso con estos datos:",
    "",
    "- Título / propiedad: Terreno en Sendas",
    "- Zona / colonia: Sendas Residencial",
    "- Operación: Venta",
    "- Tipo de propiedad: Terreno",
  ].join("\n")
);
assert.equal(
  buildTelegramIntakeCompletionMessage(caseStub({})),
  "La propiedad quedó registrada en el caso."
);
assert.equal(isIntakeInProgress(caseStub({ current_step: "intake" })), true);
assert.equal(
  isIntakeInProgress(
    caseStub({ current_step: "awaiting_documents", context_jsonb: { intake_status: "complete" } })
  ),
  false
);
assert.equal(
  intakeJustCompleted(
    caseStub({ current_step: "intake", context_jsonb: { intake_status: "incomplete" } }),
    caseStub({
      current_step: "awaiting_documents",
      context_jsonb: { intake_status: "complete" },
    })
  ),
  true
);

console.log("telegram-intake-completion-message.selftest.ts: ok");
