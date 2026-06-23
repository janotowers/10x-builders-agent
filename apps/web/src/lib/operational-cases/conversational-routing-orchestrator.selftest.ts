import assert from "node:assert/strict";
import type { OperationalCase } from "@agents/types";
import {
  buildClarificationPrompt,
  parseClarificationSelection,
  resolveRoutableConversationBindingsSync,
} from "./conversational-routing-orchestrator";

// parseClarificationSelection ────────────────────────────────────────────────
assert.deepEqual(parseClarificationSelection("sí"), { kind: "yes" });
assert.deepEqual(parseClarificationSelection("SI"), { kind: "yes" });
assert.deepEqual(parseClarificationSelection("ok"), { kind: "yes" });
assert.deepEqual(parseClarificationSelection("confirmo"), { kind: "yes" });
assert.deepEqual(parseClarificationSelection("no"), { kind: "no" });
assert.deepEqual(parseClarificationSelection("ninguno"), { kind: "no" });
assert.deepEqual(parseClarificationSelection("1"), { kind: "index", index: 1 });
assert.deepEqual(parseClarificationSelection("caso 2"), {
  kind: "index",
  index: 2,
});
assert.deepEqual(parseClarificationSelection("nueva"), { kind: "new_case" });
assert.deepEqual(parseClarificationSelection("nuevo caso"), { kind: "new_case" });
assert.deepEqual(parseClarificationSelection("registrar otra propiedad"), {
  kind: "new_case",
});
assert.deepEqual(parseClarificationSelection("opción 3"), {
  kind: "index",
  index: 3,
});
assert.deepEqual(parseClarificationSelection("el 2"), {
  kind: "index",
  index: 2,
});
// Mensajes que NO son selección → null (el caller sigue el flujo normal).
assert.equal(parseClarificationSelection(""), null);
assert.equal(
  parseClarificationSelection("la casa de la condesa en venta"),
  null
);
assert.equal(parseClarificationSelection("quiero opcionar otra propiedad"), null);

// buildClarificationPrompt ───────────────────────────────────────────────────
const caseA = {
  id: "11111111-1111-1111-1111-1111111111aa",
  case_type: "property_optioning",
  status: "waiting_internal",
  current_step: "intake",
  context_jsonb: { property_title: "Casa Roma" },
} as unknown as OperationalCase;
const caseB = {
  id: "22222222-2222-2222-2222-2222222222bb",
  case_type: "property_optioning",
  status: "active",
  current_step: "awaiting_documents",
  context_jsonb: { property_title: "Depto Condesa" },
} as unknown as OperationalCase;

// Un solo candidato → pregunta sí/no.
const singlePrompt = buildClarificationPrompt({
  candidates: [{ caseId: caseA.id, label: "A" }],
  candidateCasesById: new Map([[caseA.id, caseA]]),
});
assert.ok(singlePrompt.includes("¿Quieres que lo asocie a ese caso?"));
assert.ok(singlePrompt.includes("Casa Roma"));
assert.ok(singlePrompt.includes("Responde: sí / no"));

// Varios candidatos → lista numerada.
const multiPrompt = buildClarificationPrompt({
  candidates: [
    { caseId: caseA.id, label: "A" },
    { caseId: caseB.id, label: "B" },
  ],
  candidateCasesById: new Map([
    [caseA.id, caseA],
    [caseB.id, caseB],
  ]),
});
assert.ok(multiPrompt.includes("varios casos en curso"));
assert.ok(multiPrompt.includes("1. "));
assert.ok(multiPrompt.includes("2. "));
assert.ok(multiPrompt.includes("Casa Roma"));
assert.ok(multiPrompt.includes("Depto Condesa"));
assert.ok(multiPrompt.includes("(1-2)"));
// Copy humano: etiquetas legibles, NUNCA jerga técnica.
assert.ok(multiPrompt.includes("Opción de propiedad"));
assert.ok(multiPrompt.includes("Registro inicial"));
assert.ok(multiPrompt.includes("Solicitar documentos"));
assert.ok(multiPrompt.includes("[Real]"));
assert.ok(
  !multiPrompt.includes("property_optioning"),
  "no debe filtrar el slug del tipo de caso"
);
assert.ok(
  !/waiting_internal|awaiting_documents/.test(multiPrompt),
  "no debe filtrar estado/step técnicos"
);

// Modo E2E se refleja en la etiqueta del candidato.
const caseE2E = {
  id: "33333333-3333-3333-3333-3333333333cc",
  case_type: "property_optioning",
  status: "active",
  current_step: "awaiting_documents",
  context_jsonb: { property_title: "Casa E2E", e2e_controlled: true },
} as unknown as OperationalCase;
const e2ePrompt = buildClarificationPrompt({
  candidates: [
    { caseId: caseE2E.id, label: "E" },
    { caseId: caseB.id, label: "B" },
  ],
  candidateCasesById: new Map([
    [caseE2E.id, caseE2E],
    [caseB.id, caseB],
  ]),
});
assert.ok(e2ePrompt.includes("[E2E]"));
assert.ok(e2ePrompt.includes("[Real]"));

const startIntentPrompt = buildClarificationPrompt({
  candidates: [{ caseId: caseA.id, label: "A" }],
  candidateCasesById: new Map([[caseA.id, caseA]]),
  allowNewCaseOption: true,
  forceListSelection: true,
});
assert.ok(startIntentPrompt.includes("proceso de propiedad en curso"));
assert.ok(startIntentPrompt.includes("nueva"));
assert.ok(startIntentPrompt.includes("registro de otra propiedad"));

// resolveRoutableConversationBindingsSync ─────────────────────────────────────
const completedCase = {
  id: "44444444-4444-4444-4444-4444444444dd",
  case_type: "property_optioning",
  status: "completed",
  current_step: "completed",
  context_jsonb: { created_from: "agent_conversation" },
} as unknown as OperationalCase;
const realCase = {
  id: "55555555-5555-5555-5555-5555555555ee",
  case_type: "property_optioning",
  status: "waiting_internal",
  current_step: "intake",
  context_jsonb: { created_from: "agent_conversation", e2e_controlled: false },
} as unknown as OperationalCase;
const e2eCase = {
  id: "66666666-6666-6666-6666-6666666666ff",
  case_type: "property_optioning",
  status: "waiting_internal",
  current_step: "intake",
  context_jsonb: { created_from: "agent_conversation", e2e_controlled: true },
} as unknown as OperationalCase;
const bindings = [
  { id: "b1", case_id: completedCase.id, status: "awaiting_user" },
  { id: "b2", case_id: realCase.id, status: "awaiting_user" },
  { id: "b3", case_id: e2eCase.id, status: "awaiting_user" },
] as unknown as Array<{
  id: string;
  case_id: string;
  status: string;
}>;

const noE2E = resolveRoutableConversationBindingsSync({
  pendingBindings: bindings as never,
  candidateCasesById: new Map([
    [completedCase.id, completedCase],
    [realCase.id, realCase],
    [e2eCase.id, e2eCase],
  ]),
  e2eLabSessionActive: false,
  caseType: "property_optioning",
});
assert.equal(noE2E.routableBindings.length, 2);
assert.equal(noE2E.ignoredBindings.length, 1);
assert.equal(noE2E.ignoredBindings[0]?.reason, "case_not_routable");

const withE2E = resolveRoutableConversationBindingsSync({
  pendingBindings: bindings as never,
  candidateCasesById: new Map([
    [completedCase.id, completedCase],
    [realCase.id, realCase],
    [e2eCase.id, e2eCase],
  ]),
  e2eLabSessionActive: true,
  caseType: "property_optioning",
});
assert.equal(withE2E.routableBindings.length, 1);
assert.equal(withE2E.routableBindings[0]?.case_id, e2eCase.id);
assert.ok(
  withE2E.ignoredBindings.some(
    (binding) => binding.reason === "e2e_requires_controlled_case"
  )
);

console.log("conversational-routing-orchestrator.selftest: ok");
