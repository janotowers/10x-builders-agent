import assert from "node:assert/strict";
import {
  authoringDiscoveryOutputSchema,
  type AuthoringDiscoveryOutput,
} from "./authoring-discovery";
import {
  AUTHORING_HARD_LIMIT_TURN,
  AUTHORING_SOFT_CHECKPOINT_TURN,
  proceedAuthoringDiscoveryToProposal,
  resolveAuthoringConversationTurn,
} from "./authoring-conversation";

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
}

const cannotProceed = proceedAuthoringDiscoveryToProposal({
  discovery: baseDiscovery({
    final_kind: "clarify",
    skill_subtype: undefined,
  }),
  answerTurnCount: 3,
});
assert.equal(cannotProceed.ok, false);

console.log("authoring-conversation.selftest: all checks passed");
