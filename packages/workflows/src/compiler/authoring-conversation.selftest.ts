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
  authoringConversationMetaSchema,
  proceedAuthoringDiscoveryToProposal,
  resolveAuthoringConversationTurn,
} from "./authoring-conversation";
import {
  createAuthoringGapId,
  planAuthoringGaps,
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
assert.equal(blockedCheckpoint.phase, "checkpoint");
assert.equal(blockedCheckpoint.meta.allow_proceed_to_proposal, false);
assert.equal(blockedCheckpoint.discovery.gap_plan?.counts.blockers, 1);
assert.match(
  blockedCheckpoint.meta.human_message ?? "",
  /Queda 1 decisión necesaria/i,
  "blocker-aware checkpoint copy must surface the pending decision"
);
assert.doesNotMatch(
  blockedCheckpoint.meta.human_message ?? "",
  /preparo la propuesta/i,
  "checkpoint with blockers must not invite preparing a proposal"
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
