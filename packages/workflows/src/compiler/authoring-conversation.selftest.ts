import assert from "node:assert/strict";
import {
  authoringDiscoveryOutputSchema,
  type AuthoringDiscoveryOutput,
} from "./authoring-discovery";
import {
  AUTHORING_HARD_LIMIT_TURN,
  AUTHORING_MAX_PROPOSAL_REVISIONS,
  AUTHORING_SOFT_CHECKPOINT_TURN,
  appendAuthoringProposalRevision,
  appendAuthoringQaExchange,
  authoringConversationMetaSchema,
  authoringDiscoveryCompactStateSchema,
  authoringQaExchangeSchema,
  proceedAuthoringDiscoveryToProposal,
  resolveAuthoringConversationTurn,
} from "./authoring-conversation";
import {
  createAuthoringGapId,
  planAuthoringGaps,
  selectAuthoringGapQuestions,
} from "./authoring-gap-planner";

const nonBlockingPlan = planAuthoringGaps([
  {
    key: "source",
    summary: "Fuente del acuerdo",
    target_dimension: "data_sources",
    question: "¿De qué fuente sale el último acuerdo?",
    severity: "defaultable",
    safe_default: "Documento adjunto en cada ejecución",
  },
  {
    key: "approval",
    summary: "Aprobación previa",
    target_dimension: "human_decisions",
    question: "¿Quién aprueba antes de enviar?",
    severity: "optional",
  },
]);

const blockingPlan = planAuthoringGaps([
  {
    key: "recipient",
    summary: "Falta el destinatario",
    target_dimension: "actors",
    question: "¿Quién recibe el resultado?",
    severity: "blocking",
  },
]);

function baseDiscovery(
  overrides: Partial<AuthoringDiscoveryOutput> = {}
): AuthoringDiscoveryOutput {
  return authoringDiscoveryOutputSchema.parse({
    provisional_kind: "reusable_skill",
    final_kind: "reusable_skill",
    skill_subtype: "simple",
    confidence: "medium",
    rationale: ["Procedimiento reusable."],
    covered_dimensions: [
      {
        key: "objective",
        status: "partial",
        summary: "Preparar seguimiento.",
        evidence: [
          {
            source: "description",
            quote: "seguimiento",
          },
        ],
      },
    ],
    material_ambiguities: ["Falta fuente concreta."],
    clarifying_questions: [
      "¿De qué fuente sale el último acuerdo?",
      "¿Quién aprueba antes de enviar?",
    ],
    assumptions: [],
    gaps: ["Fuente del acuerdo"],
    gap_plan: nonBlockingPlan,
    requested_side_effects: [],
    readiness: "needs_clarification",
    suggested_title: "Seguimiento a propietarios",
    suggested_slug: "owner_followup_message",
    understanding: {
      objective: "Preparar un seguimiento.",
      sources: [],
      actors: ["Asesor"],
      decisions: [],
      effects: [],
      capabilities: [],
      acceptance_criteria: [],
      assumptions: [],
      gaps: ["Fuente del acuerdo"],
    },
    ...overrides,
  });
}

const early = resolveAuthoringConversationTurn({
  discovery: baseDiscovery(),
  answerTurnCount: 1,
});
assert.equal(early.phase, "discovering");
assert.equal(early.discovery.clarifying_questions.length, 2);

// Discovery already selected and marked its batch; the turn policy must reuse
// that selection instead of consuming the next one, which previously surfaced
// unrelated questions and dropped every example.
const preselectedPlan = selectAuthoringGapQuestions(
  planAuthoringGaps([
    {
      key: "source",
      summary: "Fuente del acuerdo",
      target_dimension: "data_sources",
      question: "¿De qué fuente sale el último acuerdo?",
      severity: "blocking",
      priority: 95,
      examples: ["documento Word", "correo"],
    },
    {
      key: "format",
      summary: "Formato del mensaje",
      target_dimension: "acceptance_criteria",
      question: "¿Qué formato debe tener el mensaje?",
      severity: "optional",
      priority: 20,
    },
  ]),
  1
);
const preselected = resolveAuthoringConversationTurn({
  discovery: baseDiscovery({
    gap_plan: preselectedPlan.plan,
    clarifying_questions: ["¿De qué fuente sale el último acuerdo?"],
    clarifying_question_details: [
      {
        question: "¿De qué fuente sale el último acuerdo?",
        target_dimension: "data_sources",
        gap: "Fuente del acuerdo",
        examples: ["documento Word", "correo"],
      },
    ],
  }),
  answerTurnCount: 1,
});
assert.deepEqual(preselected.meta.pending_questions, [
  "¿De qué fuente sale el último acuerdo?",
]);
assert.deepEqual(preselected.discovery.clarifying_questions, [
  "¿De qué fuente sale el último acuerdo?",
]);
assert.deepEqual(
  preselected.discovery.clarifying_question_details[0]?.examples,
  ["documento Word", "correo"],
  "examples selected by discovery must survive the turn policy"
);
assert.equal(
  preselected.discovery.gap_plan?.gaps.filter((gap) => gap.state === "asked")
    .length,
  1,
  "the turn policy must not mark a second batch as asked"
);

const checkpoint = resolveAuthoringConversationTurn({
  discovery: baseDiscovery(),
  answerTurnCount: AUTHORING_SOFT_CHECKPOINT_TURN,
});
assert.equal(checkpoint.phase, "checkpoint");
assert.equal(checkpoint.meta.allow_continue, true);
assert.equal(checkpoint.meta.allow_proceed_to_proposal, true);

const blockedCheckpoint = resolveAuthoringConversationTurn({
  discovery: baseDiscovery({ gap_plan: blockingPlan }),
  answerTurnCount: AUTHORING_SOFT_CHECKPOINT_TURN,
});
assert.equal(
  blockedCheckpoint.phase,
  "discovering",
  "el checkpoint suave no interrumpe mientras hay blockers preguntables"
);
assert.equal(blockedCheckpoint.meta.allow_proceed_to_proposal, false);
assert.equal(blockedCheckpoint.discovery.gap_plan?.counts.blockers, 1);
assert.doesNotMatch(
  blockedCheckpoint.meta.human_message ?? "",
  /checkpoint|preparo la propuesta|Queda 1 decisión/i,
  "el turno continúa como aclaración normal"
);

const afterContinue = resolveAuthoringConversationTurn({
  discovery: baseDiscovery(),
  answerTurnCount: 4,
  extendedAfterCheckpoint: true,
});
assert.equal(afterContinue.phase, "discovering");

const hardClose = resolveAuthoringConversationTurn({
  discovery: baseDiscovery(),
  answerTurnCount: AUTHORING_HARD_LIMIT_TURN,
  extendedAfterCheckpoint: true,
});
assert.equal(hardClose.phase, "proposal");
assert.equal(hardClose.discovery.readiness, "ready_for_confirmation");
assert.equal(hardClose.discovery.clarifying_questions.length, 0);

const blockerAtHardLimit = resolveAuthoringConversationTurn({
  discovery: baseDiscovery({ gap_plan: blockingPlan }),
  answerTurnCount: AUTHORING_HARD_LIMIT_TURN,
  extendedAfterCheckpoint: true,
});
assert.equal(blockerAtHardLimit.phase, "blocked");
assert.equal(blockerAtHardLimit.discovery.readiness, "blocked_reformulate");

const blocked = resolveAuthoringConversationTurn({
  discovery: baseDiscovery({
    final_kind: "clarify",
    skill_subtype: undefined,
    clarifying_questions: ["¿Qué resultado quieres?"],
  }),
  answerTurnCount: AUTHORING_HARD_LIMIT_TURN,
  extendedAfterCheckpoint: true,
});
assert.equal(blocked.phase, "blocked");
assert.equal(blocked.discovery.readiness, "blocked_reformulate");

const ready = resolveAuthoringConversationTurn({
  discovery: baseDiscovery({
    readiness: "ready_for_confirmation",
    clarifying_questions: [],
    material_ambiguities: [],
    gaps: [],
  }),
  answerTurnCount: 1,
});
assert.equal(ready.phase, "proposal");

const proceeded = proceedAuthoringDiscoveryToProposal({
  discovery: baseDiscovery(),
  answerTurnCount: 3,
});
assert.equal(proceeded.ok, true);
if (proceeded.ok) {
  assert.equal(proceeded.discovery.readiness, "ready_for_confirmation");
  assert.equal(proceeded.meta.conversation_phase, "proposal");
  assert.equal(proceeded.meta.proposal_revision_count, 0);
  assert.deepEqual(proceeded.meta.proposal_revisions, []);

  let revised = appendAuthoringProposalRevision({
    meta: proceeded.meta,
    correction: "El documento se adjunta en cada ejecución.",
    priorHash: "sha256:old",
    proposalHash: "sha256:new-1",
    revisedAt: "2026-08-09T18:00:00.000Z",
  });
  assert.equal(revised.answer_turn_count, proceeded.meta.answer_turn_count);
  assert.equal(revised.proposal_revision_count, 1);
  assert.equal(revised.proposal_revisions[0]?.prior_hash, "sha256:old");
  for (let index = 1; index < AUTHORING_MAX_PROPOSAL_REVISIONS; index += 1) {
    revised = appendAuthoringProposalRevision({
      meta: revised,
      correction: `Ajuste ${index + 1}`,
      priorHash: `sha256:new-${index}`,
      proposalHash: `sha256:new-${index + 1}`,
      revisedAt: "2026-08-09T18:00:00.000Z",
    });
  }
  assert.throws(
    () =>
      appendAuthoringProposalRevision({
        meta: revised,
        correction: "Un ajuste adicional",
        priorHash: "sha256:last",
        proposalHash: "sha256:overflow",
        revisedAt: "2026-08-09T18:00:00.000Z",
      }),
    /authoring_proposal_revision_limit_reached/
  );
}

const sourceGapId = createAuthoringGapId({
  key: "source",
  summary: "Fuente del acuerdo",
  target_dimension: "data_sources",
});
const proceededWithDefault = proceedAuthoringDiscoveryToProposal({
  discovery: baseDiscovery(),
  answerTurnCount: 3,
  defaultGapIds: [sourceGapId],
});
assert.equal(proceededWithDefault.ok, true);
if (proceededWithDefault.ok) {
  assert.deepEqual(proceededWithDefault.meta.applied_defaults, [
    {
      gap_id: sourceGapId,
      value: "Documento adjunto en cada ejecución",
    },
  ]);
  assert.equal(
    proceededWithDefault.discovery.gap_plan?.gaps.find(
      (gap) => gap.id === sourceGapId
    )?.state,
    "defaulted"
  );
}

const legacyMeta = authoringConversationMetaSchema.parse({
  conversation_phase: "proposal",
  answer_turn_count: 2,
  soft_checkpoint_turn: AUTHORING_SOFT_CHECKPOINT_TURN,
  hard_limit_turn: AUTHORING_HARD_LIMIT_TURN,
});
assert.equal(legacyMeta.proposal_revision_count, 0);
assert.deepEqual(legacyMeta.proposal_revisions, []);

const ledgerGapId = createAuthoringGapId({
  key: "ledger-source",
  summary: "Fuente exacta",
  target_dimension: "data_sources",
});
const verbatimAnswer = "  Está en BigQuery, dataset `ventas_owner`.  ";
const exchange = authoringQaExchangeSchema.parse({
  batch_id: "batch-2",
  turn_id: "turn-3",
  gap_ids: [ledgerGapId],
  questions: ["¿Cuál es la fuente exacta?"],
  question_details: [
    {
      question: "¿Cuál es la fuente exacta?",
      target_dimension: "data_sources",
      gap: "Fuente exacta",
      gap_id: ledgerGapId,
      examples: ["BigQuery"],
    },
  ],
  answer: verbatimAnswer,
  timestamp: "2026-08-10T20:00:00.000Z",
});
assert.equal(exchange.answer, verbatimAnswer, "QA answer must remain verbatim");
const compactWithLedger = appendAuthoringQaExchange({
  compactState: authoringDiscoveryCompactStateSchema.parse({
    ...early.meta.compact_state!,
    qa_exchanges: [],
    question_number_registry: [{ gap_id: ledgerGapId, number: 7 }],
  }),
  exchange,
});
assert.equal(compactWithLedger.qa_exchanges.length, 1);
assert.equal(compactWithLedger.qa_exchanges[0]?.answer, verbatimAnswer);
assert.equal(compactWithLedger.question_number_registry[0]?.number, 7);
assert.equal(early.meta.compact_state?.qa_exchanges.length, 0);

const cannotProceed = proceedAuthoringDiscoveryToProposal({
  discovery: baseDiscovery({
    final_kind: "clarify",
    skill_subtype: undefined,
  }),
  answerTurnCount: 3,
});
assert.equal(cannotProceed.ok, false);

const blockerCannotProceed = proceedAuthoringDiscoveryToProposal({
  discovery: baseDiscovery({ gap_plan: blockingPlan }),
  answerTurnCount: 3,
});
assert.equal(blockerCannotProceed.ok, false);

console.log("authoring-conversation.selftest: all checks passed");
