/**
 * Política pura de conversación adaptativa para Studio authoring discovery.
 *
 * - Soft checkpoint tras 3 turnos de respuesta.
 * - Hard limit en 5 turnos.
 * - Hasta 4 preguntas por turno (validado en el schema de discovery).
 * - Separación: fase conversacional ≠ forma de trabajo (final_kind).
 */
import { z } from "zod";
import {
  authoringDiscoveryOutputSchema,
  authoringUnderstandingSummarySchema,
  type AuthoringDiscoveryOutput,
} from "./authoring-discovery";
import { isArtifactKind } from "./authoring-router";

export const AUTHORING_SOFT_CHECKPOINT_TURN = 3;
export const AUTHORING_HARD_LIMIT_TURN = 5;
export const AUTHORING_MAX_QUESTIONS_PER_TURN = 4;

export const AUTHORING_CONVERSATION_PHASES = [
  "intake",
  "discovering",
  "checkpoint",
  "proposal",
  "blocked",
  "redirect",
] as const;

export type AuthoringConversationPhase =
  (typeof AUTHORING_CONVERSATION_PHASES)[number];

export const authoringDiscoveryCompactStateSchema = z.object({
  understanding: authoringUnderstandingSummarySchema,
  covered_dimensions: z
    .array(
      z.object({
        key: z.string(),
        status: z.enum(["covered", "partial", "missing"]),
        summary: z.string(),
        evidence: z
          .array(
            z.object({
              source: z.enum(["description", "answer"]),
              answer_index: z.number().int().nonnegative().optional(),
              quote: z.string(),
            })
          )
          .default([]),
      })
    )
    .default([]),
  gaps: z.array(z.string()).default([]),
  assumptions: z.array(z.string()).default([]),
  material_ambiguities: z.array(z.string()).default([]),
  prior_questions: z.array(z.string()).default([]),
  answer_turn_count: z.number().int().nonnegative(),
  proposed_kind: z.string().optional(),
  skill_subtype: z.string().optional(),
});

export type AuthoringDiscoveryCompactState = z.infer<
  typeof authoringDiscoveryCompactStateSchema
>;

export const authoringConversationMetaSchema = z.object({
  conversation_phase: z.enum(AUTHORING_CONVERSATION_PHASES),
  answer_turn_count: z.number().int().nonnegative(),
  soft_checkpoint_turn: z.literal(AUTHORING_SOFT_CHECKPOINT_TURN),
  hard_limit_turn: z.literal(AUTHORING_HARD_LIMIT_TURN),
  extended_after_checkpoint: z.boolean().default(false),
  pending_questions: z.array(z.string()).default([]),
  allow_continue: z.boolean().default(false),
  allow_proceed_to_proposal: z.boolean().default(false),
  compact_state: authoringDiscoveryCompactStateSchema.optional(),
  human_message: z.string().optional(),
});

export type AuthoringConversationMeta = z.infer<
  typeof authoringConversationMetaSchema
>;

export function buildAuthoringDiscoveryCompactState(params: {
  discovery: AuthoringDiscoveryOutput;
  priorQuestions: readonly string[];
  answerTurnCount: number;
}): AuthoringDiscoveryCompactState {
  return authoringDiscoveryCompactStateSchema.parse({
    understanding: params.discovery.understanding,
    covered_dimensions: params.discovery.covered_dimensions.map((dimension) => ({
      key: dimension.key,
      status: dimension.status,
      summary: dimension.summary,
      evidence: dimension.evidence,
    })),
    gaps: params.discovery.gaps,
    assumptions: params.discovery.assumptions,
    material_ambiguities: params.discovery.material_ambiguities,
    prior_questions: [...params.priorQuestions],
    answer_turn_count: params.answerTurnCount,
    proposed_kind:
      isArtifactKind(params.discovery.final_kind) ||
      params.discovery.final_kind === "redirect_to_chat"
        ? params.discovery.final_kind
        : undefined,
    skill_subtype: params.discovery.skill_subtype,
  });
}

function forceProposalFromDiscovery(
  discovery: AuthoringDiscoveryOutput
): AuthoringDiscoveryOutput | null {
  if (discovery.readiness === "redirect") return null;
  if (discovery.readiness === "ready_for_confirmation") return discovery;
  if (!isArtifactKind(discovery.final_kind)) return null;
  return authoringDiscoveryOutputSchema.parse({
    ...discovery,
    clarifying_questions: [],
    clarifying_question_details: [],
    readiness: "ready_for_confirmation",
    gaps:
      discovery.gaps.length > 0
        ? discovery.gaps
        : discovery.material_ambiguities.length > 0
          ? discovery.material_ambiguities
          : [
              "Quedaron puntos sin cerrar del todo; revisa el resumen antes de crear el borrador.",
            ],
  });
}

function buildBlockedDiscovery(
  discovery: AuthoringDiscoveryOutput
): AuthoringDiscoveryOutput {
  return authoringDiscoveryOutputSchema.parse({
    ...discovery,
    clarifying_questions: [],
    clarifying_question_details: [],
    readiness: "blocked_reformulate",
    gaps: [
      ...(discovery.gaps.length > 0
        ? discovery.gaps
        : discovery.material_ambiguities),
      "No fue posible cerrar ambigüedades materiales. Reformula la descripción incorporando lo ya aclarado.",
    ],
    confidence: "low",
  });
}

function baseMeta(params: {
  phase: AuthoringConversationPhase;
  turn: number;
  extended: boolean;
  pending?: readonly string[];
  allowContinue?: boolean;
  allowProceed?: boolean;
  compact: AuthoringDiscoveryCompactState;
  message: string;
}): AuthoringConversationMeta {
  return authoringConversationMetaSchema.parse({
    conversation_phase: params.phase,
    answer_turn_count: params.turn,
    soft_checkpoint_turn: AUTHORING_SOFT_CHECKPOINT_TURN,
    hard_limit_turn: AUTHORING_HARD_LIMIT_TURN,
    extended_after_checkpoint: params.extended,
    pending_questions: [...(params.pending ?? [])],
    allow_continue: Boolean(params.allowContinue),
    allow_proceed_to_proposal: Boolean(params.allowProceed),
    compact_state: params.compact,
    human_message: params.message,
  });
}

/**
 * Aplica la política de turnos sobre la salida del modelo.
 * `answerTurnCount` incluye la respuesta recién enviada (0 en el primer discover).
 */
export function resolveAuthoringConversationTurn(params: {
  discovery: AuthoringDiscoveryOutput;
  answerTurnCount: number;
  priorQuestions?: readonly string[];
  extendedAfterCheckpoint?: boolean;
}): {
  phase: AuthoringConversationPhase;
  discovery: AuthoringDiscoveryOutput;
  meta: AuthoringConversationMeta;
} {
  const priorQuestions = params.priorQuestions ?? [];
  const extended = Boolean(params.extendedAfterCheckpoint);
  const turn = Math.max(0, params.answerTurnCount);
  const compact = buildAuthoringDiscoveryCompactState({
    discovery: params.discovery,
    priorQuestions,
    answerTurnCount: turn,
  });

  if (params.discovery.readiness === "redirect") {
    return {
      phase: "redirect",
      discovery: params.discovery,
      meta: baseMeta({
        phase: "redirect",
        turn,
        extended,
        compact,
        message: "Esto encaja mejor como una consulta puntual en el chat.",
      }),
    };
  }

  if (
    params.discovery.readiness === "ready_for_confirmation" ||
    params.discovery.readiness === "blocked_reformulate"
  ) {
    const phase =
      params.discovery.readiness === "blocked_reformulate"
        ? "blocked"
        : "proposal";
    return {
      phase,
      discovery: params.discovery,
      meta: baseMeta({
        phase,
        turn,
        extended,
        compact,
        message:
          phase === "blocked"
            ? "Aún faltan datos materiales. Reformula la solicitud con lo ya aclarado."
            : "Confirma lo entendido antes de crear el borrador.",
      }),
    };
  }

  // needs_clarification
  const pending = params.discovery.clarifying_questions.slice(
    0,
    AUTHORING_MAX_QUESTIONS_PER_TURN
  );

  if (turn >= AUTHORING_HARD_LIMIT_TURN) {
    const forced = forceProposalFromDiscovery(params.discovery);
    if (forced) {
      return {
        phase: "proposal",
        discovery: forced,
        meta: baseMeta({
          phase: "proposal",
          turn,
          extended,
          compact: buildAuthoringDiscoveryCompactState({
            discovery: forced,
            priorQuestions,
            answerTurnCount: turn,
          }),
          message:
            "Llegamos al límite de aclaraciones. Revisa el resumen y los supuestos antes de crear el borrador.",
        }),
      };
    }
    const blocked = buildBlockedDiscovery(params.discovery);
    return {
      phase: "blocked",
      discovery: blocked,
      meta: baseMeta({
        phase: "blocked",
        turn,
        extended,
        compact: buildAuthoringDiscoveryCompactState({
          discovery: blocked,
          priorQuestions,
          answerTurnCount: turn,
        }),
        message:
          "Aún faltan datos materiales para proponer un borrador seguro. Reformula la solicitud con lo que ya aclaramos.",
      }),
    };
  }

  // Soft checkpoint exactly after the 3rd answer, before opt-in continuation.
  if (turn === AUTHORING_SOFT_CHECKPOINT_TURN && !extended) {
    const canProceed = isArtifactKind(params.discovery.final_kind);
    return {
      phase: "checkpoint",
      discovery: {
        ...params.discovery,
        clarifying_questions: pending,
      },
      meta: baseMeta({
        phase: "checkpoint",
        turn,
        extended,
        pending,
        allowContinue: pending.length > 0,
        allowProceed: canProceed,
        compact,
        message: canProceed
          ? "Ya tengo bastante contexto. ¿Seguimos aclarando o preparo la propuesta con lo entendido?"
          : "Necesito un poco más de contexto. Puedes seguir aclarando o reformular la solicitud.",
      }),
    };
  }

  return {
    phase: "discovering",
    discovery: {
      ...params.discovery,
      clarifying_questions: pending,
    },
    meta: baseMeta({
      phase: "discovering",
      turn,
      extended,
      pending,
      compact,
      message:
        "Necesito un poco más de contexto para preparar un borrador seguro.",
    }),
  };
}

/** Fuerza propuesta cuando el humano elige cerrar el checkpoint. */
export function proceedAuthoringDiscoveryToProposal(params: {
  discovery: AuthoringDiscoveryOutput;
  answerTurnCount: number;
  priorQuestions?: readonly string[];
  extendedAfterCheckpoint?: boolean;
}):
  | {
      ok: true;
      discovery: AuthoringDiscoveryOutput;
      meta: AuthoringConversationMeta;
    }
  | {
      ok: false;
      reason: string;
      meta: AuthoringConversationMeta;
    } {
  const forced = forceProposalFromDiscovery(params.discovery);
  const compact = buildAuthoringDiscoveryCompactState({
    discovery: params.discovery,
    priorQuestions: params.priorQuestions ?? [],
    answerTurnCount: params.answerTurnCount,
  });
  if (!forced) {
    return {
      ok: false,
      reason:
        "Aún no hay una forma de trabajo suficientemente clara. Sigue aclarando o reformula la solicitud.",
      meta: baseMeta({
        phase: "blocked",
        turn: params.answerTurnCount,
        extended: Boolean(params.extendedAfterCheckpoint),
        pending: params.discovery.clarifying_questions,
        allowContinue: params.discovery.clarifying_questions.length > 0,
        compact,
        message:
          "Aún no hay una forma de trabajo suficientemente clara para proponer un borrador.",
      }),
    };
  }
  return {
    ok: true,
    discovery: forced,
    meta: baseMeta({
      phase: "proposal",
      turn: params.answerTurnCount,
      extended: Boolean(params.extendedAfterCheckpoint),
      compact: buildAuthoringDiscoveryCompactState({
        discovery: forced,
        priorQuestions: params.priorQuestions ?? [],
        answerTurnCount: params.answerTurnCount,
      }),
      message: "Confirma lo entendido antes de crear el borrador.",
    }),
  };
}
