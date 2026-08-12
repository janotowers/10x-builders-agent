import assert from "node:assert/strict";
import {
  REGISTERED_AUTHORING_COMPONENTS,
  SOLUTION_PATTERNS,
  SOLUTION_PATTERN_WORK_FORMS,
  SOLUTION_PATTERN_TRIGGERS,
  WORK_FORM_BASE_BUNDLES,
  authoringHintSchema,
  authoringHintsForComposition,
  evaluateSolutionPatternReadiness,
  inferSolutionPatternTriggers,
  readinessGateIdsForComposition,
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

const legacyHintInput = {
  targetDimension: "actors" as const,
  gap: "Falta identificar al responsable.",
  question: "¿Quién es responsable?",
};
const legacyHint = authoringHintSchema.parse(legacyHintInput);
assert.equal(legacyHint.severity, "important");
assert.deepEqual(legacyHint.dependsOn, []);
assert.equal(legacyHint.appliesWhen, undefined);
assert.match(legacyHint.gapKey, /^legacy\.actors\.[a-z0-9]+$/);
assert.equal(
  authoringHintSchema.parse(legacyHintInput).gapKey,
  legacyHint.gapKey,
  "legacy hint keys must be stable"
);

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
  capabilityProviderIds: ["gmail"],
  inputRequirementKinds: ["runtime_input"],
  inputSourceHints: ["chat_attachment"],
});
for (const expected of [
  "scheduled_execution",
  "sends_external_email",
  "document_intake",
] as const) {
  assert.ok(triggers.includes(expected), `missing inferred trigger ${expected}`);
}
assert.ok(
  triggers.every((trigger) =>
    (SOLUTION_PATTERN_TRIGGERS as readonly string[]).includes(trigger)
  )
);
assert.equal(
  inferSolutionPatternTriggers({
    inputRequirementKinds: ["runtime_input"],
    inputSourceHints: [],
  }).includes("document_intake"),
  false,
  "a generic runtime input or document format outside the structural contract must not imply intake"
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
  "PATTERN_EXTERNAL_MESSAGE_DELIVERY",
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

for (const workForm of SOLUTION_PATTERN_WORK_FORMS) {
  const outbound = resolveSolutionPatternComposition({
    workForm,
    triggers: ["sends_external_message"],
  });
  assert.deepEqual(outbound.issues, [], `${workForm}: outbound composition issues`);
  assert.ok(
    outbound.patternIds.includes("PATTERN_EXTERNAL_MESSAGE_DELIVERY"),
    `${workForm}: missing generic outbound delivery`
  );
  assert.ok(outbound.patternIds.includes("PATTERN_OPERATIONAL_WRITE_GATE"));
  assert.ok(outbound.patternIds.includes("PATTERN_HITL_ACTION_CONTRACT"));
}

const emailSpecialization = resolveSolutionPatternComposition({
  workForm: "reusable_skill",
  triggers: ["sends_external_email"],
});
assert.ok(
  emailSpecialization.patternIds.includes("PATTERN_EXTERNAL_MESSAGE_DELIVERY")
);
assert.ok(
  emailSpecialization.patternIds.includes("PATTERN_EMAIL_SEND_WITH_APPROVAL")
);

const telegramSpecialization = resolveSolutionPatternComposition({
  workForm: "durable_task",
  triggers: ["sends_telegram_message"],
});
assert.ok(
  telegramSpecialization.patternIds.includes(
    "PATTERN_EXTERNAL_MESSAGE_DELIVERY"
  )
);
for (const specializedPattern of [
  "PATTERN_CHANNEL_COPY_RENDERING",
  "PATTERN_CHANNEL_LENGTH_AND_ATTACHMENT_SAFETY",
  "PATTERN_TELEGRAM_DEDUP_SAME_TURN",
] as const) {
  assert.ok(telegramSpecialization.patternIds.includes(specializedPattern));
}

const genericOutbound = resolveSolutionPatternComposition({
  workForm: "case_workflow",
  triggers: ["sends_external_message"],
});
const genericOutboundHints = authoringHintsForComposition(genericOutbound).filter(
  (hint) => hint.gapKey.startsWith("external_message.")
);
assert.deepEqual(
  genericOutboundHints.map((hint) => hint.gapKey).sort(),
  [
    "external_message.approval_evidence",
    "external_message.channel_provider",
    "external_message.delivery_mode",
    "external_message.recipient_resolution",
  ]
);
assert.equal(
  genericOutboundHints.find(
    (hint) => hint.gapKey === "external_message.channel_provider"
  )?.severity,
  "defaultable"
);
assert.ok(
  genericOutboundHints
    .filter((hint) => hint.gapKey !== "external_message.channel_provider")
    .every((hint) => hint.severity === "blocking")
);
assert.ok(
  genericOutboundHints.find(
    (hint) => hint.gapKey === "external_message.channel_provider"
  )?.safeDefault
);
assert.deepEqual(
  genericOutboundHints.find(
    (hint) => hint.gapKey === "external_message.recipient_resolution"
  )?.dependsOn,
  []
);
const genericHintKeys = new Set(genericOutboundHints.map((hint) => hint.gapKey));
for (const hint of genericOutboundHints) {
  for (const dependency of hint.dependsOn) {
    assert.ok(
      genericHintKeys.has(dependency),
      `${hint.gapKey}: missing hint dependency ${dependency}`
    );
  }
}

assert.deepEqual(readinessGateIdsForComposition(genericOutbound), [
  "outbound_delivery_route",
  "outbound_recipient_resolution",
  "outbound_approval_authority",
]);
const notReady = evaluateSolutionPatternReadiness({
  composition: genericOutbound,
  state: {
    requestedSideEffects: ["send_message"],
    capabilityNeeds: [
      {
        capabilityId: "messaging.send",
        requiredFor: ["send_message"],
        routing: { status: "unresolved" },
      },
    ],
    understanding: {
      recipientResolution: { status: "unresolved" },
    },
  },
});
assert.equal(notReady.ready, false);
assert.deepEqual(
  notReady.violations.map((violation) => violation.code),
  [
    "outbound_route_unresolved",
    "outbound_recipient_unresolved",
    "outbound_approval_authority_unresolved",
  ]
);

const ready = evaluateSolutionPatternReadiness({
  composition: genericOutbound,
  state: {
    requestedSideEffects: ["send_message"],
    capabilityNeeds: [
      {
        capabilityId: "messaging.send",
        requiredFor: ["send_message"],
        routing: {
          status: "ready",
          routeId: "telegram:primary",
        },
      },
    ],
    understanding: {
      dimensions: [
        {
          key: "actors",
          status: "covered",
          evidence: ["El chat_id del contacto está vinculado al caso."],
        },
        {
          key: "human_decisions",
          status: "covered",
          evidence: ["La dueña del caso aprueba el preview vigente."],
        },
      ],
      recipientResolution: { status: "runtime_resolvable" },
      approvalAuthority: { authorityId: "case_owner" },
    },
  },
});
assert.equal(ready.ready, true);
assert.deepEqual(ready.violations, []);
assert.deepEqual(ready.passedGateIds, ready.gateIds);

const manualFallbackReady = evaluateSolutionPatternReadiness({
  composition: genericOutbound,
  state: {
    requestedSideEffects: ["send_message"],
    capabilityNeeds: [
      {
        capabilityId: "messaging.send",
        requiredFor: ["send_message"],
        routing: {
          status: "manual_fallback",
          evidence: ["Crear work item auditado para entrega manual."],
        },
      },
    ],
    understanding: {
      recipientResolution: {
        status: "resolved",
        evidence: ["Contacto confirmado por el propietario del caso."],
      },
      approvalAuthority: {
        authorityId: "case_owner",
        evidence: ["Autoridad declarada en el contrato HITL."],
      },
    },
  },
});
assert.equal(manualFallbackReady.ready, true);

const documentIntake = resolveSolutionPatternComposition({
  workForm: "durable_task",
  triggers: ["document_intake"],
});
const documentHints = authoringHintsForComposition(documentIntake).filter(
  (hint) => hint.targetDimension === "data_sources"
);
assert.ok(
  documentHints.some(
    (hint) => hint.gapKey === "data_sources.document_intake_route"
  )
);
assert.ok(
  documentHints.some(
    (hint) => hint.gapKey === "data_sources.document_intake_policy"
  )
);
assert.equal(
  new Set(documentHints.map((hint) => hint.gapKey)).size,
  documentHints.length,
  "route and document policy are distinct same-dimension claims"
);

const schedule = resolveSolutionPatternComposition({
  workForm: "schedule",
  triggers: ["scheduled_execution"],
});
assert.deepEqual(schedule.issues, []);
assert.equal(schedule.baseBundleId, "scheduled_durable_task_base");
assert.deepEqual(schedule.patternIds, [
  "PATTERN_BASE_DURABLE_TASK",
  "PATTERN_DETERMINISTIC_AUTO_REMEDIATION_WITH_CIRCUIT_BREAKER",
  "PATTERN_OPERATIONAL_WRITE_GATE",
  "PATTERN_SCHEDULED_TASK_SAFETY",
]);

const invalid = resolveSolutionPatternComposition({
  workForm: "reusable_skill",
  selectedPatternIds: ["PATTERN_UNKNOWN"],
});
assert.ok(invalid.issues.includes("unknown_pattern:PATTERN_UNKNOWN"));

console.log("solution-patterns.selftest: ok");
