import assert from "node:assert/strict";
import type { OperationalCase } from "@agents/types";
import {
  buildClarificationPrompt,
  parseClarificationSelection,
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

console.log("conversational-routing-orchestrator.selftest: ok");
