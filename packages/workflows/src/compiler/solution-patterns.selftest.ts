import assert from "node:assert/strict";
import {
  REGISTERED_AUTHORING_COMPONENTS,
  SOLUTION_PATTERNS,
  SOLUTION_PATTERN_TRIGGERS,
  WORK_FORM_BASE_BUNDLES,
  authoringHintsForComposition,
  inferSolutionPatternTriggers,
  resolveSolutionPatternComposition,
  solutionPatternSchema,
} from "./solution-patterns";

const ids = new Set(SOLUTION_PATTERNS.map((pattern) => pattern.id));
assert.equal(ids.size, SOLUTION_PATTERNS.length, "pattern ids must be unique");

const components = new Set(REGISTERED_AUTHORING_COMPONENTS);
for (const pattern of SOLUTION_PATTERNS) {
  assert.ok(solutionPatternSchema.safeParse(pattern).success);
  assert.ok(pattern.compileDirectives.length > 0);
  assert.ok(pattern.validationRuleIds.length > 0);
  assert.ok(pattern.testContract.scenarios.length > 0);
  assert.ok(pattern.evidenceDocs.length > 0);
  for (const dependency of pattern.dependencies) {
    assert.ok(ids.has(dependency), `${pattern.id}: missing ${dependency}`);
  }
  for (const component of pattern.uiComponents) {
    assert.ok(components.has(component));
  }
}

for (const bundle of Object.values(WORK_FORM_BASE_BUNDLES)) {
  assert.ok(bundle.basePatternIds.length > 0);
  for (const id of bundle.basePatternIds) {
    assert.ok(ids.has(id), `${bundle.id}: unknown base pattern ${id}`);
  }
}

const triggers = inferSolutionPatternTriggers({
  requestedSideEffects: [
    "send_message",
    "human_approval",
    "schedule_recurrence",
  ],
  capabilityCategoryIds: ["user_email", "document_storage"],
  understandingEffects: ["Enviar el email y esperar la respuesta."],
  understandingSources: ["Documento Word entregado por el asesor."],
});
for (const expected of [
  "scheduled_execution",
  "sends_external_email",
  "external_response_wait",
  "document_intake",
] as const) {
  assert.ok(triggers.includes(expected), `missing inferred trigger ${expected}`);
}
assert.ok(
  triggers.every((trigger) =>
    (SOLUTION_PATTERN_TRIGGERS as readonly string[]).includes(trigger)
  )
);

const composition = resolveSolutionPatternComposition({
  workForm: "case_workflow",
  triggers,
});
assert.deepEqual(composition.issues, []);
for (const expected of [
  "PATTERN_BASE_CASE_WORKFLOW",
  "PATTERN_SCHEDULED_TASK_SAFETY",
  "PATTERN_EMAIL_SEND_WITH_APPROVAL",
  "PATTERN_DOCUMENT_INTAKE_REVIEW",
  "PATTERN_EXTERNAL_RESPONSE_CORRELATION",
  "PATTERN_HITL_ACTION_CONTRACT",
  "PATTERN_OPERATIONAL_WRITE_GATE",
] as const) {
  assert.ok(
    composition.patternIds.includes(expected),
    `missing composed pattern ${expected}`
  );
}
assert.ok(
  authoringHintsForComposition(composition).some(
    (hint) => hint.targetDimension === "recurrence"
  )
);

const schedule = resolveSolutionPatternComposition({
  workForm: "schedule",
  triggers: ["scheduled_execution"],
});
assert.deepEqual(schedule.issues, []);
assert.equal(schedule.baseBundleId, "scheduled_durable_task_base");
assert.ok(schedule.patternIds.includes("PATTERN_BASE_DURABLE_TASK"));
assert.ok(schedule.patternIds.includes("PATTERN_SCHEDULED_TASK_SAFETY"));

const invalid = resolveSolutionPatternComposition({
  workForm: "reusable_skill",
  selectedPatternIds: ["PATTERN_UNKNOWN"],
});
assert.ok(invalid.issues.includes("unknown_pattern:PATTERN_UNKNOWN"));

console.log("solution-patterns.selftest: ok");
