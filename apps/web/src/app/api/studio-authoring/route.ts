/**
 * POST /api/studio-authoring — sesión de autoría del Studio (Slice 5.3).
 *
 * Stream NDJSON de etapas: session_ready → routing → routed →
 * clarifying | compiling/materializing → catalogs_loaded → draft_saved /
 * artifact_ready → redirect | done | error.
 */

import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import {
  appendStudioAuthoringSessionMessage,
  appendStudioAuthoringSessionProgress,
  claimStudioAuthoringSessionForMaterialization,
  createServerClient,
  createStudioAuthoringSession,
  getAccountSkill,
  getStudioAuthoringSession,
  listAccountSkillsForUser,
  type DbClient,
  updateStudioAuthoringSession,
} from "@agents/db";
import {
  runWithAiUsageContext,
  TOOL_CATALOG,
} from "@agents/agent";
import {
  AUTHORING_HARD_LIMIT_TURN,
  AUTHORING_MAX_PROPOSAL_REVISIONS,
  appendAuthoringProposalRevision,
  appendAuthoringQaExchange,
  buildAuthoringGapRoundIntro,
  classifyAuthoringGapRound,
  authoringConversationMetaSchema,
  authoringDiscoveryCompactStateSchema,
  authoringDiscoveryOutputSchema,
  buildAuthoringDiscoveryCompactState,
  authoringGapPlanSchema,
  canonicalizeJson,
  isArtifactKind,
  isGenericAuthoringSlug,
  proceedAuthoringDiscoveryToProposal,
  inferSolutionPatternTriggers,
  resolveSolutionPatternComposition,
  resolveAuthoringConversationTurn,
  suggestEnglishSlug,
  type AuthoringConversationMeta,
  type AuthoringDiscoveryCompactState,
  type AuthoringDiscoveryOutput,
  type SolutionPatternComposition,
} from "@agents/workflows";
import { createClient } from "@/lib/supabase/server";
import {
  routeAuthoringDescription,
  type RouteAuthoringResult,
} from "@/lib/workflow-studio/authoring-router";
import {
  runAuthoringDiscovery,
  type RunAuthoringDiscoveryResult,
} from "@/lib/workflow-studio/authoring-discovery";
import {
  materializeAuthoringArtifact,
  normalizeReusableSkillSlug,
} from "@/lib/workflow-studio/materialize-artifact";
import { buildCapabilityCatalogsForUser } from "@/lib/workflow-studio/definition-validation";
import { loadTenantProviderSnapshot } from "@/lib/tool-readiness/load-tenant-provider-snapshot";
import { buildAuthoringCapabilityContext } from "@/lib/workflow-studio/capability-provider-catalog";
import {
  authoringClarificationRoundIncrement,
  applyAuthoringRoundIntro,
  authoringFailureOutcome,
  isRetryableAuthoringDiscoveryFailure,
  readStoredAuthoringRouterResult,
  reusableSkillConflictFromExisting,
  RETRYABLE_DISCOVERY_COPY,
  selectAuthoringRetryCompactState,
  shouldAppendAuthoringInputMessage,
} from "@/lib/workflow-studio/authoring-thread";
import {
  auditAndFinalizeAuthoringProposal,
  type ProposalCoherenceAuditMeta,
} from "@/lib/workflow-studio/proposal-coherence-audit";

/** Límite duro de turnos de respuesta (política conversacional 3+2). */
const MAX_CLARIFICATION_ROUNDS = AUTHORING_HARD_LIMIT_TURN;

type StudioAuthoringAction =
  | "discover"
  | "answer"
  | "confirm"
  | "revise_proposal"
  | "continue_discovery"
  | "proceed_to_proposal"
  | "retry_discovery";

function readConversationMeta(
  routerOutput: Record<string, unknown> | null | undefined
): AuthoringConversationMeta | null {
  const parsed = authoringConversationMetaSchema.safeParse(
    routerOutput?.conversation
  );
  return parsed.success ? parsed.data : null;
}

function readCompactState(
  routerOutput: Record<string, unknown> | null | undefined
): AuthoringDiscoveryCompactState | null {
  const directPlan = authoringGapPlanSchema.safeParse(routerOutput?.gap_plan);
  const fromConversation = authoringDiscoveryCompactStateSchema.safeParse(
    (routerOutput?.conversation as { compact_state?: unknown } | undefined)
      ?.compact_state
  );
  if (fromConversation.success) {
    return directPlan.success && !fromConversation.data.gap_plan
      ? authoringDiscoveryCompactStateSchema.parse({
          ...fromConversation.data,
          gap_plan: directPlan.data,
        })
      : fromConversation.data;
  }
  const direct = authoringDiscoveryCompactStateSchema.safeParse(
    routerOutput?.compact_state
  );
  if (!direct.success) return null;
  return directPlan.success && !direct.data.gap_plan
    ? authoringDiscoveryCompactStateSchema.parse({
        ...direct.data,
        gap_plan: directPlan.data,
      })
    : direct.data;
}

function readLastValidCompactState(
  routerOutput: Record<string, unknown> | null | undefined
): AuthoringDiscoveryCompactState | null {
  const parsed = authoringDiscoveryCompactStateSchema.safeParse(
    routerOutput?.last_valid_compact_state
  );
  return parsed.success ? parsed.data : null;
}

function patternCompositionForDiscovery(
  discovery: AuthoringDiscoveryOutput
): SolutionPatternComposition | null {
  if (!isArtifactKind(discovery.final_kind)) return null;
  const triggers = inferSolutionPatternTriggers({
    requestedSideEffects: discovery.requested_side_effects,
    capabilityCategoryIds: discovery.capability_needs.map(
      (need) => need.category_id
    ),
    capabilityProviderIds: discovery.capability_needs.flatMap((need) =>
      need.provider_id ? [need.provider_id] : []
    ),
    inputRequirementKinds: discovery.input_requirements.map(
      (requirement) => requirement.kind
    ),
    inputSourceHints: discovery.input_requirements.flatMap((requirement) =>
      requirement.source_hint ? [requirement.source_hint] : []
    ),
  });
  return resolveSolutionPatternComposition({
    workForm: discovery.final_kind,
    triggers,
  });
}

type StudioAuthoringEvent =
  | {
      type: "stage";
      stage: string;
      message: string;
      ts: number;
      payload?: Record<string, unknown>;
    }
  | {
      type: "error";
      error: string;
      details?: string;
      code?: string;
      retriable?: boolean;
      ts: number;
    };

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

async function reusableSkillConflictPayload(params: {
  db: DbClient;
  userId: string;
  sessionId: string;
  discovery: AuthoringDiscoveryOutput;
  requestedSlug?: string | null;
}): Promise<Record<string, unknown> | null> {
  if (params.discovery.final_kind !== "reusable_skill") return null;
  const slug = normalizeReusableSkillSlug(
    params.requestedSlug || params.discovery.suggested_slug || ""
  );
  if (!slug) return null;
  const existing = await getAccountSkill(params.db, params.userId, slug);
  const existingSessionId =
    typeof existing?.metadata_jsonb?.studio_authoring_session_id === "string"
      ? existing.metadata_jsonb.studio_authoring_session_id
      : null;
  return reusableSkillConflictFromExisting({
    finalKind: params.discovery.final_kind,
    normalizedSlug: slug,
    currentSessionId: params.sessionId,
    existing: existing
      ? {
          studioAuthoringSessionId: existingSessionId,
          status: existing.status,
          version: existing.version,
          updatedAt: existing.updated_at,
        }
      : null,
  });
}

function ndjsonResponse(
  stream: ReadableStream<Uint8Array>,
  init?: ResponseInit
): Response {
  return new Response(stream, {
    ...init,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      ...(init?.headers ?? {}),
    },
  });
}

function collectAnswers(body: {
  clarificationAnswer?: unknown;
  answers?: unknown;
}): string[] {
  const fromArray = Array.isArray(body.answers)
    ? body.answers
        .map((item) => cleanText(item))
        .filter((item) => item.length > 0)
    : [];
  const single = cleanText(body.clarificationAnswer);
  return single ? [...fromArray, single] : fromArray;
}

type StoredAuthoringQuestionBatch = {
  batchId: string;
  gapIds: string[];
  questions: string[];
  questionDetails: Record<string, unknown>[];
};

function readLatestStoredQuestionBatch(
  messages: readonly unknown[]
): StoredAuthoringQuestionBatch | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const raw = messages[index];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const message = raw as Record<string, unknown>;
    if (
      message.role !== "discovery_question" &&
      message.role !== "discovery_checkpoint"
    ) {
      continue;
    }
    const questions = Array.isArray(message.questions)
      ? message.questions.filter(
          (question): question is string =>
            typeof question === "string" && question.trim().length > 0
        )
      : [];
    const questionDetails = Array.isArray(message.question_details)
      ? message.question_details.filter(
          (detail): detail is Record<string, unknown> =>
            Boolean(detail) &&
            typeof detail === "object" &&
            !Array.isArray(detail)
        )
      : [];
    const gapIds = [
      ...new Set(
        questionDetails.flatMap((detail) =>
          typeof detail.gap_id === "string" &&
          /^gap_[a-z0-9]{8}$/.test(detail.gap_id)
            ? [detail.gap_id]
            : []
        )
      ),
    ];
    if (questions.length === 0 && gapIds.length === 0) continue;
    return {
      batchId:
        typeof message.batch_id === "string" && message.batch_id.trim()
          ? message.batch_id
          : `legacy-batch-${index}`,
      gapIds,
      questions,
      questionDetails,
    };
  }
  return null;
}

function discoveryHash(discovery: AuthoringDiscoveryOutput): string {
  return `sha256:${createHash("sha256")
    .update(
      canonicalizeJson({
        discovery,
        gap_plan: discovery.gap_plan ?? null,
      }),
      "utf8"
    )
    .digest("hex")}`;
}

function gapPresentation(discovery: AuthoringDiscoveryOutput) {
  const gaps = discovery.gap_plan?.gaps ?? [];
  return {
    pending_blockers: gaps.filter(
      (gap) =>
        gap.severity === "blocking" &&
        gap.state !== "answered" &&
        gap.state !== "resolved_by_evidence" &&
        gap.state !== "defaulted"
    ),
    safe_defaults: gaps.flatMap((gap) =>
      gap.severity === "defaultable" &&
      gap.safe_default &&
      gap.state !== "answered" &&
      gap.state !== "resolved_by_evidence" &&
      gap.state !== "defaulted" &&
      gap.state !== "blocked_dependency"
        ? [
            {
              gap_id: gap.id,
              summary: gap.summary,
              value: gap.safe_default,
            },
          ]
        : []
    ),
  };
}

function pendingDecisionCopy(count: number): string {
  return `Queda ${count} decisión${count === 1 ? "" : "es"} necesaria${
    count === 1 ? "" : "s"
  }.`;
}

function discoveryResultMetadata(result: RunAuthoringDiscoveryResult) {
  return {
    quality_warnings: result.qualityWarnings,
    discovery_failure_class: result.failureClass,
    discovery_diagnostics: result.diagnostics,
  };
}

function discoveryStreamMetadata(result: RunAuthoringDiscoveryResult) {
  return {
    failureClass: result.failureClass,
    qualityWarnings: result.qualityWarnings,
    diagnostics: result.diagnostics,
  };
}

function emitFailClosedEvent(
  sessionId: string,
  result: RunAuthoringDiscoveryResult
): void {
  if (result.kind !== "fail_closed") return;
  console.error("[studio.authoring.fail_closed]", {
    session_id: sessionId,
    model_id: result.modelId,
    failure_class: result.failureClass,
    call_count: result.diagnostics.callCount,
    stages: result.diagnostics.stages.map(({ stage, code }) => ({
      stage,
      code,
    })),
  });
}

function authoringAiTurnId(params: {
  action: StudioAuthoringAction;
  clarificationRound: number;
  operation:
    | "router"
    | "discovery"
    | "revision"
    | "proposal_audit"
    | "materialize";
  requestId: string;
}): string {
  return `studio-authoring:${params.action}:round-${params.clarificationRound}:${params.operation}:${params.requestId}`;
}

function conversationWithAuditedDiscovery(
  meta: AuthoringConversationMeta,
  discovery: AuthoringDiscoveryOutput
): AuthoringConversationMeta {
  const compact = meta.compact_state;
  return {
    ...meta,
    compact_state: buildAuthoringDiscoveryCompactState({
      discovery,
      priorQuestions: compact?.prior_questions ?? [],
      answerTurnCount: meta.answer_turn_count,
      appliedDefaults: meta.applied_defaults,
      qaExchanges: compact?.qa_exchanges ?? [],
      questionNumberRegistry: compact?.question_number_registry ?? [],
    }),
  };
}

async function auditProposalBoundary(params: {
  db: DbClient;
  userId: string;
  sessionId: string;
  action: StudioAuthoringAction;
  clarificationRound: number;
  requestId: string;
  description: string;
  answers: readonly string[];
  discovery: AuthoringDiscoveryOutput;
  signal?: AbortSignal;
}): Promise<{
  discovery: AuthoringDiscoveryOutput;
  audit: ProposalCoherenceAuditMeta;
}> {
  return runWithAiUsageContext(
    {
      userId: params.userId,
      channel: "web",
      sessionId: params.sessionId,
      turnId: authoringAiTurnId({
        action: params.action,
        clarificationRound: params.clarificationRound,
        operation: "proposal_audit",
        requestId: params.requestId,
      }),
    },
    params.db,
    () =>
      auditAndFinalizeAuthoringProposal({
        discovery: params.discovery,
        description: params.description,
        answers: params.answers,
        signal: params.signal,
      })
  );
}

function proposalAuditProgress(meta: ProposalCoherenceAuditMeta): {
  message: string;
  payload: Record<string, unknown>;
} {
  const unavailable = meta.quality_warnings.some(
    (warning) =>
      warning.code === "proposal_audit_unavailable" ||
      warning.code === "proposal_audit_invalid_response"
  );
  return {
    message: unavailable
      ? "La revisión semántica adicional no estuvo disponible; se conservó la propuesta validada estructuralmente."
      : meta.applied
        ? "Revisión semántica aplicada a la propuesta."
        : "Revisión semántica de la propuesta lista.",
    payload: { proposalAudit: meta },
  };
}

function mergeProposalQualityWarnings(
  existing: unknown,
  audit: ProposalCoherenceAuditMeta | null
): unknown[] {
  return [
    ...(Array.isArray(existing) ? existing : []),
    ...(audit?.quality_warnings ?? []),
  ];
}

export async function GET(request: Request) {
  const auth = await createClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "No autenticado" }, { status: 401 });
  }
  const sessionId = new URL(request.url).searchParams.get("sessionId")?.trim();
  if (!sessionId) {
    return NextResponse.json({ error: "Falta sessionId" }, { status: 400 });
  }
  const db = createServerClient();
  const session = await getStudioAuthoringSession(db, user.id, sessionId);
  if (!session) {
    return NextResponse.json({ error: "Sesión no encontrada" }, { status: 404 });
  }
  const storedDiscovery = authoringDiscoveryOutputSchema.safeParse(
    session.router_output_jsonb?.discovery
  );
  const slugConflict = storedDiscovery.success
    ? await reusableSkillConflictPayload({
        db,
        userId: user.id,
        sessionId: session.id,
        discovery: storedDiscovery.data,
        requestedSlug: session.suggested_slug,
      })
    : null;
  return NextResponse.json({
    id: session.id,
    status: session.status,
    description: session.description_nl,
    title: session.title,
    suggestedSlug: session.suggested_slug,
    routerKind: session.router_kind,
    routerOutput: session.router_output_jsonb,
    clarificationRound: session.clarification_round,
    messages: session.messages_jsonb,
    progress: session.progress_jsonb,
    artifactKind: session.artifact_kind,
    artifactRef: session.artifact_ref,
    resultPath:
      typeof session.provenance_jsonb?.result_path === "string"
        ? session.provenance_jsonb.result_path
        : null,
    updatedAt: session.updated_at,
    slugConflict,
  });
}

export async function POST(request: Request) {
  const auth = await createClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "No autenticado" }, { status: 401 });
  }

  let body: {
    description?: unknown;
    title?: unknown;
    slug?: unknown;
    sessionId?: unknown;
    action?: unknown;
    confirmationHash?: unknown;
    proposalCorrection?: unknown;
    clarificationAnswer?: unknown;
    answers?: unknown;
    defaultGapIds?: unknown;
    overwriteExisting?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const description = cleanText(body.description);
  const title = cleanText(body.title) || null;
  const slugRaw = cleanText(body.slug) || null;
  const sessionIdIn = cleanText(body.sessionId) || null;
  const actionRaw = cleanText(body.action);
  const action: StudioAuthoringAction =
    actionRaw === "confirm" ||
    actionRaw === "revise_proposal" ||
    actionRaw === "answer" ||
    actionRaw === "continue_discovery" ||
    actionRaw === "proceed_to_proposal" ||
    actionRaw === "retry_discovery"
      ? actionRaw
      : "discover";
  const confirmationHash = cleanText(body.confirmationHash) || null;
  const overwriteExisting = body.overwriteExisting === true;
  const proposalCorrection = cleanText(body.proposalCorrection);
  const newAnswers = shouldAppendAuthoringInputMessage(action)
    ? collectAnswers(body)
    : [];
  const requestedDefaultGapIds = Array.isArray(body.defaultGapIds)
    ? [
        ...new Set(
          body.defaultGapIds.filter(
            (gapId): gapId is string =>
              typeof gapId === "string" && /^gap_[a-z0-9]{8}$/.test(gapId)
          )
        ),
      ].slice(0, 32)
    : [];

  if (!description && !sessionIdIn) {
    return NextResponse.json(
      { error: "Describe qué quieres construir." },
      { status: 400 }
    );
  }

  const db = createServerClient();
  const encoder = new TextEncoder();
  const authoringRequestId = randomUUID();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: StudioAuthoringEvent) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      const stage = (
        stageId: string,
        message: string,
        payload?: Record<string, unknown>
      ) => {
        send({
          type: "stage",
          stage: stageId,
          message,
          ts: Date.now(),
          ...(payload ? { payload } : {}),
        });
      };

      const persistProgress = async (
        sessionId: string,
        entry: Record<string, unknown>
      ) => {
        try {
          await appendStudioAuthoringSessionProgress(db, {
            userId: user.id,
            sessionId,
            entry: { ...entry, ts: new Date().toISOString() },
          });
        } catch (error) {
          console.warn("[studio-authoring] progress persist failed:", error);
        }
      };
      let claimedSessionId: string | null = null;

      try {
        let session = sessionIdIn
          ? await getStudioAuthoringSession(db, user.id, sessionIdIn)
          : null;

        if (action === "retry_discovery" && !session) {
          send({
            type: "error",
            error: "No hay una sesión vigente para reintentar el análisis.",
            ts: Date.now(),
          });
          controller.close();
          return;
        }

        const descriptionNl =
          action === "retry_discovery"
            ? session?.description_nl?.trim() || ""
            : description || session?.description_nl?.trim() || "";
        if (!descriptionNl) {
          send({
            type: "error",
            error: "Describe qué quieres construir.",
            ts: Date.now(),
          });
          controller.close();
          return;
        }

        const resolvedTitle =
          title || session?.title || null;
        const slugCandidate =
          slugRaw ||
          session?.suggested_slug ||
          (resolvedTitle
            ? suggestEnglishSlug(resolvedTitle)
            : suggestEnglishSlug(descriptionNl));
        const resolvedSlug = isGenericAuthoringSlug(slugCandidate)
          ? suggestEnglishSlug(resolvedTitle || descriptionNl)
          : slugCandidate;

        if (!session) {
          session = await createStudioAuthoringSession(db, {
            userId: user.id,
            descriptionNl,
            title: resolvedTitle,
            suggestedSlug: resolvedSlug,
            status: "active",
            provenance: { source: "studio_design" },
          });
        } else {
          await updateStudioAuthoringSession(db, {
            userId: user.id,
            sessionId: session.id,
            title: resolvedTitle,
            suggestedSlug: resolvedSlug,
            descriptionNl,
          });
          session = (await getStudioAuthoringSession(
            db,
            user.id,
            session.id
          ))!;
        }

        stage("session_ready", "Sesión de autoría lista.", {
          sessionId: session.id,
          suggested_slug: resolvedSlug,
          title: resolvedTitle,
        });
        await persistProgress(session.id, {
          stage: "session_ready",
          sessionId: session.id,
        });

        // Idempotencia: una sesión compilada siempre devuelve el mismo artefacto.
        if (session.status === "compiled" && Object.keys(session.artifact_ref ?? {}).length > 0) {
          const path =
            typeof session.provenance_jsonb?.result_path === "string"
              ? session.provenance_jsonb.result_path
              : null;
          stage("artifact_ready", "El borrador de esta sesión ya existe.", {
            kind: session.artifact_kind,
            artifactRef: session.artifact_ref,
          });
          stage("done", "Autoría completada.", {
            sessionId: session.id,
            kind: session.artifact_kind,
            artifactRef: session.artifact_ref,
            path,
            idempotentReplay: true,
          });
          controller.close();
          return;
        }

        // Acumular respuestas/preguntas de aclaración en mensajes de la sesión.
        const latestQuestionBatch = readLatestStoredQuestionBatch(
          session.messages_jsonb ?? []
        );
        const priorAnswers = (session.messages_jsonb ?? [])
          .filter(
            (msg): msg is Record<string, unknown> =>
              !!msg &&
              typeof msg === "object" &&
              ((msg as Record<string, unknown>).role === "user_answer" ||
                (msg as Record<string, unknown>).role ===
                  "proposal_correction")
          )
          .map((msg) => cleanText(msg.content))
          .filter(Boolean);
        const priorQuestions = (session.messages_jsonb ?? []).flatMap((msg) => {
          if (!msg || typeof msg !== "object") return [];
          const record = msg as Record<string, unknown>;
          if (
            record.role !== "discovery_question" &&
            record.role !== "discovery_checkpoint" &&
            record.role !== "compiler_clarify"
          ) {
            return [];
          }
          return Array.isArray(record.questions)
            ? record.questions.filter(
                (question): question is string =>
                  typeof question === "string" && question.trim().length > 0
              )
            : [];
        });
        const clarificationAnswers = [...priorAnswers, ...newAnswers];

        for (const answer of newAnswers) {
          await appendStudioAuthoringSessionMessage(db, {
            userId: user.id,
            sessionId: session.id,
            message: {
              role: "user_answer",
              content: answer,
              question_batch_id: latestQuestionBatch?.batchId ?? null,
              responding_to_gap_ids: latestQuestionBatch?.gapIds ?? [],
              responding_to_questions: latestQuestionBatch?.questions ?? [],
              at: new Date().toISOString(),
            },
          });
        }

        const clarificationRound =
          (session.clarification_round ?? 0) +
          authoringClarificationRoundIncrement({
            action,
            answerCount: newAnswers.length,
          });
        const priorConversation = readConversationMeta(
          session.router_output_jsonb as Record<string, unknown> | null
        );
        const priorCompact = readCompactState(
          session.router_output_jsonb as Record<string, unknown> | null
        );
        const lastValidCompact = readLastValidCompactState(
          session.router_output_jsonb as Record<string, unknown> | null
        );
        const retryCompact = selectAuthoringRetryCompactState({
          lastValidCompact,
          currentCompact: priorCompact,
          failureClass:
            session.router_output_jsonb?.discovery_failure_class,
        });
        let extendedAfterCheckpoint = Boolean(
          priorConversation?.extended_after_checkpoint
        );

        if (
          clarificationRound > MAX_CLARIFICATION_ROUNDS &&
          action === "answer"
        ) {
          stage(
            "error",
            "Se alcanzó el límite de aclaraciones. Reformula la descripción e inténtalo de nuevo."
          );
          send({
            type: "error",
            error:
              "Se alcanzó el límite de aclaraciones. Reformula la descripción incorporando las respuestas y vuelve a intentar.",
            ts: Date.now(),
          });
          await updateStudioAuthoringSession(db, {
            userId: user.id,
            sessionId: session.id,
            status: "abandoned",
            clarificationRound,
          });
          controller.close();
          return;
        }

        let routed: RouteAuthoringResult;
        let catalogs: Awaited<
          ReturnType<typeof buildCapabilityCatalogsForUser>
        > | null = null;

        if (action === "revise_proposal") {
          if (!proposalCorrection) {
            send({
              type: "error",
              error: "Escribe el ajuste que quieres aplicar a la propuesta.",
              ts: Date.now(),
            });
            controller.close();
            return;
          }
          const stored = authoringDiscoveryOutputSchema.safeParse(
            session.router_output_jsonb?.discovery
          );
          if (
            !stored.success ||
            stored.data.readiness !== "ready_for_confirmation"
          ) {
            send({
              type: "error",
              error: "La sesión no tiene una propuesta vigente para corregir.",
              ts: Date.now(),
            });
            controller.close();
            return;
          }
          const expectedHash = discoveryHash(stored.data);
          if (!confirmationHash || confirmationHash !== expectedHash) {
            send({
              type: "error",
              error:
                "La propuesta cambió o está desactualizada. Revisa la versión vigente antes de enviar el ajuste.",
              ts: Date.now(),
            });
            controller.close();
            return;
          }
          if (
            (priorConversation?.proposal_revision_count ?? 0) >=
            AUTHORING_MAX_PROPOSAL_REVISIONS
          ) {
            send({
              type: "error",
              error:
                "Se alcanzó el límite de ajustes de esta propuesta. Conservamos la sesión; reformula la solicitud para continuar.",
              ts: Date.now(),
            });
            controller.close();
            return;
          }

          stage("revising_proposal", "Aplicando tu ajuste a la propuesta…");
          await persistProgress(session.id, { stage: "revising_proposal" });
          const [loadedCatalogs, providerSnapshot, accountSkills] =
            await Promise.all([
              buildCapabilityCatalogsForUser(db, user.id),
              loadTenantProviderSnapshot(db, user.id),
              listAccountSkillsForUser(db, user.id),
            ]);
          catalogs = loadedCatalogs;
          const authoringSkillSlugs = [
            ...new Set([
              ...catalogs.skillSlugs,
              ...accountSkills.map((skill) => skill.slug),
            ]),
          ];
          const revisionAnswers = [
            ...clarificationAnswers,
            proposalCorrection,
          ];
          const capabilityContext = buildAuthoringCapabilityContext({
            snapshot: providerSnapshot,
            authoringSessionId: session.id,
          });
          const revisionRouterSignal: RouteAuthoringResult = {
            kind: stored.data.final_kind,
            skill_subtype: stored.data.skill_subtype,
            confidence: stored.data.confidence,
            reasons: stored.data.rationale,
            clarifying_questions: [],
            suggested_title: stored.data.suggested_title,
            suggested_slug: stored.data.suggested_slug,
            requested_side_effects: stored.data.requested_side_effects,
            modelId: session.model_id,
            source: "model",
          };
          const discoveryResult = await runWithAiUsageContext(
            {
              userId: user.id,
              channel: "web",
              sessionId: session.id,
              turnId: authoringAiTurnId({
                action,
                clarificationRound,
                operation: "revision",
                requestId: authoringRequestId,
              }),
            },
            db,
            () =>
              runAuthoringDiscovery({
                description: descriptionNl,
                answers: revisionAnswers,
                latestAnswer: proposalCorrection,
                priorQuestions,
                compactState: priorCompact,
                routerSignal: revisionRouterSignal,
                catalogs: {
                  skills: authoringSkillSlugs,
                  tools: [...catalogs!.toolIds],
                  integrations: [...catalogs!.connectedIntegrations],
                  assets: [...catalogs!.tenantConfiguredAssetKeys],
                  workerCapabilities: [...catalogs!.workerCapabilities],
                },
                capabilityContext,
                revisionMode: true,
                signal: request.signal,
              })
          );
          emitFailClosedEvent(session.id, discoveryResult);
          if (discoveryResult.kind === "fail_closed") {
            const failedTurn = resolveAuthoringConversationTurn({
              discovery: discoveryResult.discovery,
              answerTurnCount: session.clarification_round ?? 0,
              priorQuestions: [
                ...priorQuestions,
                ...discoveryResult.discovery.clarifying_questions,
              ],
              extendedAfterCheckpoint,
              proposalRevisions:
                priorConversation?.proposal_revisions ?? [],
              qaExchanges: priorCompact?.qa_exchanges ?? [],
              questionNumberRegistry:
                priorCompact?.question_number_registry ?? [],
            });
            const failedHash = discoveryHash(failedTurn.discovery);
            const failureOutcome = authoringFailureOutcome(
              discoveryResult.failureClass
            );
            await updateStudioAuthoringSession(db, {
              userId: user.id,
              sessionId: session.id,
              routerKind: failedTurn.discovery.final_kind,
              routerOutput: {
                ...(session.router_output_jsonb ?? {}),
                discovery: failedTurn.discovery,
                gap_plan: failedTurn.discovery.gap_plan,
                discovery_hash: failedHash,
                discovery_result: discoveryResult.kind,
                evidence_failures: discoveryResult.evidenceFailures,
                ...discoveryResultMetadata(discoveryResult),
                capability_context: capabilityContext,
                conversation: failedTurn.meta,
                compact_state: failedTurn.meta.compact_state,
                last_valid_compact_state: lastValidCompact ?? priorCompact,
              },
              modelId: discoveryResult.modelId,
              status: "clarifying",
            });
            if (failureOutcome.retryable) {
              stage("discovery_retryable", RETRYABLE_DISCOVERY_COPY, {
                sessionId: session.id,
                conversationPhase: "blocked",
                ...discoveryStreamMetadata(discoveryResult),
              });
            } else {
              const blockerCount =
                failedTurn.discovery.gap_plan?.counts.blockers ?? 0;
              stage(
                "blocked",
                blockerCount > 0
                  ? pendingDecisionCopy(blockerCount)
                  : failedTurn.meta.human_message ??
                      "Aún faltan datos materiales. Reformula la solicitud.",
                {
                  sessionId: session.id,
                  discovery: failedTurn.discovery,
                  conversation: failedTurn.meta,
                  conversationPhase: "blocked",
                  ...gapPresentation(failedTurn.discovery),
                  ...discoveryStreamMetadata(discoveryResult),
                }
              );
            }
            stage(
              "done",
              failureOutcome.humanCopy ??
                "Discovery bloqueado; reformula la solicitud.",
              {
                sessionId: session.id,
                awaiting: failureOutcome.awaiting,
                ...discoveryStreamMetadata(discoveryResult),
              }
            );
            controller.close();
            return;
          }
          const proceeded = proceedAuthoringDiscoveryToProposal({
            discovery: discoveryResult.discovery,
            answerTurnCount: session.clarification_round ?? 0,
            priorQuestions,
            extendedAfterCheckpoint,
            proposalRevisions:
              priorConversation?.proposal_revisions ?? [],
            qaExchanges: priorCompact?.qa_exchanges ?? [],
            questionNumberRegistry:
              priorCompact?.question_number_registry ?? [],
          });
          if (!proceeded.ok) {
            send({
              type: "error",
              error:
                "No pude convertir ese ajuste en una propuesta segura. La propuesta anterior sigue vigente; reformula el ajuste.",
              ts: Date.now(),
            });
            controller.close();
            return;
          }
          const proposalAudit = await auditProposalBoundary({
            db,
            userId: user.id,
            sessionId: session.id,
            action,
            clarificationRound,
            requestId: authoringRequestId,
            description: descriptionNl,
            answers: revisionAnswers,
            discovery: proceeded.discovery,
            signal: request.signal,
          });
          const auditProgress = proposalAuditProgress(proposalAudit.audit);
          stage("proposal_audit", auditProgress.message, auditProgress.payload);
          const auditedDiscovery = proposalAudit.discovery;
          const auditedMeta = conversationWithAuditedDiscovery(
            proceeded.meta,
            auditedDiscovery
          );
          const hash = discoveryHash(auditedDiscovery);
          if (hash === expectedHash) {
            send({
              type: "error",
              error:
                "El ajuste no produjo un cambio verificable. Exprésalo de forma más concreta; la propuesta anterior sigue vigente.",
              ts: Date.now(),
            });
            controller.close();
            return;
          }

          const current = await getStudioAuthoringSession(
            db,
            user.id,
            session.id
          );
          const currentStored = authoringDiscoveryOutputSchema.safeParse(
            current?.router_output_jsonb?.discovery
          );
          const currentConversation = readConversationMeta(
            current?.router_output_jsonb as Record<string, unknown> | null
          );
          if (
            !current ||
            current.status !== "active" ||
            !currentStored.success ||
            discoveryHash(currentStored.data) !== expectedHash ||
            (currentConversation?.proposal_revision_count ?? 0) >=
              AUTHORING_MAX_PROPOSAL_REVISIONS
          ) {
            send({
              type: "error",
              error:
                "La propuesta cambió mientras aplicábamos el ajuste. Recarga la versión vigente antes de continuar.",
              ts: Date.now(),
            });
            controller.close();
            return;
          }
          const revisedAt = new Date().toISOString();
          const conversation = appendAuthoringProposalRevision({
            meta: {
              ...auditedMeta,
              proposal_revision_count:
                currentConversation?.proposal_revision_count ?? 0,
              proposal_revisions:
                currentConversation?.proposal_revisions ?? [],
            },
            correction: proposalCorrection,
            priorHash: expectedHash,
            proposalHash: hash,
            revisedAt,
          });
          const patternComposition = patternCompositionForDiscovery(
            auditedDiscovery
          );
          const updated = await updateStudioAuthoringSession(db, {
            userId: user.id,
            sessionId: current.id,
            expectedUpdatedAt: current.updated_at,
            routerKind: auditedDiscovery.final_kind,
            routerOutput: {
              ...(current.router_output_jsonb ?? {}),
              discovery: auditedDiscovery,
              gap_plan: auditedDiscovery.gap_plan,
              discovery_hash: hash,
              discovery_result: discoveryResult.kind,
              evidence_failures: discoveryResult.evidenceFailures,
              ...discoveryResultMetadata(discoveryResult),
              quality_warnings: mergeProposalQualityWarnings(
                discoveryResult.qualityWarnings,
                proposalAudit.audit
              ),
              capability_context: capabilityContext,
              pattern_composition: patternComposition,
              proposal_audit: proposalAudit.audit,
              conversation,
              compact_state: conversation.compact_state,
              last_valid_compact_state: conversation.compact_state,
            },
            messages: [
              ...(current.messages_jsonb ?? []),
              {
                role: "proposal_correction",
                content: proposalCorrection,
                prior_discovery_hash: expectedHash,
                at: revisedAt,
              },
              {
                role: "understanding_summary",
                discovery_hash: hash,
                content: auditedDiscovery.understanding,
                gap_plan: auditedDiscovery.gap_plan,
                ...gapPresentation(auditedDiscovery),
                capability_needs: auditedDiscovery.capability_needs,
                input_requirements: auditedDiscovery.input_requirements,
                invocation_channels: auditedDiscovery.invocation_channels,
                at: revisedAt,
              },
            ],
            modelId: discoveryResult.modelId,
            suggestedSlug:
              auditedDiscovery.suggested_slug ?? current.suggested_slug,
            title:
              current.title ?? auditedDiscovery.suggested_title ?? null,
            status: "active",
            provenance: {
              ...(current.provenance_jsonb ?? {}),
              discovery_hash: hash,
              prior_discovery_hash: expectedHash,
              discovery_model_id: discoveryResult.modelId,
              discovery_updated_at: revisedAt,
              proposal_revised_at: revisedAt,
              proposal_audit_model_id: proposalAudit.audit.model_id,
              proposal_audit_coherent: proposalAudit.audit.coherent,
              proposal_audit_at: revisedAt,
            },
          });
          if (!updated) {
            send({
              type: "error",
              error:
                "La propuesta cambió mientras guardábamos el ajuste. Recarga la versión vigente antes de continuar.",
              ts: Date.now(),
            });
            controller.close();
            return;
          }
          const slugConflict = await reusableSkillConflictPayload({
            db,
            userId: user.id,
            sessionId: updated.id,
            discovery: auditedDiscovery,
            requestedSlug: slugRaw,
          });
          stage("review_ready", "Propuesta actualizada. Revisa los cambios.", {
            sessionId: updated.id,
            discovery: auditedDiscovery,
            confirmationHash: hash,
            conversationPhase: "proposal",
            conversation,
            patternComposition,
            proposalAudit: proposalAudit.audit,
            slugConflict,
            ...discoveryStreamMetadata(discoveryResult),
          });
          stage("done", "Esperando confirmación humana.", {
            sessionId: updated.id,
            awaiting: "confirmation",
          });
          controller.close();
          return;
        }

        if (action === "continue_discovery") {
          const pending =
            priorConversation?.pending_questions?.filter(
              (question) => question.trim().length > 0
            ) ?? [];
          if (pending.length === 0) {
            send({
              type: "error",
              error:
                "No hay preguntas pendientes para continuar. Reformula o reinicia la solicitud.",
              ts: Date.now(),
            });
            controller.close();
            return;
          }
          extendedAfterCheckpoint = true;
          const storedDiscovery = authoringDiscoveryOutputSchema.safeParse(
            session.router_output_jsonb?.discovery
          );
          const questionBatchId = randomUUID();
          const continueCopy =
            "Continuemos. Responde con lo que sepas; puedes cubrir varias preguntas en un solo mensaje.";
          const continuedQuestionDetails = storedDiscovery.success
            ? storedDiscovery.data.clarifying_question_details.filter((detail) =>
                pending.includes(detail.question)
              )
            : [];
          await updateStudioAuthoringSession(db, {
            userId: user.id,
            sessionId: session.id,
            status: "clarifying",
            clarificationRound: session.clarification_round ?? 0,
            routerOutput: {
              ...(session.router_output_jsonb ?? {}),
              gap_plan: storedDiscovery.success
                ? storedDiscovery.data.gap_plan
                : session.router_output_jsonb?.gap_plan,
              conversation: {
                ...(priorConversation ?? {}),
                conversation_phase: "discovering",
                extended_after_checkpoint: true,
                pending_questions: pending,
                allow_continue: false,
                allow_proceed_to_proposal: false,
                human_message: continueCopy,
              },
            },
          });
          stage("clarifying", continueCopy, {
            questions: pending,
            questionDetails: continuedQuestionDetails,
            sessionId: session.id,
            questionBatchId,
            conversationPhase: "discovering",
            discovery: storedDiscovery.success ? storedDiscovery.data : null,
            ...(storedDiscovery.success
              ? gapPresentation(storedDiscovery.data)
              : {}),
          });
          await appendStudioAuthoringSessionMessage(db, {
            userId: user.id,
            sessionId: session.id,
            message: {
              role: "discovery_question",
              batch_id: questionBatchId,
              human_message: continueCopy,
              questions: pending,
              question_details: continuedQuestionDetails,
              gap_plan: storedDiscovery.success
                ? storedDiscovery.data.gap_plan
                : undefined,
              at: new Date().toISOString(),
            },
          });
          stage("done", "Esperando respuesta de aclaración.", {
            sessionId: session.id,
            awaiting: "clarification",
          });
          controller.close();
          return;
        }

        if (action === "proceed_to_proposal") {
          if (
            isRetryableAuthoringDiscoveryFailure(
              session.router_output_jsonb?.discovery_failure_class
            )
          ) {
            send({
              type: "error",
              error: RETRYABLE_DISCOVERY_COPY,
              ts: Date.now(),
            });
            controller.close();
            return;
          }
          const storedDiscovery = authoringDiscoveryOutputSchema.safeParse(
            session.router_output_jsonb?.discovery
          );
          if (!storedDiscovery.success) {
            send({
              type: "error",
              error: "No hay un discovery vigente para preparar la propuesta.",
              ts: Date.now(),
            });
            controller.close();
            return;
          }
          const proceeded = proceedAuthoringDiscoveryToProposal({
            discovery: storedDiscovery.data,
            answerTurnCount: session.clarification_round ?? 0,
            priorQuestions,
            extendedAfterCheckpoint,
            proposalRevisions:
              priorConversation?.proposal_revisions ?? [],
            defaultGapIds: requestedDefaultGapIds,
            qaExchanges: priorCompact?.qa_exchanges ?? [],
            questionNumberRegistry:
              priorCompact?.question_number_registry ?? [],
          });
          if (!proceeded.ok) {
            stage("blocked", proceeded.meta.human_message ?? proceeded.reason, {
              sessionId: session.id,
              conversation: proceeded.meta,
              discovery: storedDiscovery.data,
              ...gapPresentation(storedDiscovery.data),
            });
            await updateStudioAuthoringSession(db, {
              userId: user.id,
              sessionId: session.id,
              status: "clarifying",
              routerOutput: {
                ...(session.router_output_jsonb ?? {}),
                conversation: proceeded.meta,
                gap_plan:
                  proceeded.meta.compact_state?.gap_plan ??
                  storedDiscovery.data.gap_plan,
              },
            });
            stage("done", "No se pudo cerrar la propuesta.", {
              sessionId: session.id,
              awaiting: "reformulate",
            });
            controller.close();
            return;
          }
          const proposalAudit = await auditProposalBoundary({
            db,
            userId: user.id,
            sessionId: session.id,
            action,
            clarificationRound,
            requestId: authoringRequestId,
            description: descriptionNl,
            answers: clarificationAnswers,
            discovery: proceeded.discovery,
            signal: request.signal,
          });
          const auditProgress = proposalAuditProgress(proposalAudit.audit);
          stage("proposal_audit", auditProgress.message, auditProgress.payload);
          const auditedDiscovery = proposalAudit.discovery;
          const auditedMeta = conversationWithAuditedDiscovery(
            proceeded.meta,
            auditedDiscovery
          );
          const hash = discoveryHash(auditedDiscovery);
          const patternComposition = patternCompositionForDiscovery(
            auditedDiscovery
          );
          await updateStudioAuthoringSession(db, {
            userId: user.id,
            sessionId: session.id,
            routerKind: auditedDiscovery.final_kind,
            routerOutput: {
              ...(session.router_output_jsonb ?? {}),
              discovery: auditedDiscovery,
              gap_plan: auditedDiscovery.gap_plan,
              discovery_hash: hash,
              conversation: auditedMeta,
              compact_state: auditedMeta.compact_state,
              last_valid_compact_state: auditedMeta.compact_state,
              pattern_composition: patternComposition,
              proposal_audit: proposalAudit.audit,
              quality_warnings: mergeProposalQualityWarnings(
                session.router_output_jsonb?.quality_warnings,
                proposalAudit.audit
              ),
            },
            suggestedSlug:
              auditedDiscovery.suggested_slug ?? resolvedSlug,
            title:
              resolvedTitle ?? auditedDiscovery.suggested_title ?? null,
            status: "active",
            provenance: {
              ...(session.provenance_jsonb ?? {}),
              discovery_hash: hash,
              discovery_updated_at: new Date().toISOString(),
              proposal_audit_model_id: proposalAudit.audit.model_id,
              proposal_audit_coherent: proposalAudit.audit.coherent,
              proposal_audit_at: new Date().toISOString(),
            },
          });
          await appendStudioAuthoringSessionMessage(db, {
            userId: user.id,
            sessionId: session.id,
            message: {
              role: "understanding_summary",
              discovery_hash: hash,
              content: auditedDiscovery.understanding,
              gap_plan: auditedDiscovery.gap_plan,
              ...gapPresentation(auditedDiscovery),
              capability_needs: auditedDiscovery.capability_needs,
              input_requirements: auditedDiscovery.input_requirements,
              invocation_channels: auditedDiscovery.invocation_channels,
              at: new Date().toISOString(),
            },
          });
          const slugConflict = await reusableSkillConflictPayload({
            db,
            userId: user.id,
            sessionId: session.id,
            discovery: auditedDiscovery,
            requestedSlug: slugRaw,
          });
          stage("review_ready", "Confirma lo entendido antes de crear.", {
            sessionId: session.id,
            discovery: auditedDiscovery,
            confirmationHash: hash,
            conversationPhase: "proposal",
            conversation: auditedMeta,
            patternComposition,
            proposalAudit: proposalAudit.audit,
            slugConflict,
          });
          stage("done", "Esperando confirmación humana.", {
            sessionId: session.id,
            awaiting: "confirmation",
          });
          controller.close();
          return;
        }

        if (action === "confirm") {
          if (
            isRetryableAuthoringDiscoveryFailure(
              session.router_output_jsonb?.discovery_failure_class
            )
          ) {
            send({
              type: "error",
              error: RETRYABLE_DISCOVERY_COPY,
              ts: Date.now(),
            });
            controller.close();
            return;
          }
          const stored = authoringDiscoveryOutputSchema.safeParse(
            session.router_output_jsonb?.discovery
          );
          if (!stored.success || stored.data.readiness !== "ready_for_confirmation") {
            send({
              type: "error",
              error: "La sesión no tiene una revisión vigente lista para confirmar.",
              ts: Date.now(),
            });
            controller.close();
            return;
          }
          if (stored.data.gap_plan && !stored.data.gap_plan.can_proceed) {
            send({
              type: "error",
              error: "Quedan decisiones necesarias antes de crear el borrador.",
              ts: Date.now(),
            });
            controller.close();
            return;
          }
          const expectedHash = discoveryHash(stored.data);
          if (!confirmationHash || confirmationHash !== expectedHash) {
            send({
              type: "error",
              error:
                "La revisión cambió o está desactualizada. Revísala nuevamente antes de crear el borrador.",
              ts: Date.now(),
            });
            controller.close();
            return;
          }
          const confirmationSession = await getStudioAuthoringSession(
            db,
            user.id,
            session.id
          );
          const confirmationStored = authoringDiscoveryOutputSchema.safeParse(
            confirmationSession?.router_output_jsonb?.discovery
          );
          if (
            !confirmationSession ||
            !confirmationStored.success ||
            discoveryHash(confirmationStored.data) !== confirmationHash
          ) {
            send({
              type: "error",
              error:
                "La revisión cambió o está desactualizada. Revísala nuevamente antes de crear el borrador.",
              ts: Date.now(),
            });
            controller.close();
            return;
          }
          const claimed = await claimStudioAuthoringSessionForMaterialization(
            db,
            {
              userId: user.id,
              sessionId: session.id,
              expectedUpdatedAt: confirmationSession.updated_at,
            }
          );
          if (!claimed) {
            const message =
              confirmationSession.status === "active"
                ? "Esta sesión ya se está materializando en otra solicitud. Espera el resultado antes de reintentar."
                : confirmationSession.status === "materializing"
                  ? "Esta sesión ya se está materializando. Espera el resultado antes de reintentar."
                  : "La sesión ya no está activa. Empieza de nuevo para crear otro borrador.";
            send({
              type: "error",
              error: message,
              ts: Date.now(),
            });
            controller.close();
            return;
          }
          session = claimed;
          claimedSessionId = claimed.id;
          routed = {
            kind: confirmationStored.data.final_kind,
            skill_subtype: confirmationStored.data.skill_subtype,
            confidence: confirmationStored.data.confidence,
            reasons: confirmationStored.data.rationale,
            clarifying_questions: [],
            suggested_title: confirmationStored.data.suggested_title,
            suggested_slug: confirmationStored.data.suggested_slug,
            requested_side_effects:
              confirmationStored.data.requested_side_effects,
            modelId: session.model_id,
            source: "model",
          };
          await appendStudioAuthoringSessionMessage(db, {
            userId: user.id,
            sessionId: session.id,
            message: {
              role: "user_confirmed",
              discovery_hash: expectedHash,
              at: new Date().toISOString(),
            },
          });
          await updateStudioAuthoringSession(db, {
            userId: user.id,
            sessionId: session.id,
            provenance: {
              ...(session.provenance_jsonb ?? {}),
              discovery_hash: expectedHash,
              confirmed_at: new Date().toISOString(),
            },
          });
          stage("review_confirmed", "Solicitud confirmada. Creando borrador.", {
            kind: routed.kind,
          });
        } else {
          stage("routing", "Identificando la forma de trabajo…");
          await persistProgress(session.id, { stage: "routing" });

          const storedRouter =
            action === "retry_discovery"
              ? readStoredAuthoringRouterResult(
                  session.router_output_jsonb as Record<string, unknown> | null
                )
              : null;
          const routerSignal =
            storedRouter ??
            (await runWithAiUsageContext(
              {
                userId: user.id,
                channel: "web",
                sessionId: session.id,
                turnId: authoringAiTurnId({
                  action,
                  clarificationRound,
                  operation: "router",
                  requestId: authoringRequestId,
                }),
              },
              db,
              () =>
                routeAuthoringDescription({
                  description: descriptionNl,
                  clarificationAnswers,
                })
            ));

          stage("routed", "Se identificó una forma provisional.", {
            classification: {
              kind: routerSignal.kind,
              skill_subtype: routerSignal.skill_subtype ?? null,
              confidence: routerSignal.confidence,
              reasons: routerSignal.reasons,
              suggested_title: routerSignal.suggested_title ?? resolvedTitle,
              suggested_slug: routerSignal.suggested_slug ?? resolvedSlug,
              source: routerSignal.source,
            },
            modelId: routerSignal.modelId,
          });

          stage("discovering", "Revisando objetivo, fuentes, actores y decisiones…");
          await persistProgress(session.id, { stage: "discovering" });
          const [loadedCatalogs, providerSnapshot, accountSkills] =
            await Promise.all([
              buildCapabilityCatalogsForUser(db, user.id),
              loadTenantProviderSnapshot(db, user.id),
              listAccountSkillsForUser(db, user.id),
            ]);
          catalogs = loadedCatalogs;
          const authoringSkillSlugs = [
            ...new Set([
              ...catalogs.skillSlugs,
              ...accountSkills.map((skill) => skill.slug),
            ]),
          ];
          const capabilityContext = buildAuthoringCapabilityContext({
            snapshot: providerSnapshot,
            authoringSessionId: session.id,
          });
          const latestAnswer =
            newAnswers.length > 0
              ? newAnswers[newAnswers.length - 1] ?? null
              : null;
          const discoveryResult = await runWithAiUsageContext(
            {
              userId: user.id,
              channel: "web",
              sessionId: session.id,
              turnId: authoringAiTurnId({
                action,
                clarificationRound,
                operation: "discovery",
                requestId: authoringRequestId,
              }),
            },
            db,
            () =>
              runAuthoringDiscovery({
                description: descriptionNl,
                answers: clarificationAnswers,
                latestAnswer,
                priorQuestions,
                compactState:
                  action === "retry_discovery"
                    ? retryCompact
                    : clarificationAnswers.length > 0
                      ? priorCompact
                      : null,
                routerSignal,
                catalogs: {
                  skills: authoringSkillSlugs,
                  tools: [...catalogs!.toolIds],
                  integrations: [...catalogs!.connectedIntegrations],
                  assets: [...catalogs!.tenantConfiguredAssetKeys],
                  workerCapabilities: [...catalogs!.workerCapabilities],
                },
                capabilityContext,
                signal: request.signal,
              })
          );
          emitFailClosedEvent(session.id, discoveryResult);
          const nextQuestionNumberRegistry = [
            ...(priorCompact?.question_number_registry ?? []),
          ];
          for (const detail of discoveryResult.discovery
            .clarifying_question_details) {
            if (!detail.gap_id || !detail.display_number) continue;
            const existing = nextQuestionNumberRegistry.find(
              (entry) => entry.gap_id === detail.gap_id
            );
            if (existing) {
              existing.number = detail.display_number;
            } else {
              nextQuestionNumberRegistry.push({
                gap_id: detail.gap_id,
                number: detail.display_number,
              });
            }
          }
          const roundIntro =
            discoveryResult.discovery.gap_plan &&
            discoveryResult.discovery.clarifying_question_details.length > 0
              ? buildAuthoringGapRoundIntro(
                  classifyAuthoringGapRound({
                    previousPlan: priorCompact?.gap_plan,
                    currentPlan: discoveryResult.discovery.gap_plan,
                    presentedGapIds:
                      discoveryResult.discovery.clarifying_question_details.flatMap(
                        (detail) => (detail.gap_id ? [detail.gap_id] : [])
                      ),
                    previouslyPresentedGapIds: (
                      priorCompact?.question_number_registry ?? []
                    ).map((entry) => entry.gap_id),
                    isFirstRound:
                      !priorCompact?.gap_plan ||
                      (priorCompact.question_number_registry?.length ?? 0) === 0,
                  })
                )
              : null;
          const resolvedTurn = resolveAuthoringConversationTurn({
            discovery: discoveryResult.discovery,
            answerTurnCount: clarificationRound,
            priorQuestions: [
              ...priorQuestions,
              ...discoveryResult.discovery.clarifying_questions,
            ],
            extendedAfterCheckpoint,
            proposalRevisions:
              priorConversation?.proposal_revisions ?? [],
            qaExchanges: priorCompact?.qa_exchanges ?? [],
            questionNumberRegistry: nextQuestionNumberRegistry,
          });
          let discovery = resolvedTurn.discovery;
          let proposalAudit: ProposalCoherenceAuditMeta | null = null;
          let conversation = applyAuthoringRoundIntro({
            phase: resolvedTurn.phase,
            conversation: resolvedTurn.meta,
            roundIntro,
          });
          if (
            action === "answer" &&
            latestQuestionBatch &&
            newAnswers.length > 0 &&
            conversation.compact_state &&
            latestQuestionBatch.gapIds.length ===
              latestQuestionBatch.questions.length &&
            latestQuestionBatch.questionDetails.length ===
              latestQuestionBatch.questions.length
          ) {
            const compactState = appendAuthoringQaExchange({
              compactState: conversation.compact_state,
              exchange: {
                batch_id: latestQuestionBatch.batchId,
                turn_id: `${session.id}:${clarificationRound}`,
                gap_ids: latestQuestionBatch.gapIds,
                questions: latestQuestionBatch.questions,
                question_details: latestQuestionBatch.questionDetails.map(
                  (detail, index) => ({
                    question: latestQuestionBatch.questions[index]!,
                    target_dimension: cleanText(detail.target_dimension),
                    gap: cleanText(detail.gap),
                    gap_id: latestQuestionBatch.gapIds[index]!,
                    examples: Array.isArray(detail.examples)
                      ? detail.examples.filter(
                          (example): example is string =>
                            typeof example === "string"
                        )
                      : [],
                  })
                ),
                answer: newAnswers.join("\n"),
                timestamp: new Date().toISOString(),
              },
            });
            conversation = {
              ...conversation,
              compact_state: compactState,
            };
          }
          if (resolvedTurn.phase === "proposal") {
            const audited = await auditProposalBoundary({
              db,
              userId: user.id,
              sessionId: session.id,
              action,
              clarificationRound,
              requestId: authoringRequestId,
              description: descriptionNl,
              answers: clarificationAnswers,
              discovery,
              signal: request.signal,
            });
            const auditProgress = proposalAuditProgress(audited.audit);
            stage(
              "proposal_audit",
              auditProgress.message,
              auditProgress.payload
            );
            discovery = audited.discovery;
            proposalAudit = audited.audit;
            conversation = conversationWithAuditedDiscovery(
              conversation,
              discovery
            );
          }
          const patternComposition =
            patternCompositionForDiscovery(discovery);
          const hash = discoveryHash(discovery);
          const routedKind =
            resolvedTurn.phase === "discovering" ||
            resolvedTurn.phase === "checkpoint"
              ? "clarify"
              : discovery.readiness === "blocked_reformulate"
                ? "clarify"
                : discovery.final_kind;
          routed = {
            kind: routedKind,
            skill_subtype: discovery.skill_subtype,
            confidence: discovery.confidence,
            reasons: discovery.rationale,
            clarifying_questions: discovery.clarifying_questions,
            suggested_title: discovery.suggested_title,
            suggested_slug: discovery.suggested_slug,
            requested_side_effects: discovery.requested_side_effects,
            modelId: discoveryResult.modelId,
            source:
              discoveryResult.kind === "ok" ? "model" : "fail_closed",
          };

          await updateStudioAuthoringSession(db, {
            userId: user.id,
            sessionId: session.id,
            routerKind: discovery.final_kind,
            routerOutput: {
              router: routerSignal,
              discovery,
              gap_plan: discovery.gap_plan,
              discovery_hash: hash,
              discovery_result: discoveryResult.kind,
              evidence_failures: discoveryResult.evidenceFailures,
              ...discoveryResultMetadata(discoveryResult),
              quality_warnings: mergeProposalQualityWarnings(
                discoveryResult.qualityWarnings,
                proposalAudit
              ),
              capability_context: capabilityContext,
              pattern_composition: patternComposition,
              ...(proposalAudit ? { proposal_audit: proposalAudit } : {}),
              conversation,
              compact_state: conversation.compact_state,
              last_valid_compact_state:
                discoveryResult.kind === "ok"
                  ? conversation.compact_state
                  : lastValidCompact ?? priorCompact,
            },
            modelId: discoveryResult.modelId,
            suggestedSlug: discovery.suggested_slug ?? resolvedSlug,
            title: resolvedTitle ?? discovery.suggested_title ?? null,
            clarificationRound,
            status:
              resolvedTurn.phase === "discovering" ||
              resolvedTurn.phase === "checkpoint" ||
              resolvedTurn.phase === "blocked"
                ? "clarifying"
                : "active",
            provenance: {
              ...(session.provenance_jsonb ?? {}),
              discovery_hash: hash,
              discovery_model_id: discoveryResult.modelId,
              discovery_updated_at: new Date().toISOString(),
              conversation_phase: resolvedTurn.phase,
              ...(proposalAudit
                ? {
                    proposal_audit_model_id: proposalAudit.model_id,
                    proposal_audit_coherent: proposalAudit.coherent,
                    proposal_audit_at: new Date().toISOString(),
                  }
                : {}),
            },
          });

          stage("discovery_ready", "Revisión de la solicitud lista.", {
            discovery,
            confirmationHash: hash,
            modelId: discoveryResult.modelId,
            conversationPhase: resolvedTurn.phase,
            conversation,
            patternComposition,
            ...discoveryStreamMetadata(discoveryResult),
          });
          await persistProgress(session.id, {
            stage: "discovery_ready",
            kind: discovery.final_kind,
            readiness: discovery.readiness,
            conversationPhase: resolvedTurn.phase,
            modelId: discoveryResult.modelId,
          });

          if (
            isRetryableAuthoringDiscoveryFailure(
              discoveryResult.failureClass
            )
          ) {
            stage("discovery_retryable", RETRYABLE_DISCOVERY_COPY, {
              sessionId: session.id,
              conversationPhase: "blocked",
              ...discoveryStreamMetadata(discoveryResult),
            });
            stage("done", RETRYABLE_DISCOVERY_COPY, {
              sessionId: session.id,
              awaiting: "retry_discovery",
              ...discoveryStreamMetadata(discoveryResult),
            });
            controller.close();
            return;
          }

          if (resolvedTurn.phase === "proposal") {
            await appendStudioAuthoringSessionMessage(db, {
              userId: user.id,
              sessionId: session.id,
              message: {
                role: "understanding_summary",
                discovery_hash: hash,
                content: discovery.understanding,
                gap_plan: discovery.gap_plan,
                ...gapPresentation(discovery),
                capability_needs: discovery.capability_needs,
                input_requirements: discovery.input_requirements,
                invocation_channels: discovery.invocation_channels,
                at: new Date().toISOString(),
              },
            });
            const slugConflict = await reusableSkillConflictPayload({
              db,
              userId: user.id,
              sessionId: session.id,
              discovery,
              requestedSlug: slugRaw,
            });
            stage("review_ready", "Confirma lo entendido antes de crear.", {
              sessionId: session.id,
              discovery,
              confirmationHash: hash,
              conversationPhase: "proposal",
              conversation,
              ...gapPresentation(discovery),
              ...(proposalAudit ? { proposalAudit } : {}),
              slugConflict,
            });
            stage("done", "Esperando confirmación humana.", {
              sessionId: session.id,
              awaiting: "confirmation",
            });
            controller.close();
            return;
          }

          if (resolvedTurn.phase === "blocked") {
            const blockerCount = discovery.gap_plan?.counts.blockers ?? 0;
            stage(
              "blocked",
              blockerCount > 0
                ? pendingDecisionCopy(blockerCount)
                : conversation.human_message ??
                    "Aún faltan datos materiales. Reformula la solicitud.",
              {
                sessionId: session.id,
                discovery,
                conversation,
                conversationPhase: "blocked",
                ...gapPresentation(discovery),
                ...discoveryStreamMetadata(discoveryResult),
              }
            );
            stage("done", "Discovery bloqueado; reformula la solicitud.", {
              sessionId: session.id,
              awaiting: "reformulate",
              ...discoveryStreamMetadata(discoveryResult),
            });
            controller.close();
            return;
          }

          if (resolvedTurn.phase === "checkpoint") {
            const blockerCount = discovery.gap_plan?.counts.blockers ?? 0;
            const questionBatchId = randomUUID();
            const checkpointCopy =
              conversation.human_message ??
              (blockerCount > 0
                ? pendingDecisionCopy(blockerCount)
                : "¿Seguimos aclarando o preparamos la propuesta?");
            stage(
              "checkpoint",
              checkpointCopy,
              {
                sessionId: session.id,
                questionBatchId,
                discovery,
                conversation,
                conversationPhase: "checkpoint",
                questions: conversation.pending_questions,
                questionDetails:
                  discovery.clarifying_question_details.filter((detail) =>
                    conversation.pending_questions.includes(detail.question)
                  ),
                ...gapPresentation(discovery),
              }
            );
            await appendStudioAuthoringSessionMessage(db, {
              userId: user.id,
              sessionId: session.id,
              message: {
                role: "discovery_checkpoint",
                batch_id: questionBatchId,
                human_message: checkpointCopy,
                content: discovery.understanding,
                questions: conversation.pending_questions,
                question_details:
                  discovery.clarifying_question_details.filter((detail) =>
                    conversation.pending_questions.includes(detail.question)
                  ),
                gap_plan: discovery.gap_plan,
                ...gapPresentation(discovery),
                capability_needs: discovery.capability_needs,
                input_requirements: discovery.input_requirements,
                invocation_channels: discovery.invocation_channels,
                at: new Date().toISOString(),
              },
            });
            stage("done", "Esperando decisión del checkpoint.", {
              sessionId: session.id,
              awaiting: "checkpoint",
            });
            controller.close();
            return;
          }

          if (resolvedTurn.phase === "discovering") {
            const questions = conversation.pending_questions;
            const questionBatchId = randomUUID();
            const clarifyingCopy =
              conversation.human_message ??
              "Necesito un poco más de contexto.";
            const questionDetails =
              discovery.clarifying_question_details.filter((detail) =>
                questions.includes(detail.question)
              );
            stage(
              "clarifying",
              clarifyingCopy,
              {
                questions,
                questionDetails,
                sessionId: session.id,
                questionBatchId,
                conversationPhase: "discovering",
                conversation,
                discovery,
                ...gapPresentation(discovery),
              }
            );
            await appendStudioAuthoringSessionMessage(db, {
              userId: user.id,
              sessionId: session.id,
              message: {
                role: "discovery_question",
                batch_id: questionBatchId,
                human_message: clarifyingCopy,
                questions,
                question_details: questionDetails,
                gap_plan: discovery.gap_plan,
                at: new Date().toISOString(),
              },
            });
            await persistProgress(session.id, {
              stage: "clarifying",
              questions,
            });
            await updateStudioAuthoringSession(db, {
              userId: user.id,
              sessionId: session.id,
              status: "clarifying",
              clarificationRound,
            });
            stage("done", "Esperando respuesta de aclaración.", {
              sessionId: session.id,
              awaiting: "clarification",
            });
            controller.close();
            return;
          }
        }

        if (routed.kind === "clarify") {
          stage("blocked", "No pude validar preguntas nuevas para continuar.", {
            sessionId: session.id,
            conversationPhase: "blocked",
          });
          await persistProgress(session.id, {
            stage: "blocked",
            reason: "no_validated_questions",
          });
          await updateStudioAuthoringSession(db, {
            userId: user.id,
            sessionId: session.id,
            status: "clarifying",
            clarificationRound,
          });
          stage("done", "Reintenta el análisis; no se creó ningún borrador.", {
            sessionId: session.id,
            awaiting: "reformulate",
          });
          controller.close();
          return;
        }

        if (routed.kind === "redirect_to_chat") {
          if (action === "retry_discovery") {
            stage("redirect", "Esto encaja mejor en el chat.", {
              path: "/chat",
              kind: routed.kind,
            });
            await updateStudioAuthoringSession(db, {
              userId: user.id,
              sessionId: session.id,
              status: "redirected",
              artifactKind: "redirect_to_chat",
              artifactRef: {},
            });
            stage("done", "Redirigiendo al chat.", {
              sessionId: session.id,
              path: "/chat",
            });
            controller.close();
            return;
          }
          const materialized = await materializeAuthoringArtifact({
            db,
            userId: user.id,
            kind: "redirect_to_chat",
            description: descriptionNl,
          });
          stage("redirect", "Esto encaja mejor en el chat.", {
            path: materialized.redirectPath ?? "/chat",
            kind: routed.kind,
          });
          await updateStudioAuthoringSession(db, {
            userId: user.id,
            sessionId: session.id,
            status: "redirected",
            artifactKind: "redirect_to_chat",
            artifactRef: {},
          });
          stage("done", "Redirigiendo al chat.", {
            path: materialized.redirectPath ?? "/chat",
          });
          controller.close();
          return;
        }

        // Artefacto: cargar catálogos (necesarios para case_workflow; útiles para UI).
        stage(
          routed.kind === "case_workflow" ? "compiling" : "materializing",
          routed.kind === "case_workflow"
            ? "Compilando borrador del flujo de caso…"
            : "Materializando el artefacto…"
        );
        await persistProgress(session.id, {
          stage:
            routed.kind === "case_workflow" ? "compiling" : "materializing",
        });

        catalogs ??= await buildCapabilityCatalogsForUser(db, user.id);
        const skillSlugs = [...catalogs.skillSlugs];
        const toolIds = [...catalogs.toolIds];
        const workerCapabilities = [...catalogs.workerCapabilities];
        const knownGuards = [...catalogs.knownGuards];
        stage("catalogs_loaded", "Catálogos del tenant cargados.", {
          skills: skillSlugs.length,
          tools: toolIds.length,
          capabilities: workerCapabilities.length,
        });
        await persistProgress(session.id, { stage: "catalogs_loaded" });

        const materializeCatalogs = {
          availableGuards: knownGuards,
          availableSkills: skillSlugs,
          availableCapabilities: [...new Set(workerCapabilities)],
          availableTools: TOOL_CATALOG.map((tool) => tool.id),
        };
        const storedDiscoveryForCompile =
          authoringDiscoveryOutputSchema.safeParse(
            session.router_output_jsonb?.discovery
          );
        const storedDiscoveryHashForCompile =
          typeof session.router_output_jsonb?.discovery_hash === "string"
            ? session.router_output_jsonb.discovery_hash
            : null;
        const patternComposition = storedDiscoveryForCompile.success
          ? patternCompositionForDiscovery(storedDiscoveryForCompile.data)
          : isArtifactKind(routed.kind)
            ? resolveSolutionPatternComposition({
                workForm: routed.kind,
                triggers: inferSolutionPatternTriggers({
                  requestedSideEffects: routed.requested_side_effects,
                }),
              })
            : null;
        if (patternComposition?.issues.length) {
          const error =
            `La composición de patrones no es válida: ${patternComposition.issues.join(
              "; "
            )}`;
          stage("materialize_failed", "No se pudo crear el borrador.", {
            retriable: true,
            code: "pattern_composition_invalid",
          });
          send({
            type: "error",
            error,
            code: "pattern_composition_invalid",
            retriable: true,
            ts: Date.now(),
          });
          await updateStudioAuthoringSession(db, {
            userId: user.id,
            sessionId: session.id,
            status: "active",
          });
          controller.close();
          return;
        }

        const result = await runWithAiUsageContext(
          {
            userId: user.id,
            channel: "web",
            sessionId: session.id,
            turnId: authoringAiTurnId({
              action,
              clarificationRound,
              operation: "materialize",
              requestId: authoringRequestId,
            }),
          },
          db,
          () =>
            materializeAuthoringArtifact({
              db,
              userId: user.id,
              kind: routed.kind,
              skillSubtype: routed.skill_subtype,
              title: resolvedTitle ?? routed.suggested_title ?? null,
              slug: slugRaw || routed.suggested_slug || resolvedSlug,
              description: descriptionNl,
              clarificationAnswers,
              authoringDiscovery: storedDiscoveryForCompile.success
                ? storedDiscoveryForCompile.data
                : undefined,
              discoveryHash: storedDiscoveryHashForCompile ?? undefined,
              catalogs: materializeCatalogs,
              authoringSessionId: session.id,
              overwriteExisting,
              patternComposition: patternComposition ?? undefined,
            })
        );

        if (result.error) {
          const retriable = result.retriable !== false;
          stage("materialize_failed", "No se pudo crear el borrador.", {
            retriable,
            code: result.errorCode ?? "materialize_failed",
            ...(result.conflict ? { slugConflict: result.conflict } : {}),
          });
          send({
            type: "error",
            error: result.error,
            details: result.errorDetails,
            code: result.errorCode,
            retriable,
            ts: Date.now(),
          });
          await updateStudioAuthoringSession(db, {
            userId: user.id,
            sessionId: session.id,
            status: "active",
          });
          await persistProgress(session.id, {
            stage: "materialize_failed",
            error: result.error,
            code: result.errorCode ?? null,
            retriable,
          });
          controller.close();
          return;
        }

        if (
          result.clarifyingQuestions &&
          result.clarifyingQuestions.length > 0
        ) {
          const round = Math.max(1, clarificationRound || 1);
          if (round > MAX_CLARIFICATION_ROUNDS) {
            send({
              type: "error",
              error:
                "Se alcanzó el límite de rondas de aclaración. Reformula la descripción e inténtalo de nuevo.",
              ts: Date.now(),
            });
            await updateStudioAuthoringSession(db, {
              userId: user.id,
              sessionId: session.id,
              status: "abandoned",
              clarificationRound: round,
            });
            controller.close();
            return;
          }
          stage("clarifying", "El compilador necesita aclarar.", {
            questions: result.clarifyingQuestions,
            sessionId: session.id,
            conversationPhase: "discovering",
          });
          await appendStudioAuthoringSessionMessage(db, {
            userId: user.id,
            sessionId: session.id,
            message: {
              role: "compiler_clarify",
              questions: result.clarifyingQuestions,
              at: new Date().toISOString(),
            },
          });
          await updateStudioAuthoringSession(db, {
            userId: user.id,
            sessionId: session.id,
            status: "clarifying",
            clarificationRound: round,
          });
          stage("done", "Esperando respuestas de aclaración.", {
            sessionId: session.id,
            awaiting: "clarification",
          });
          controller.close();
          return;
        }

        if (!isArtifactKind(result.kind) && result.kind !== "redirect_to_chat") {
          // clarify sin preguntas — no debería ocurrir tras materialize.
          stage("done", "Sin artefacto materializado.", {
            sessionId: session.id,
            kind: result.kind,
          });
          controller.close();
          return;
        }

        const reviewPath = result.redirectPath
          ? `${result.redirectPath}${result.redirectPath.includes("?") ? "&" : "?"}authoring_session=${encodeURIComponent(session.id)}`
          : `/operations/workflows/design?authoring_session=${encodeURIComponent(session.id)}`;

        stage(
          result.kind === "case_workflow" ? "draft_saved" : "artifact_ready",
          result.kind === "case_workflow"
            ? "Borrador del flujo guardado."
            : "Artefacto listo.",
          {
            kind: result.kind,
            artifactRef: result.artifactRef,
          }
        );
        await persistProgress(session.id, {
          stage:
            result.kind === "case_workflow" ? "draft_saved" : "artifact_ready",
          artifactRef: result.artifactRef,
        });

        await updateStudioAuthoringSession(db, {
          userId: user.id,
          sessionId: session.id,
          status: "compiled",
          artifactKind: result.kind,
          artifactRef: result.artifactRef,
          provenance: {
            ...(session.provenance_jsonb ?? {}),
            discovery_hash:
              typeof session.router_output_jsonb?.discovery_hash === "string"
                ? session.router_output_jsonb.discovery_hash
                : confirmationHash,
            result_path: reviewPath,
            materialized_at: new Date().toISOString(),
          },
        });

        stage("redirect", "Abriendo la revisión del borrador.", {
          path: reviewPath,
          kind: result.kind,
          artifactRef: result.artifactRef,
        });

        stage("done", "Autoría completada.", {
          sessionId: session.id,
          kind: result.kind,
          artifactRef: result.artifactRef,
          path: reviewPath,
        });
        controller.close();
      } catch (error) {
        if (
          request.signal.aborted ||
          (error instanceof DOMException && error.name === "AbortError")
        ) {
          try {
            controller.close();
          } catch {
            // El cliente ya cerró el stream.
          }
          return;
        }
        console.error("[studio-authoring] failed:", error);
        if (claimedSessionId) {
          try {
            await updateStudioAuthoringSession(db, {
              userId: user.id,
              sessionId: claimedSessionId,
              status: "active",
            });
          } catch (recoveryError) {
            console.warn(
              "[studio-authoring] failed to release materialization claim:",
              recoveryError
            );
          }
        }
        send({
          type: "error",
          error:
            error instanceof Error
              ? error.message
              : "Error interno de autoría",
          ts: Date.now(),
        });
        controller.close();
      }
    },
  });

  return ndjsonResponse(stream);
}
