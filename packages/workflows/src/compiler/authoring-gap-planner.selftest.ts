import assert from "node:assert/strict";
import {
  applyAuthoringGapDefaults,
  authoringPriorGapDispositionSchema,
  buildAuthoringGapPlan,
  createAuthoringGapId,
  deriveFlatAuthoringGaps,
  migrateLegacyAuthoringGapPlan,
  parseAuthoringGapPlan,
  planAuthoringGaps,
  reconcileAuthoringGapPlan,
  selectAuthoringGapQuestions,
  type AuthoringGapCandidate,
} from "./authoring-gap-planner";

const candidate = (
  key: string,
  overrides: Partial<AuthoringGapCandidate> = {}
): AuthoringGapCandidate => ({
  key,
  summary: `Gap ${key}`,
  target_dimension: "objective",
  question: `¿Pregunta ${key}?`,
  severity: "blocking",
  priority: 50,
  depends_on: [],
  ...overrides,
});

assert.equal(
  createAuthoringGapId({
    key: "  Fuente Principal ",
    summary: "ignorado",
    target_dimension: "data_sources",
  }),
  createAuthoringGapId({
    key: "fuente principal",
    summary: "otro texto",
    target_dimension: "objective",
  })
);

const canonicalClaimPlan = planAuthoringGaps([
  candidate("history-source", {
    claim_identity: "data_sources.history_origin",
    target_dimension: "data_sources",
    summary: "Falta saber dónde vive el historial.",
  }),
]);
const reformulatedClaim = reconcileAuthoringGapPlan({
  previous: canonicalClaimPlan,
  candidates: [
    candidate("where-history-lives", {
      claim_identity: "data_sources.history_origin",
      target_dimension: "data_sources",
      summary: "No se conoce la ubicación del historial.",
    }),
    candidate("document-route", {
      claim_identity: "data_sources.document_intake_route",
      target_dimension: "data_sources",
      summary: "Falta definir cómo llega el documento.",
    }),
  ],
});
assert.equal(
  reformulatedClaim.gaps.filter(
    (gap) => gap.claim_identity === "data_sources.history_origin"
  ).length,
  1,
  "canonical claim identity must collapse reformulated duplicates"
);
assert.equal(
  reformulatedClaim.gaps.length,
  2,
  "distinct claims in one dimension must remain independent"
);
assert.equal(
  reformulatedClaim.gaps.find(
    (gap) => gap.claim_identity === "data_sources.history_origin"
  )?.id,
  canonicalClaimPlan.gaps[0]?.id
);

const sixCandidates = Array.from({ length: 6 }, (_, index) =>
  candidate(`gap-${index + 1}`, { priority: 100 - index })
);
const sixPlan = planAuthoringGaps(sixCandidates);
assert.equal(sixPlan.counts.total, 6);
assert.equal(sixPlan.counts.blockers, 6);
assert.equal(sixPlan.can_proceed, false);

// Batching: at most 4 independent askable gaps per turn; remainder stays askable.
const firstBatch = selectAuthoringGapQuestions(sixPlan);
assert.equal(firstBatch.questions.length, 4);
assert.equal(firstBatch.plan.counts.askable, 2);
const secondBatch = selectAuthoringGapQuestions(firstBatch.plan);
assert.equal(secondBatch.questions.length, 2);
assert.equal(secondBatch.plan.counts.askable, 0);
assert.deepEqual(
  new Set([...firstBatch.questions, ...secondBatch.questions]).size,
  6
);

const askedPlan = selectAuthoringGapQuestions(
    planAuthoringGaps([
      candidate("ignored", {
        examples: ["El asesor responde con el documento correcto"],
      }),
    ])
  ).plan;
const preservedAskedGap = reconcileAuthoringGapPlan({
  previous: askedPlan,
  candidates: [],
});
assert.equal(
  preservedAskedGap.gaps[0]?.state,
  "asked",
  "an omitted candidate must not blindly reopen a previously asked gap"
);
assert.deepEqual(preservedAskedGap.gaps[0]?.examples, [
  "El asesor responde con el documento correcto",
]);
const ignoredAskedGap = reconcileAuthoringGapPlan({
  previous: preservedAskedGap,
  candidates: [],
  priorGapDispositions: [
    {
      gap_id: preservedAskedGap.gaps[0]!.id,
      status: "unanswered",
      evidence: ["No sé"],
    },
  ],
});
assert.equal(ignoredAskedGap.gaps[0]?.state, "open");
assert.equal(ignoredAskedGap.gaps[0]?.resolution_status, "unanswered");
assert.equal(
  selectAuthoringGapQuestions(ignoredAskedGap).questions[0],
  "¿Pregunta ignored?"
);
const secondIgnoredAsk = selectAuthoringGapQuestions(ignoredAskedGap);
assert.equal(secondIgnoredAsk.plan.gaps[0]?.ask_count, 2);
const exhaustedIgnoredGap = reconcileAuthoringGapPlan({
  previous: secondIgnoredAsk.plan,
  priorGapDispositions: [
    {
      gap_id: secondIgnoredAsk.plan.gaps[0]!.id,
      status: "unanswered",
      evidence: [],
    },
  ],
});
assert.equal(
  selectAuthoringGapQuestions(exhaustedIgnoredGap).questions.length,
  0,
  "the same unanswered gap must not be asked a third time"
);

const answered = reconcileAuthoringGapPlan({
  previous: firstBatch.plan,
  candidates: sixCandidates,
  answeredGapIds: firstBatch.gaps.map((gap) => gap.id),
});
assert.equal(answered.counts.unresolved, 2);
assert.equal(deriveFlatAuthoringGaps(answered).length, 2);
assert.ok(
  answered.gaps
    .filter((gap) => firstBatch.gaps.some((asked) => asked.id === gap.id))
    .every((gap) => gap.state === "answered")
);
assert.ok(
  answered.gaps
    .filter((gap) => firstBatch.gaps.some((asked) => asked.id === gap.id))
    .every((gap) => gap.resolution_status === "resolved")
);

const semanticGap = planAuthoringGaps([candidate("semantic")]).gaps[0]!;
const partial = reconcileAuthoringGapPlan({
  previous: buildAuthoringGapPlan([
    { ...semanticGap, state: "asked", ask_count: 2 },
  ]),
  candidates: [candidate("semantic", { summary: "Updated wording" })],
  priorGapDispositions: [
    {
      gap_id: semanticGap.id,
      status: "partial",
      evidence: ["Usaremos BigQuery"],
      residual: "Falta definir el dataset exacto",
    },
  ],
});
assert.equal(partial.gaps[0]?.id, semanticGap.id, "partial must retain ID");
assert.equal(partial.gaps[0]?.resolution_status, "partial");
assert.equal(partial.gaps[0]?.state, "open");
assert.deepEqual(partial.gaps[0]?.evidence, ["Usaremos BigQuery"]);
assert.equal(partial.gaps[0]?.residual, "Falta definir el dataset exacto");
assert.equal(
  partial.gaps[0]?.ask_count,
  0,
  "a genuinely narrower residual gets its own ask budget"
);

const incomingCandidate = candidate("incoming-outbound", {
  target_dimension: "human_decisions",
  question: "¿Quién aprueba y qué debe revisar?",
});
const incomingGapId = createAuthoringGapId(incomingCandidate);
const incomingPartial = reconcileAuthoringGapPlan({
  candidates: [incomingCandidate],
  priorGapDispositions: [
    {
      gap_id: incomingGapId,
      status: "partial",
      evidence: ["El asesor aprueba el mensaje"],
      residual: "¿Qué destinatario y fuentes debe revisar?",
    },
  ],
});
assert.equal(incomingPartial.gaps[0]?.id, incomingGapId);
assert.equal(incomingPartial.gaps[0]?.resolution_status, "partial");
assert.equal(incomingPartial.gaps[0]?.state, "open");
assert.equal(
  incomingPartial.gaps[0]?.question,
  "¿Qué destinatario y fuentes debe revisar?"
);
const incomingResolved = reconcileAuthoringGapPlan({
  candidates: [incomingCandidate],
  priorGapDispositions: [
    {
      gap_id: incomingGapId,
      status: "resolved",
      evidence: ["El asesor revisa destinatario, contenido y fuentes"],
    },
  ],
});
assert.equal(incomingResolved.gaps[0]?.resolution_status, "resolved");
assert.equal(incomingResolved.counts.unresolved, 0);

const terminal = reconcileAuthoringGapPlan({
  previous: partial,
  candidates: [candidate("semantic")],
  priorGapDispositions: [
    {
      gap_id: semanticGap.id,
      status: "resolved",
      evidence: ["Dataset analytics.owner_agreements"],
    },
  ],
});
assert.equal(terminal.gaps[0]?.resolution_status, "resolved");
assert.equal(terminal.counts.unresolved, 0);
assert.equal(selectAuthoringGapQuestions(terminal).gaps.length, 0);

const replacement = planAuthoringGaps([candidate("replacement")]).gaps[0]!;
const superseded = reconcileAuthoringGapPlan({
  previous: buildAuthoringGapPlan([semanticGap, replacement]),
  candidates: [candidate("replacement")],
  priorGapDispositions: [
    {
      gap_id: semanticGap.id,
      status: "superseded",
      superseded_by: replacement.id,
      evidence: ["La nueva decisión reemplaza la anterior"],
    },
  ],
});
assert.equal(superseded.gaps[0]?.resolution_status, "superseded");
assert.equal(superseded.gaps[0]?.superseded_by, replacement.id);

const retained = reconcileAuthoringGapPlan({
  previous: sixPlan,
  candidates: [sixCandidates[0]!],
});
assert.equal(retained.gaps.length, 6);
assert.ok(retained.gaps.every((gap) => gap.age === 1));

const dependencyPlan = planAuthoringGaps([
  candidate("source", {
    target_dimension: "data_sources",
    summary: "Falta la fuente",
  }),
  candidate("criteria", {
    target_dimension: "acceptance_criteria",
    summary: "Falta el criterio",
    depends_on: ["source"],
  }),
]);
const sourceId = createAuthoringGapId(candidate("source"));
const criteriaId = createAuthoringGapId(candidate("criteria"));
assert.equal(
  dependencyPlan.gaps.find((gap) => gap.id === criteriaId)?.state,
  "blocked_dependency"
);
const unlocked = reconcileAuthoringGapPlan({
  previous: dependencyPlan,
  candidates: [
    candidate("source", {
      target_dimension: "data_sources",
      summary: "Falta la fuente",
    }),
    candidate("criteria", {
      target_dimension: "acceptance_criteria",
      summary: "Falta el criterio",
      depends_on: ["source"],
    }),
  ],
  answeredGapIds: [sourceId],
});
assert.equal(
  unlocked.gaps.find((gap) => gap.id === criteriaId)?.state,
  "open"
);
assert.equal(unlocked.counts.askable, 1);

const oldOptional = planAuthoringGaps([
  candidate("old-optional", {
    severity: "optional",
    priority: 0,
  }),
]);
const agedOptional = buildAuthoringGapPlan([
  { ...oldOptional.gaps[0]!, age: 2 },
  ...planAuthoringGaps([
    candidate("new-blocker", { severity: "blocking", priority: 100 }),
  ]).gaps,
]);
assert.equal(
  selectAuthoringGapQuestions(agedOptional, 1).gaps[0]?.id,
  createAuthoringGapId(candidate("new-blocker"))
);

const oldLowPriorityBlocker = planAuthoringGaps([
  candidate("old-low-priority", { severity: "blocking", priority: 0 }),
]).gaps[0]!;
const agedBlockers = buildAuthoringGapPlan([
  { ...oldLowPriorityBlocker, age: 2 },
  ...planAuthoringGaps([
    candidate("new-high-priority", { severity: "blocking", priority: 100 }),
  ]).gaps,
]);
assert.equal(
  selectAuthoringGapQuestions(agedBlockers, 1).gaps[0]?.id,
  oldLowPriorityBlocker.id
);

const defaultsPlan = planAuthoringGaps([
  candidate("timezone", {
    severity: "defaultable",
    safe_default: "UTC",
  }),
  candidate("recipient", { severity: "blocking" }),
]);
const timezoneId = createAuthoringGapId(candidate("timezone"));
const recipientId = createAuthoringGapId(candidate("recipient"));
const defaults = applyAuthoringGapDefaults({
  plan: defaultsPlan,
  gapIds: [timezoneId, recipientId, "gap_00000000"],
});
assert.deepEqual(defaults.applied, [{ gap_id: timezoneId, value: "UTC" }]);
assert.deepEqual(
  new Set(defaults.rejected_gap_ids),
  new Set([recipientId, "gap_00000000"])
);
assert.equal(
  defaults.plan.gaps.find((gap) => gap.id === timezoneId)?.state,
  "defaulted"
);
assert.equal(defaults.plan.can_proceed, false);

const onlyDefaultable = planAuthoringGaps([
  candidate("locale", {
    severity: "defaultable",
    safe_default: "es-MX",
  }),
]);
assert.equal(onlyDefaultable.can_proceed, true);

const legacy = migrateLegacyAuthoringGapPlan({
  gaps: ["Falta fuente"],
  questions: ["¿Cuál es la fuente?"],
});
assert.equal(legacy.gaps.length, 1);
assert.equal(legacy.gaps[0]?.severity, "blocking");
assert.equal(legacy.gaps[0]?.question, "¿Cuál es la fuente?");
assert.equal(legacy.can_proceed, false);

const v1Open = planAuthoringGaps([candidate("v1-open")]).gaps[0]!;
const v1Resolved = planAuthoringGaps([candidate("v1-resolved")]).gaps[0]!;
const migratedV1 = parseAuthoringGapPlan({
  version: 1,
  gaps: [
    {
      ...v1Open,
      state: "asked",
      resolution_status: undefined,
      evidence: undefined,
    },
    {
      ...v1Resolved,
      state: "answered",
      resolution_status: undefined,
      evidence: undefined,
    },
  ],
  counts: {
    total: 2,
    unresolved: 1,
    blockers: 1,
    defaultable: 0,
    optional: 0,
    askable: 0,
  },
  can_proceed: false,
});
assert.equal(migratedV1.version, 2);
assert.equal(migratedV1.gaps[0]?.state, "asked");
assert.equal(migratedV1.gaps[0]?.resolution_status, "open");
assert.equal(migratedV1.gaps[1]?.resolution_status, "resolved");
assert.equal(migratedV1.counts.unresolved, 1);

const emptyResidual = authoringPriorGapDispositionSchema.parse({
  gap_id: semanticGap.id,
  status: "partial",
  evidence: [],
  residual: "   ",
});
assert.equal(emptyResidual.status, "unanswered");
assert.equal(emptyResidual.residual, undefined);
const emptyNonPartial = authoringPriorGapDispositionSchema.parse({
  gap_id: semanticGap.id,
  status: "open",
  evidence: [""],
  residual: "",
});
assert.equal(emptyNonPartial.status, "open");
assert.deepEqual(emptyNonPartial.evidence, []);
assert.equal(emptyNonPartial.residual, undefined);

console.log("authoring-gap-planner.selftest: all checks passed");
