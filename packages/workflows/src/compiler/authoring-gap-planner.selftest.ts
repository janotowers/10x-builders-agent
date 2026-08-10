import assert from "node:assert/strict";
import {
  applyAuthoringGapDefaults,
  buildAuthoringGapPlan,
  createAuthoringGapId,
  deriveFlatAuthoringGaps,
  migrateLegacyAuthoringGapPlan,
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

const ignoredAskedGap = reconcileAuthoringGapPlan({
  previous: selectAuthoringGapQuestions(
    planAuthoringGaps([
      candidate("ignored", {
        examples: ["El asesor responde con el documento correcto"],
      }),
    ])
  ).plan,
  candidates: [],
});
assert.equal(ignoredAskedGap.gaps[0]?.state, "open");
assert.deepEqual(ignoredAskedGap.gaps[0]?.examples, [
  "El asesor responde con el documento correcto",
]);
assert.equal(
  selectAuthoringGapQuestions(ignoredAskedGap).questions[0],
  "¿Pregunta ignored?"
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

console.log("authoring-gap-planner.selftest: all checks passed");
