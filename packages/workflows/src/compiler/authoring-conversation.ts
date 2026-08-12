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
  authoringCapabilityNeedSchema,
  authoringDataSourcesContractSchema,
  authoringDiscoveryOutputSchema,
  authoringInvocationChannelSchema,
  authoringOutboundContractSchema,
  authoringRecipientProvenanceReviewSchema,
  authoringSourceStrategySchema,
  authoringUnderstandingSummarySchema,
  type AuthoringDiscoveryOutput,
} from "./authoring-discovery";
import { inputRequirementSchema } from "./input-requirements";
import { isArtifactKind } from "./authoring-router";
import {
  applyAuthoringGapDefaults,
  authoringAppliedDefaultSchema,
  authoringGapPlanSchema,
  buildAuthoringGapPlan,
  isAuthoringGapResolved,
  migrateLegacyAuthoringGapPlan,
  selectAuthoringGapQuestions,
  type AuthoringAppliedDefault,
  type AuthoringGapPlan,
} from "./authoring-gap-planner";
import {
  inferSolutionPatternTriggers,
  resolveSolutionPatternComposition,
} from "./solution-patterns";

export const AUTHORING_SOFT_CHECKPOINT_TURN = 3;
export const AUTHORING_HARD_LIMIT_TURN = 5;
export const AUTHORING_MAX_QUESTIONS_PER_TURN = 4;
export const AUTHORING_MAX_PROPOSAL_REVISIONS = 3;

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

/**
 * Verbatim operator exchange. Text fields intentionally do not trim or
 * normalize: this is an append-only evidence ledger, not a presentation view.
 */
export const authoringQaExchangeQuestionDetailSchema = z.object({
  question: z.string().min(1).max(8000),
  target_dimension: z.string().min(1).max(160),
  gap: z.string().min(1).max(8000),
  gap_id: z.string().regex(/^gap_[a-z0-9]{8}$/),
  examples: z.array(z.string().max(2000)).max(8).default([]),
});

export const authoringQaExchangeSchema = z
  .object({
    batch_id: z.string().min(1).max(160),
    turn_id: z.string().min(1).max(160),
    gap_ids: z
      .array(z.string().regex(/^gap_[a-z0-9]{8}$/))
      .min(1)
      .max(AUTHORING_MAX_QUESTIONS_PER_TURN),
    questions: z
      .array(z.string().min(1).max(8000))
      .min(1)
      .max(AUTHORING_MAX_QUESTIONS_PER_TURN),
    question_details: z
      .array(authoringQaExchangeQuestionDetailSchema)
      .min(1)
      .max(AUTHORING_MAX_QUESTIONS_PER_TURN),
    answer: z.string().max(32_000),
    timestamp: z.string().datetime(),
  })
  .superRefine((value, ctx) => {
    if (
      value.gap_ids.length !== value.questions.length ||
      value.questions.length !== value.question_details.length
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["question_details"],
        message: "gap_ids, questions y question_details deben estar alineados",
      });
    }
    value.question_details.forEach((detail, index) => {
      if (
        detail.gap_id !== value.gap_ids[index] ||
        detail.question !== value.questions[index]
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["question_details", index],
          message: "cada detalle debe conservar el gap_id y la pregunta exactos",
        });
      }
    });
  });

export const authoringQuestionNumberRegistryEntrySchema = z.object({
  gap_id: z.string().regex(/^gap_[a-z0-9]{8}$/),
  number: z.number().int().positive(),
});

export type AuthoringQaExchange = z.infer<typeof authoringQaExchangeSchema>;
export type AuthoringQuestionNumberRegistryEntry = z.infer<
  typeof authoringQuestionNumberRegistryEntrySchema
>;

export const authoringPatternCompositionSnapshotSchema = z.object({
  work_form: z.enum([
    "case_workflow",
    "durable_task",
    "reusable_skill",
    "schedule",
  ]),
  triggers: z.array(z.string()).default([]),
  pattern_ids: z.array(z.string()).default([]),
});

export const authoringDiscoveryCompactStateSchema = z.object({
  understanding: authoringUnderstandingSummarySchema,
  covered_dimensions: z
    .array(
      z.object({
        key: z.string(),
        status: z.enum([
          "covered",
          "partial",
          "missing",
          "not_applicable",
        ]),
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
  gap_plan: authoringGapPlanSchema.optional(),
  applied_defaults: z.array(authoringAppliedDefaultSchema).default([]),
  assumptions: z.array(z.string()).default([]),
  material_ambiguities: z.array(z.string()).default([]),
  input_requirements: z.array(inputRequirementSchema).default([]),
  invocation_channels: z.array(authoringInvocationChannelSchema).default([]),
  source_strategy: authoringSourceStrategySchema.optional(),
  data_sources: authoringDataSourcesContractSchema.default({
    document_source: null,
    document_intake_route: null,
  }),
  outbound_contract: authoringOutboundContractSchema.optional(),
  recipient_provenance_review:
    authoringRecipientProvenanceReviewSchema.optional(),
  capability_needs: z.array(authoringCapabilityNeedSchema).default([]),
  requested_side_effects: z
    .array(
      z.enum([
        "send_message",
        "human_approval",
        "schedule_recurrence",
        "external_write",
        "create_case",
      ])
    )
    .default([]),
  pattern_composition: authoringPatternCompositionSnapshotSchema.optional(),
  prior_questions: z.array(z.string()).default([]),
  qa_exchanges: z.array(authoringQaExchangeSchema).max(128).default([]),
  question_number_registry: z
    .array(authoringQuestionNumberRegistryEntrySchema)
    .max(128)
    .default([]),
  answer_turn_count: z.number().int().nonnegative(),
  proposed_kind: z.string().optional(),
  skill_subtype: z.string().optional(),
});

export type AuthoringDiscoveryCompactState = z.infer<
  typeof authoringDiscoveryCompactStateSchema
>;

export const authoringProposalRevisionSchema = z.object({
  revision: z.number().int().min(1).max(AUTHORING_MAX_PROPOSAL_REVISIONS),
  correction: z.string().trim().min(1).max(4000),
  prior_hash: z.string().trim().min(1).max(128),
  proposal_hash: z.string().trim().min(1).max(128),
  revised_at: z.string().trim().min(1).max(64),
});

export type AuthoringProposalRevision = z.infer<
  typeof authoringProposalRevisionSchema
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
  proposal_revision_count: z
    .number()
    .int()
    .min(0)
    .max(AUTHORING_MAX_PROPOSAL_REVISIONS)
    .default(0),
  proposal_revisions: z
    .array(authoringProposalRevisionSchema)
    .max(AUTHORING_MAX_PROPOSAL_REVISIONS)
    .default([]),
  applied_defaults: z.array(authoringAppliedDefaultSchema).default([]),
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
  appliedDefaults?: readonly AuthoringAppliedDefault[];
  qaExchanges?: readonly AuthoringQaExchange[];
  questionNumberRegistry?: readonly AuthoringQuestionNumberRegistryEntry[];
}): AuthoringDiscoveryCompactState {
  const patternComposition = isArtifactKind(params.discovery.final_kind)
    ? resolveSolutionPatternComposition({
        workForm: params.discovery.final_kind,
        triggers: inferSolutionPatternTriggers({
          requestedSideEffects: params.discovery.requested_side_effects ?? [],
          capabilityCategoryIds: (params.discovery.capability_needs ?? []).map(
            (need) => need.category_id
          ),
          capabilityProviderIds: (
            params.discovery.capability_needs ?? []
          ).flatMap((need) => (need.provider_id ? [need.provider_id] : [])),
          inputRequirementKinds: (params.discovery.input_requirements ?? []).map(
            (requirement) => requirement.kind
          ),
          inputSourceHints: (params.discovery.input_requirements ?? []).flatMap(
            (requirement) =>
              requirement.source_hint ? [requirement.source_hint] : []
          ),
        }),
      })
    : null;
  return authoringDiscoveryCompactStateSchema.parse({
    understanding: params.discovery.understanding,
    covered_dimensions: params.discovery.covered_dimensions.map((dimension) => ({
      key: dimension.key,
      status: dimension.status,
      summary: dimension.summary,
      evidence: dimension.evidence,
    })),
    gaps: params.discovery.gaps,
    gap_plan: params.discovery.gap_plan,
    applied_defaults: [...(params.appliedDefaults ?? [])],
    assumptions: params.discovery.assumptions,
    material_ambiguities: params.discovery.material_ambiguities,
    input_requirements: params.discovery.input_requirements,
    invocation_channels: params.discovery.invocation_channels,
    source_strategy: params.discovery.source_strategy,
    data_sources: params.discovery.data_sources,
    outbound_contract: params.discovery.outbound_contract,
    recipient_provenance_review:
      params.discovery.recipient_provenance_review,
    capability_needs: params.discovery.capability_needs,
    requested_side_effects: params.discovery.requested_side_effects ?? [],
    pattern_composition: patternComposition
      ? {
          work_form: patternComposition.workForm,
          triggers: patternComposition.triggers,
          pattern_ids: patternComposition.patternIds,
        }
      : undefined,
    prior_questions: [...params.priorQuestions],
    qa_exchanges: [...(params.qaExchanges ?? [])],
    question_number_registry: [...(params.questionNumberRegistry ?? [])],
    answer_turn_count: params.answerTurnCount,
    proposed_kind:
      isArtifactKind(params.discovery.final_kind) ||
      params.discovery.final_kind === "redirect_to_chat"
        ? params.discovery.final_kind
        : undefined,
    skill_subtype: params.discovery.skill_subtype,
  });
}

/** Returns a new compact state with one exact exchange appended to its ledger. */
export function appendAuthoringQaExchange(params: {
  compactState: AuthoringDiscoveryCompactState;
  exchange: AuthoringQaExchange;
}): AuthoringDiscoveryCompactState {
  const compactState = authoringDiscoveryCompactStateSchema.parse(
    params.compactState
  );
  const exchange = authoringQaExchangeSchema.parse(params.exchange);
  return authoringDiscoveryCompactStateSchema.parse({
    ...compactState,
    qa_exchanges: [...compactState.qa_exchanges, exchange],
  });
}

function gapPlanFromDiscovery(
  discovery: AuthoringDiscoveryOutput
): AuthoringGapPlan {
  return discovery.gap_plan
    ? buildAuthoringGapPlan(discovery.gap_plan.gaps)
    : migrateLegacyAuthoringGapPlan({
        gaps: discovery.gaps,
        questions: discovery.clarifying_questions,
        questionDetails: discovery.clarifying_question_details,
      });
}

function discoveryWithGapPlan(params: {
  discovery: AuthoringDiscoveryOutput;
  plan: AuthoringGapPlan;
  questions?: readonly string[];
  readiness?: AuthoringDiscoveryOutput["readiness"];
}): AuthoringDiscoveryOutput {
  const questions = [...(params.questions ?? params.discovery.clarifying_questions)];
  const questionSet = new Set(questions);
  return authoringDiscoveryOutputSchema.parse({
    ...params.discovery,
    gap_plan: params.plan,
    clarifying_questions: questions,
    clarifying_question_details:
      params.discovery.clarifying_question_details.filter((detail) =>
        questionSet.has(detail.question)
      ),
    readiness: params.readiness ?? params.discovery.readiness,
  });
}

function forceProposalFromDiscovery(
  discovery: AuthoringDiscoveryOutput,
  plan: AuthoringGapPlan
): AuthoringDiscoveryOutput | null {
  if (discovery.readiness === "redirect") return null;
  if (!plan.can_proceed) return null;
  if (discovery.readiness === "ready_for_confirmation") {
    return discoveryWithGapPlan({
      discovery,
      plan,
      questions: [],
      readiness: "ready_for_confirmation",
    });
  }
  if (!isArtifactKind(discovery.final_kind)) return null;
  return authoringDiscoveryOutputSchema.parse({
    ...discovery,
    gap_plan: plan,
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
  discovery: AuthoringDiscoveryOutput,
  plan: AuthoringGapPlan
): AuthoringDiscoveryOutput {
  return authoringDiscoveryOutputSchema.parse({
    ...discovery,
    gap_plan: plan,
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
  appliedDefaults?: readonly AuthoringAppliedDefault[];
  proposalRevisions?: readonly AuthoringProposalRevision[];
  message: string;
}): AuthoringConversationMeta {
  const proposalRevisions = [...(params.proposalRevisions ?? [])];
  return authoringConversationMetaSchema.parse({
    conversation_phase: params.phase,
    answer_turn_count: params.turn,
    soft_checkpoint_turn: AUTHORING_SOFT_CHECKPOINT_TURN,
    hard_limit_turn: AUTHORING_HARD_LIMIT_TURN,
    extended_after_checkpoint: params.extended,
    pending_questions: [...(params.pending ?? [])],
    allow_continue: Boolean(params.allowContinue),
    allow_proceed_to_proposal: Boolean(params.allowProceed),
    proposal_revision_count: proposalRevisions.length,
    proposal_revisions: proposalRevisions,
    applied_defaults: [...(params.appliedDefaults ?? [])],
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
  proposalRevisions?: readonly AuthoringProposalRevision[];
  appliedDefaults?: readonly AuthoringAppliedDefault[];
  defaultGapIds?: readonly string[];
  qaExchanges?: readonly AuthoringQaExchange[];
  questionNumberRegistry?: readonly AuthoringQuestionNumberRegistryEntry[];
}): {
  phase: AuthoringConversationPhase;
  discovery: AuthoringDiscoveryOutput;
  meta: AuthoringConversationMeta;
} {
  const priorQuestions = params.priorQuestions ?? [];
  const extended = Boolean(params.extendedAfterCheckpoint);
  const turn = Math.max(0, params.answerTurnCount);
  const defaultResult = applyAuthoringGapDefaults({
    plan: gapPlanFromDiscovery(params.discovery),
    gapIds: params.defaultGapIds ?? [],
  });
  const appliedDefaults = [
    ...(params.appliedDefaults ?? []),
    ...defaultResult.applied,
  ].filter(
    (entry, index, all) =>
      all.findIndex((candidate) => candidate.gap_id === entry.gap_id) === index
  );
  // Discovery already owns gap selection: it marks the chosen gaps as `asked`
  // and emits those questions together with their examples. Selecting again
  // here would consume a second batch, show the operator questions the plan
  // never paired with details, and drop every example. Only legacy outputs
  // without a deterministic selection fall back to selecting here.
  const stillAskable = new Set(
    defaultResult.plan.gaps
      .filter((gap) => !isAuthoringGapResolved(gap) && gap.question)
      .map((gap) => gap.question as string)
  );
  const alreadySelected = params.discovery.clarifying_questions
    .filter((question) => stillAskable.has(question))
    .slice(0, AUTHORING_MAX_QUESTIONS_PER_TURN);
  const fallback =
    alreadySelected.length > 0
      ? null
      : selectAuthoringGapQuestions(defaultResult.plan);
  const pending = fallback ? fallback.questions : alreadySelected;
  const plan = fallback?.plan ?? defaultResult.plan;

  let discovery = discoveryWithGapPlan({
    discovery: params.discovery,
    plan,
    questions:
      params.discovery.readiness === "needs_clarification" ? pending : [],
  });
  if (
    discovery.readiness === "ready_for_confirmation" &&
    !plan.can_proceed
  ) {
    discovery =
      pending.length > 0
        ? discoveryWithGapPlan({
            discovery: params.discovery,
            plan,
            questions: pending,
            readiness: "needs_clarification",
          })
        : buildBlockedDiscovery(params.discovery, plan);
  }
  const compact = buildAuthoringDiscoveryCompactState({
    discovery,
    priorQuestions,
    answerTurnCount: turn,
    appliedDefaults,
    qaExchanges: params.qaExchanges,
    questionNumberRegistry: params.questionNumberRegistry,
  });

  if (discovery.readiness === "redirect") {
    return {
      phase: "redirect",
      discovery,
      meta: baseMeta({
        phase: "redirect",
        turn,
        extended,
        compact,
        appliedDefaults,
        proposalRevisions: params.proposalRevisions,
        message: "Esto encaja mejor como una consulta puntual en el chat.",
      }),
    };
  }

  if (
    discovery.readiness === "ready_for_confirmation" ||
    discovery.readiness === "blocked_reformulate"
  ) {
    const phase =
      discovery.readiness === "blocked_reformulate"
        ? "blocked"
        : "proposal";
    return {
      phase,
      discovery,
      meta: baseMeta({
        phase,
        turn,
        extended,
        compact,
        appliedDefaults,
        proposalRevisions: params.proposalRevisions,
        message:
          phase === "blocked"
            ? "Aún faltan datos materiales. Reformula la solicitud con lo ya aclarado."
            : "Confirma lo entendido antes de crear el borrador.",
      }),
    };
  }

  if (turn >= AUTHORING_HARD_LIMIT_TURN) {
    const forced = forceProposalFromDiscovery(discovery, plan);
    if (forced) {
      return {
        phase: "proposal",
        discovery: forced,
        meta: baseMeta({
          phase: "proposal",
          turn,
          extended,
          proposalRevisions: params.proposalRevisions,
          appliedDefaults,
          compact: buildAuthoringDiscoveryCompactState({
            discovery: forced,
            priorQuestions,
            answerTurnCount: turn,
            appliedDefaults,
            qaExchanges: params.qaExchanges,
            questionNumberRegistry: params.questionNumberRegistry,
          }),
          message:
            "Llegamos al límite de aclaraciones. Revisa el resumen y los supuestos antes de crear el borrador.",
        }),
      };
    }
    const blocked = buildBlockedDiscovery(discovery, plan);
    return {
      phase: "blocked",
      discovery: blocked,
      meta: baseMeta({
        phase: "blocked",
        turn,
        extended,
        proposalRevisions: params.proposalRevisions,
        appliedDefaults,
        compact: buildAuthoringDiscoveryCompactState({
          discovery: blocked,
          priorQuestions,
          answerTurnCount: turn,
          appliedDefaults,
          qaExchanges: params.qaExchanges,
          questionNumberRegistry: params.questionNumberRegistry,
        }),
        message:
          "Aún faltan datos materiales para proponer un borrador seguro. Reformula la solicitud con lo que ya aclaramos.",
      }),
    };
  }

  // El checkpoint suave solo interrumpe cuando existe una decisión real:
  // preparar la propuesta o seguir afinándola. Si quedan blockers con una
  // pregunta concreta, continuar preguntando evita una pausa sin salida útil.
  if (
    turn === AUTHORING_SOFT_CHECKPOINT_TURN &&
    !extended &&
    (plan.can_proceed || pending.length === 0)
  ) {
    const canProceed = isArtifactKind(discovery.final_kind) && plan.can_proceed;
    const blockerCount = plan.counts.blockers;
    return {
      phase: "checkpoint",
      discovery,
      meta: baseMeta({
        phase: "checkpoint",
        turn,
        extended,
        pending,
        allowContinue: pending.length > 0,
        allowProceed: canProceed,
        compact,
        appliedDefaults,
        proposalRevisions: params.proposalRevisions,
        message: canProceed
          ? "Ya tengo bastante contexto. ¿Seguimos aclarando o preparo la propuesta con lo entendido?"
          : blockerCount > 0
            ? `Queda ${blockerCount} decisión${
                blockerCount === 1 ? "" : "es"
              } necesaria${blockerCount === 1 ? "" : "s"}.`
            : "Necesito un poco más de contexto. Puedes seguir aclarando o reformular la solicitud.",
      }),
    };
  }

  return {
    phase: "discovering",
    discovery,
    meta: baseMeta({
      phase: "discovering",
      turn,
      extended,
      pending,
      compact,
      appliedDefaults,
      proposalRevisions: params.proposalRevisions,
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
  proposalRevisions?: readonly AuthoringProposalRevision[];
  appliedDefaults?: readonly AuthoringAppliedDefault[];
  defaultGapIds?: readonly string[];
  qaExchanges?: readonly AuthoringQaExchange[];
  questionNumberRegistry?: readonly AuthoringQuestionNumberRegistryEntry[];
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
  const defaultResult = applyAuthoringGapDefaults({
    plan: gapPlanFromDiscovery(params.discovery),
    gapIds: params.defaultGapIds ?? [],
  });
  const appliedDefaults = [
    ...(params.appliedDefaults ?? []),
    ...defaultResult.applied,
  ].filter(
    (entry, index, all) =>
      all.findIndex((candidate) => candidate.gap_id === entry.gap_id) === index
  );
  const discovery = discoveryWithGapPlan({
    discovery: params.discovery,
    plan: defaultResult.plan,
    questions: params.discovery.clarifying_questions,
  });
  const forced = forceProposalFromDiscovery(discovery, defaultResult.plan);
  const compact = buildAuthoringDiscoveryCompactState({
    discovery,
    priorQuestions: params.priorQuestions ?? [],
    answerTurnCount: params.answerTurnCount,
    appliedDefaults,
    qaExchanges: params.qaExchanges,
    questionNumberRegistry: params.questionNumberRegistry,
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
        pending: discovery.clarifying_questions,
        allowContinue: discovery.clarifying_questions.length > 0,
        compact,
        appliedDefaults,
        proposalRevisions: params.proposalRevisions,
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
      proposalRevisions: params.proposalRevisions,
      appliedDefaults,
      compact: buildAuthoringDiscoveryCompactState({
        discovery: forced,
        priorQuestions: params.priorQuestions ?? [],
        answerTurnCount: params.answerTurnCount,
        appliedDefaults,
        qaExchanges: params.qaExchanges,
        questionNumberRegistry: params.questionNumberRegistry,
      }),
      message: "Confirma lo entendido antes de crear el borrador.",
    }),
  };
}

export function appendAuthoringProposalRevision(params: {
  meta: AuthoringConversationMeta;
  correction: string;
  priorHash: string;
  proposalHash: string;
  revisedAt: string;
}): AuthoringConversationMeta {
  if (
    params.meta.proposal_revisions.length >= AUTHORING_MAX_PROPOSAL_REVISIONS
  ) {
    throw new Error("authoring_proposal_revision_limit_reached");
  }
  const proposalRevisions = [
    ...params.meta.proposal_revisions,
    authoringProposalRevisionSchema.parse({
      revision: params.meta.proposal_revisions.length + 1,
      correction: params.correction,
      prior_hash: params.priorHash,
      proposal_hash: params.proposalHash,
      revised_at: params.revisedAt,
    }),
  ];
  return authoringConversationMetaSchema.parse({
    ...params.meta,
    conversation_phase: "proposal",
    pending_questions: [],
    allow_continue: false,
    allow_proceed_to_proposal: false,
    proposal_revision_count: proposalRevisions.length,
    proposal_revisions: proposalRevisions,
  });
}
