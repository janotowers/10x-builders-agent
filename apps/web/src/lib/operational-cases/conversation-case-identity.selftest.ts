import assert from "node:assert/strict";
import type { OperationalCase } from "@agents/types";
import {
  buildConversationCaseIdentity,
  conversationalStepLabel,
  formatOperationalCaseTypeForDisplay,
  humanCaseTypeLabel,
  operationalCaseModeLabel,
} from "./conversation-case-identity";

const opCase = {
  id: "5f4f0de6-d8f6-4bd1-a4ea-d9f57c9ab123",
  case_type: "property_optioning",
  status: "waiting_internal",
  current_step: "intake",
  context_jsonb: {
    title: "Terreno en Sendas",
  },
} as unknown as OperationalCase;

const identity = buildConversationCaseIdentity({ opCase });
// Etiqueta humana del tipo de caso (no el slug técnico).
assert.equal(identity.caseTypeLabel, "Opcionamiento de propiedad");
assert.equal(identity.summary, "Terreno en Sendas");
assert.equal(identity.technical, "waiting_internal / intake");
assert.equal(identity.stepLabel, "Registro inicial");
assert.equal(identity.mode, "[Real]");
assert.match(identity.shortId, /…[a-f0-9]{8}/);

// Override explícito de nombre de tipo de caso.
assert.equal(
  buildConversationCaseIdentity({
    opCase,
    caseTypeDisplayName: "Opción de inmueble",
  }).caseTypeLabel,
  "Opción de inmueble"
);

// Helpers de etiquetas humanas.
assert.equal(
  humanCaseTypeLabel("property_optioning"),
  "Opcionamiento de propiedad"
);
assert.equal(humanCaseTypeLabel("otro_tipo"), "otro_tipo");
assert.equal(humanCaseTypeLabel(null), "Caso operacional");
assert.equal(
  formatOperationalCaseTypeForDisplay("property_optioning"),
  "Opcionamiento de propiedad (property_optioning)"
);
assert.equal(
  formatOperationalCaseTypeForDisplay("otro_tipo"),
  "otro_tipo",
  "unknown case_type keeps the technical slug alone"
);
assert.equal(conversationalStepLabel("awaiting_documents"), "Solicitar documentos");
assert.equal(conversationalStepLabel("documents_received"), "Revisión documental");
assert.equal(
  operationalCaseModeLabel({
    context_jsonb: { e2e_controlled: true },
  } as unknown as OperationalCase),
  "[E2E]"
);
assert.equal(
  operationalCaseModeLabel({ context_jsonb: {} } as unknown as OperationalCase),
  "[Real]"
);

console.log("conversation-case-identity.selftest: ok");
