import assert from "node:assert/strict";
import {
  buildIntakeProgressPrompt,
  buildMissingIntakeFieldsPrompt,
  decideIntakeReopen,
  firstOperationalStepAfterIntake,
} from "./conversational-intake-orchestrator";

// firstOperationalStepAfterIntake ───────────────────────────────────────────
assert.equal(
  firstOperationalStepAfterIntake([
    { step_key: "intake" },
    { step_key: "awaiting_documents" },
    { step_key: "documents_received" },
  ]),
  "awaiting_documents"
);
// Sin "intake" en el flujo: toma el primer paso.
assert.equal(
  firstOperationalStepAfterIntake([{ step_key: "first_step" }]),
  "first_step"
);
// Flujo inválido / vacío: fallback seguro.
assert.equal(firstOperationalStepAfterIntake(null), "awaiting_documents");
assert.equal(firstOperationalStepAfterIntake([]), "awaiting_documents");

// buildMissingIntakeFieldsPrompt ─────────────────────────────────────────────
const missingPrompt = buildMissingIntakeFieldsPrompt([
  { label: "Título / propiedad" },
  { name: "property_zone" },
]);
assert.ok(missingPrompt.includes("1. Título / propiedad"));
assert.ok(!missingPrompt.includes("1. Título / propiedad:"));
assert.ok(missingPrompt.includes("2. property_zone"));
assert.ok(missingPrompt.includes("Compártemelos en un solo mensaje."));
assert.ok(!missingPrompt.includes("continúo con el registro"));
// Sin campos: usa el fallback de 4 campos canónicos con ejemplos.
const fallbackPrompt = buildMissingIntakeFieldsPrompt([]);
assert.ok(fallbackPrompt.includes("1. Título / propiedad"));
assert.ok(fallbackPrompt.includes("3. Operación aplicable (ej., Venta, Renta, Venta y Renta)"));
assert.ok(fallbackPrompt.includes("4. Tipo de propiedad (ej., Casa, Departamento, Terreno, etc.)"));
assert.ok(!fallbackPrompt.includes("1. Título / propiedad:"));

// buildIntakeProgressPrompt ──────────────────────────────────────────────────
const progress = buildIntakeProgressPrompt({
  context: { property_title: "Casa Roma", property_zone: "Condesa" },
  missingFields: [{ label: "Operación aplicable" }],
});
assert.ok(progress.includes("Perfecto, ya registré estos datos:"));
assert.ok(progress.includes("- Título / propiedad: Casa Roma"));
assert.ok(progress.includes("- Zona / colonia: Condesa"));
assert.ok(progress.includes("Operación aplicable (ej., Venta, Renta, Venta y Renta)"));
assert.ok(!progress.includes("Operación aplicable:"));
// Sin datos capturados: cae al prompt de campos faltantes (sin encabezado).
const progressEmpty = buildIntakeProgressPrompt({
  context: {},
  missingFields: [{ label: "Operación aplicable" }],
});
assert.ok(!progressEmpty.includes("Perfecto, ya registré"));
assert.ok(progressEmpty.includes("Operación aplicable (ej.,"));

// decideIntakeReopen ─────────────────────────────────────────────────────────
// Sin documentos ni decisión humana → se puede reabrir.
assert.deepEqual(
  decideIntakeReopen({
    documentsReceived: 0,
    recentEvents: [
      {
        event_type: "state_changed",
        created_at: "2026-01-01T00:00:00Z",
        payload_jsonb: { kind: "case_created" },
      },
    ],
  }),
  { canReopen: true, hasHumanDecisionAfterIntake: false }
);
// Con documentos recibidos → NO se reabre (no pisar actividad operativa).
assert.equal(
  decideIntakeReopen({ documentsReceived: 2, recentEvents: [] }).canReopen,
  false
);
// Decisión humana posterior a la entrada a intake → NO se reabre.
const blockedByHuman = decideIntakeReopen({
  documentsReceived: 0,
  recentEvents: [
    {
      event_type: "state_changed",
      created_at: "2026-01-01T00:00:00Z",
      payload_jsonb: { current_step: "intake" },
    },
    {
      event_type: "human_decision",
      created_at: "2026-01-02T00:00:00Z",
    },
  ],
});
assert.equal(blockedByHuman.canReopen, false);
assert.equal(blockedByHuman.hasHumanDecisionAfterIntake, true);

console.log("conversational-intake-orchestrator.selftest: ok");
