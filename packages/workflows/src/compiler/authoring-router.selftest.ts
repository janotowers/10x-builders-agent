/**
 * Selftest del router de autoría (batería walkthrough + fidelidad).
 * Ejecutar: npx tsx src/compiler/authoring-router.selftest.ts
 */
import assert from "node:assert/strict";
import {
  AUTHORING_BATTERY_FIXTURES,
  classifyAuthoringIntentDeterministic,
  detectUnrequestedSideEffects,
  suggestEnglishSlug,
} from "./authoring-router";

let passed = 0;
for (const fixture of AUTHORING_BATTERY_FIXTURES) {
  const result = classifyAuthoringIntentDeterministic(fixture.description);
  assert.ok(result, `${fixture.id}: expected deterministic classification`);
  assert.equal(
    result.kind,
    fixture.expectedKind,
    `${fixture.id}: kind expected ${fixture.expectedKind}, got ${result.kind}`
  );
  if (fixture.expectedSkillSubtype) {
    assert.equal(
      result.skill_subtype,
      fixture.expectedSkillSubtype,
      `${fixture.id}: skill subtype`
    );
  }
  passed += 1;
}

const fidelity = detectUnrequestedSideEffects({
  description:
    "Cada vez que prepares un seguimiento para un propietario, resume el último acuerdo.",
  compiledSignals: {
    sendsMessage: true,
    requiresApproval: true,
    createsCaseWorkflow: false,
  },
});
assert.ok(
  fidelity.some((f) => /envío/i.test(f)),
  "fidelity must catch unrequested send"
);

assert.equal(
  suggestEnglishSlug("Mensaje de seguimiento a propietario"),
  "owner_followup_message"
);
assert.equal(
  suggestEnglishSlug("Seguimiento cordial a propietarios"),
  "owner_followup_message"
);
assert.equal(
  suggestEnglishSlug("Coordinación de visita a propiedad"),
  "property_visit_coordination"
);
assert.equal(
  suggestEnglishSlug("Auditoría del inventario activo"),
  "inventory_batch_analysis"
);
assert.equal(
  suggestEnglishSlug("Preparación agenda reunión prospecto"),
  "prep_agenda_meeting_prospect"
);

console.log(
  `authoring-router.selftest: OK (${passed} battery fixtures + fidelity)`
);
