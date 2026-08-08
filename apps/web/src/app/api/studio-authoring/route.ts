/**
 * POST /api/studio-authoring — sesión de autoría del Studio (Slice 5.3).
 *
 * Stream NDJSON de etapas: session_ready → routing → routed →
 * clarifying | compiling/materializing → catalogs_loaded → draft_saved /
 * artifact_ready → redirect | done | error.
 */

import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import {
  appendStudioAuthoringSessionMessage,
  appendStudioAuthoringSessionProgress,
  claimStudioAuthoringSessionForMaterialization,
  createServerClient,
  createStudioAuthoringSession,
  getStudioAuthoringSession,
  updateStudioAuthoringSession,
} from "@agents/db";
import {
  runWithAiUsageContext,
  TOOL_CATALOG,
} from "@agents/agent";
import {
  AUTHORING_HARD_LIMIT_TURN,
  authoringConversationMetaSchema,
  authoringDiscoveryCompactStateSchema,
  authoringDiscoveryOutputSchema,
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
import { runAuthoringDiscovery } from "@/lib/workflow-studio/authoring-discovery";
import { materializeAuthoringArtifact } from "@/lib/workflow-studio/materialize-artifact";
import { buildCapabilityCatalogsForUser } from "@/lib/workflow-studio/definition-validation";
import { loadTenantProviderSnapshot } from "@/lib/tool-readiness/load-tenant-provider-snapshot";
import { buildAuthoringCapabilityContext } from "@/lib/workflow-studio/capability-provider-catalog";

/** Límite duro de turnos de respuesta (política conversacional 3+2). */
const MAX_CLARIFICATION_ROUNDS = AUTHORING_HARD_LIMIT_TURN;

type StudioAuthoringAction =
  | "discover"
  | "answer"
  | "confirm"
  | "continue_discovery"
  | "proceed_to_proposal";

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
  const fromConversation = authoringDiscoveryCompactStateSchema.safeParse(
    (routerOutput?.conversation as { compact_state?: unknown } | undefined)
      ?.compact_state
  );
  if (fromConversation.success) return fromConversation.data;
  const direct = authoringDiscoveryCompactStateSchema.safeParse(
    routerOutput?.compact_state
  );
  return direct.success ? direct.data : null;
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
    understandingEffects: discovery.understanding.effects,
    understandingSources: discovery.understanding.sources,
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
      ts: number;
    };

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
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

function discoveryHash(discovery: AuthoringDiscoveryOutput): string {
  return `sha256:${createHash("sha256")
    .update(canonicalizeJson(discovery), "utf8")
    .digest("hex")}`;
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
  const session = await getStudioAuthoringSession(
    createServerClient(),
    user.id,
    sessionId
  );
  if (!session) {
    return NextResponse.json({ error: "Sesión no encontrada" }, { status: 404 });
  }
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
    clarificationAnswer?: unknown;
    answers?: unknown;
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
    actionRaw === "answer" ||
    actionRaw === "continue_discovery" ||
    actionRaw === "proceed_to_proposal"
      ? actionRaw
      : "discover";
  const confirmationHash = cleanText(body.confirmationHash) || null;
  const newAnswers = collectAnswers(body);

  if (!description && !sessionIdIn) {
    return NextResponse.json(
      { error: "Describe qué quieres construir." },
      { status: 400 }
    );
  }

  const db = createServerClient();
  const encoder = new TextEncoder();

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

        const descriptionNl =
          description || session?.description_nl?.trim() || "";
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
        const priorAnswers = (session.messages_jsonb ?? [])
          .filter(
            (msg): msg is Record<string, unknown> =>
              !!msg &&
              typeof msg === "object" &&
              (msg as Record<string, unknown>).role === "user_answer"
          )
          .map((msg) => cleanText(msg.content))
          .filter(Boolean);
        const priorQuestions = (session.messages_jsonb ?? []).flatMap((msg) => {
          if (!msg || typeof msg !== "object") return [];
          const record = msg as Record<string, unknown>;
          if (record.role !== "discovery_question") return [];
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
              at: new Date().toISOString(),
            },
          });
        }

        const clarificationRound =
          (session.clarification_round ?? 0) +
          (newAnswers.length > 0 ? 1 : 0);
        const priorConversation = readConversationMeta(
          session.router_output_jsonb as Record<string, unknown> | null
        );
        const priorCompact = readCompactState(
          session.router_output_jsonb as Record<string, unknown> | null
        );
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
          await updateStudioAuthoringSession(db, {
            userId: user.id,
            sessionId: session.id,
            status: "clarifying",
            clarificationRound: session.clarification_round ?? 0,
            routerOutput: {
              ...(session.router_output_jsonb ?? {}),
              conversation: {
                ...(priorConversation ?? {}),
                conversation_phase: "discovering",
                extended_after_checkpoint: true,
                pending_questions: pending,
                allow_continue: false,
                allow_proceed_to_proposal: false,
                human_message:
                  "Continuemos. Responde con lo que sepas; puedes cubrir varias preguntas en un solo mensaje.",
              },
            },
          });
          stage("clarifying", "Continuemos con lo que falta.", {
            questions: pending,
            questionDetails: storedDiscovery.success
              ? storedDiscovery.data.clarifying_question_details.filter(
                  (detail) => pending.includes(detail.question)
                )
              : [],
            sessionId: session.id,
            conversationPhase: "discovering",
            discovery: storedDiscovery.success ? storedDiscovery.data : null,
          });
          await appendStudioAuthoringSessionMessage(db, {
            userId: user.id,
            sessionId: session.id,
            message: {
              role: "discovery_question",
              questions: pending,
              question_details: storedDiscovery.success
                ? storedDiscovery.data.clarifying_question_details.filter(
                    (detail) => pending.includes(detail.question)
                  )
                : [],
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
          });
          if (!proceeded.ok) {
            stage("blocked", proceeded.meta.human_message ?? proceeded.reason, {
              sessionId: session.id,
              conversation: proceeded.meta,
              discovery: storedDiscovery.data,
            });
            await updateStudioAuthoringSession(db, {
              userId: user.id,
              sessionId: session.id,
              status: "clarifying",
              routerOutput: {
                ...(session.router_output_jsonb ?? {}),
                conversation: proceeded.meta,
              },
            });
            stage("done", "No se pudo cerrar la propuesta.", {
              sessionId: session.id,
              awaiting: "reformulate",
            });
            controller.close();
            return;
          }
          const hash = discoveryHash(proceeded.discovery);
          const patternComposition = patternCompositionForDiscovery(
            proceeded.discovery
          );
          await updateStudioAuthoringSession(db, {
            userId: user.id,
            sessionId: session.id,
            routerKind: proceeded.discovery.final_kind,
            routerOutput: {
              ...(session.router_output_jsonb ?? {}),
              discovery: proceeded.discovery,
              discovery_hash: hash,
              conversation: proceeded.meta,
              compact_state: proceeded.meta.compact_state,
              pattern_composition: patternComposition,
            },
            suggestedSlug:
              proceeded.discovery.suggested_slug ?? resolvedSlug,
            title:
              resolvedTitle ?? proceeded.discovery.suggested_title ?? null,
            status: "active",
            provenance: {
              ...(session.provenance_jsonb ?? {}),
              discovery_hash: hash,
              discovery_updated_at: new Date().toISOString(),
            },
          });
          await appendStudioAuthoringSessionMessage(db, {
            userId: user.id,
            sessionId: session.id,
            message: {
              role: "understanding_summary",
              discovery_hash: hash,
              content: proceeded.discovery.understanding,
              capability_needs: proceeded.discovery.capability_needs,
              at: new Date().toISOString(),
            },
          });
          stage("review_ready", "Confirma lo entendido antes de crear.", {
            sessionId: session.id,
            discovery: proceeded.discovery,
            confirmationHash: hash,
            conversationPhase: "proposal",
            conversation: proceeded.meta,
            patternComposition,
          });
          stage("done", "Esperando confirmación humana.", {
            sessionId: session.id,
            awaiting: "confirmation",
          });
          controller.close();
          return;
        }

        if (action === "confirm") {
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
          const claimed = await claimStudioAuthoringSessionForMaterialization(
            db,
            { userId: user.id, sessionId: session.id }
          );
          if (!claimed) {
            send({
              type: "error",
              error:
                "Esta sesión ya se está materializando en otra solicitud. Espera el resultado antes de reintentar.",
              ts: Date.now(),
            });
            controller.close();
            return;
          }
          session = claimed;
          claimedSessionId = claimed.id;
          routed = {
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

          const routerSignal = await runWithAiUsageContext(
            { userId: user.id, channel: "web" },
            db,
            () =>
              routeAuthoringDescription({
                description: descriptionNl,
                clarificationAnswers,
              })
          );

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
          const [loadedCatalogs, providerSnapshot] = await Promise.all([
            buildCapabilityCatalogsForUser(db, user.id),
            loadTenantProviderSnapshot(db, user.id),
          ]);
          catalogs = loadedCatalogs;
          const capabilityContext = buildAuthoringCapabilityContext({
            values: [descriptionNl, ...clarificationAnswers],
            snapshot: providerSnapshot,
            authoringSessionId: session.id,
          });
          const latestAnswer =
            newAnswers.length > 0
              ? newAnswers[newAnswers.length - 1] ?? null
              : null;
          const discoveryResult = await runWithAiUsageContext(
            { userId: user.id, channel: "web" },
            db,
            () =>
              runAuthoringDiscovery({
                description: descriptionNl,
                answers: clarificationAnswers,
                latestAnswer,
                priorQuestions,
                compactState:
                  clarificationAnswers.length > 0 ? priorCompact : null,
                routerSignal,
                catalogs: {
                  skills: [...catalogs!.skillSlugs],
                  tools: [...catalogs!.toolIds],
                  integrations: [...catalogs!.connectedIntegrations],
                  assets: [...catalogs!.tenantConfiguredAssetKeys],
                  workerCapabilities: [...catalogs!.workerCapabilities],
                },
                capabilityContext,
                signal: request.signal,
              })
          );
          const resolvedTurn = resolveAuthoringConversationTurn({
            discovery: discoveryResult.discovery,
            answerTurnCount: clarificationRound,
            priorQuestions: [
              ...priorQuestions,
              ...discoveryResult.discovery.clarifying_questions,
            ],
            extendedAfterCheckpoint,
          });
          const discovery = resolvedTurn.discovery;
          const conversation = resolvedTurn.meta;
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
              discovery_hash: hash,
              discovery_result: discoveryResult.kind,
              evidence_failures: discoveryResult.evidenceFailures,
              capability_context: capabilityContext,
              pattern_composition: patternComposition,
              conversation,
              compact_state: conversation.compact_state,
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
            },
          });

          stage("discovery_ready", "Revisión de la solicitud lista.", {
            discovery,
            confirmationHash: hash,
            modelId: discoveryResult.modelId,
            conversationPhase: resolvedTurn.phase,
            conversation,
            patternComposition,
          });
          await persistProgress(session.id, {
            stage: "discovery_ready",
            kind: discovery.final_kind,
            readiness: discovery.readiness,
            conversationPhase: resolvedTurn.phase,
            modelId: discoveryResult.modelId,
          });

          if (resolvedTurn.phase === "proposal") {
            await appendStudioAuthoringSessionMessage(db, {
              userId: user.id,
              sessionId: session.id,
              message: {
                role: "understanding_summary",
                discovery_hash: hash,
                content: discovery.understanding,
                capability_needs: discovery.capability_needs,
                at: new Date().toISOString(),
              },
            });
            stage("review_ready", "Confirma lo entendido antes de crear.", {
              sessionId: session.id,
              discovery,
              confirmationHash: hash,
              conversationPhase: "proposal",
              conversation,
            });
            stage("done", "Esperando confirmación humana.", {
              sessionId: session.id,
              awaiting: "confirmation",
            });
            controller.close();
            return;
          }

          if (resolvedTurn.phase === "blocked") {
            stage(
              "blocked",
              conversation.human_message ??
                "Aún faltan datos materiales. Reformula la solicitud.",
              {
                sessionId: session.id,
                discovery,
                conversation,
                conversationPhase: "blocked",
              }
            );
            stage("done", "Discovery bloqueado; reformula la solicitud.", {
              sessionId: session.id,
              awaiting: "reformulate",
            });
            controller.close();
            return;
          }

          if (resolvedTurn.phase === "checkpoint") {
            stage(
              "checkpoint",
              conversation.human_message ??
                "¿Seguimos aclarando o preparamos la propuesta?",
              {
                sessionId: session.id,
                discovery,
                conversation,
                conversationPhase: "checkpoint",
                questions: conversation.pending_questions,
                questionDetails:
                  discovery.clarifying_question_details.filter((detail) =>
                    conversation.pending_questions.includes(detail.question)
                  ),
              }
            );
            await appendStudioAuthoringSessionMessage(db, {
              userId: user.id,
              sessionId: session.id,
              message: {
                role: "discovery_checkpoint",
                content: discovery.understanding,
                questions: conversation.pending_questions,
                question_details:
                  discovery.clarifying_question_details.filter((detail) =>
                    conversation.pending_questions.includes(detail.question)
                  ),
                capability_needs: discovery.capability_needs,
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
            const questionDetails =
              discovery.clarifying_question_details.filter((detail) =>
                questions.includes(detail.question)
              );
            stage(
              "clarifying",
              conversation.human_message ??
                "Necesito un poco más de contexto.",
              {
                questions,
                questionDetails,
                sessionId: session.id,
                conversationPhase: "discovering",
                conversation,
              }
            );
            await appendStudioAuthoringSessionMessage(db, {
              userId: user.id,
              sessionId: session.id,
              message: {
                role: "discovery_question",
                questions,
                question_details: questionDetails,
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
          send({
            type: "error",
            error: `La composición de patrones no es válida: ${patternComposition.issues.join(
              "; "
            )}`,
            ts: Date.now(),
          });
          controller.close();
          return;
        }

        const result = await runWithAiUsageContext(
          { userId: user.id, channel: "web" },
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
              catalogs: materializeCatalogs,
              authoringSessionId: session.id,
              patternComposition: patternComposition ?? undefined,
            })
        );

        if (result.error) {
          send({
            type: "error",
            error: result.error,
            ts: Date.now(),
          });
          await updateStudioAuthoringSession(db, {
            userId: user.id,
            sessionId: session.id,
            status: "abandoned",
          });
          await persistProgress(session.id, {
            stage: "error",
            error: result.error,
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
