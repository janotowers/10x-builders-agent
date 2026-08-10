"use client";

/**
 * Formulario conversacional "Describir → autoría" del Studio (Slice 5.3.1).
 *
 * Hilo Gu/usuario con composer único, checkpoint 3+2, propuesta confirmable
 * y provenance técnica oculta bajo detalles.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  authoringClarifyingQuestionSchema,
  isGenericAuthoringSlug,
  suggestEnglishSlug,
  type AuthoringCapabilityNeed,
  type AuthoringClarifyingQuestion,
  type AuthoringGap,
  type AuthoringGapPlan,
  type AuthoringInvocationChannel,
  type InputRequirement,
} from "@agents/workflows";
import {
  authoringHumanStatus,
  formatAuthoringTechnicalProgress,
  hydrateAuthoringThread,
  workFormLabelFromKind,
  type AuthoringThreadMessage,
} from "@/lib/workflow-studio/authoring-thread";
import { isPerExecutionInputRequirement } from "@/lib/workflow-studio/capability-provider-catalog";

type ProgressEvent = {
  type: "stage";
  stage: string;
  message: string;
  ts: number;
  payload?: Record<string, unknown>;
};

type WorkForm =
  | "case_workflow"
  | "durable_task"
  | "reusable_skill"
  | "schedule"
  | "redirect_to_chat";

type UnderstandingSummary = {
  objective: string;
  sources: string[];
  actors: string[];
  decisions: string[];
  effects: string[];
  capabilities: string[];
  acceptance_criteria: string[];
  assumptions: string[];
  gaps: string[];
};

type DiscoveryReview = {
  final_kind: string;
  skill_subtype?: string;
  rationale: string[];
  material_ambiguities: string[];
  assumptions: string[];
  gaps: string[];
  clarifying_question_details?: AuthoringClarifyingQuestion[];
  capability_needs?: AuthoringCapabilityNeed[];
  input_requirements?: InputRequirement[];
  invocation_channels?: AuthoringInvocationChannel[];
  understanding: UnderstandingSummary;
  suggested_title?: string;
  suggested_slug?: string;
  readiness?: string;
  gap_plan?: AuthoringGapPlan;
};

type ConversationPhase =
  | "intake"
  | "discovering"
  | "checkpoint"
  | "proposal"
  | "blocked"
  | "redirect";

type AuthoringAction =
  | "discover"
  | "answer"
  | "confirm"
  | "revise_proposal"
  | "continue_discovery"
  | "proceed_to_proposal";

function suggestSlugFromTitle(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) return "";
  const slug = suggestEnglishSlug(trimmed);
  return slug === "new_artifact" ? "" : slug;
}

function isWorkForm(value: unknown): value is WorkForm {
  return typeof value === "string" && workFormLabelFromKind(value) !== null;
}

function nextMessageId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function parseQuestionDetails(value: unknown): AuthoringClarifyingQuestion[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const parsed = authoringClarifyingQuestionSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

function gapPresentationFromReview(review: DiscoveryReview | undefined) {
  const gaps = review?.gap_plan?.gaps ?? [];
  return {
    pendingBlockers: gaps.filter(
      (gap) =>
        gap.severity === "blocking" &&
        gap.state !== "answered" &&
        gap.state !== "resolved_by_evidence" &&
        gap.state !== "defaulted"
    ),
    safeDefaults: gaps.flatMap((gap) =>
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

function markProviderConnected(
  needs: readonly AuthoringCapabilityNeed[] | undefined,
  providerId: string
): AuthoringCapabilityNeed[] | undefined {
  return needs?.map((need) =>
    need.provider_id === providerId
      ? {
          ...need,
          status: "connected",
          resolution: "assumed_connected",
          connect_href: null,
        }
      : need
  );
}

function UnderstandingLists({
  understanding,
  omitSemanticSurfaces = false,
  omitGaps = false,
}: {
  understanding: UnderstandingSummary;
  omitSemanticSurfaces?: boolean;
  omitGaps?: boolean;
}) {
  return (
    <div className="mt-2 space-y-2 text-xs">
      <p className="text-neutral-700 dark:text-neutral-200">
        {understanding.objective}
      </p>
      {(
        [
          ["Fuentes", understanding.sources],
          ["Actores", understanding.actors],
          ["Decisiones humanas", understanding.decisions],
          ...(omitSemanticSurfaces
            ? []
            : ([
                ["Efectos externos", understanding.effects],
                ["Capacidades", understanding.capabilities],
              ] as const)),
          ["Criterios de éxito", understanding.acceptance_criteria],
          ["Supuestos", understanding.assumptions],
          ...(omitGaps ? [] : ([["Gaps", understanding.gaps]] as const)),
        ] as const
      ).map(([label, values]) =>
        values.length > 0 ? (
          <div key={label}>
            <p className="font-medium">{label}</p>
            <ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-neutral-600 dark:text-neutral-300">
              {values.map((value) => (
                <li key={value}>{value}</li>
              ))}
            </ul>
          </div>
        ) : null
      )}
    </div>
  );
}

function GapDecisionPanel({
  blockers,
  safeDefaults,
}: {
  blockers: readonly AuthoringGap[];
  safeDefaults?: ReadonlyArray<{
    gap_id: string;
    summary: string;
    value: string;
  }>;
}) {
  if (blockers.length === 0 && !safeDefaults?.length) return null;
  return (
    <div className="mt-2 space-y-2">
      {blockers.length > 0 ? (
        <section className="rounded-md border border-amber-300 bg-amber-50 p-2 dark:border-amber-800 dark:bg-amber-950/30">
          <p className="font-semibold text-amber-900 dark:text-amber-100">
            Queda {blockers.length} decisión
            {blockers.length === 1 ? "" : "es"} necesaria
            {blockers.length === 1 ? "" : "s"}
          </p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-amber-800 dark:text-amber-200">
            {blockers.map((gap) => (
              <li key={gap.id}>{gap.summary}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {safeDefaults?.length ? (
        <section className="rounded-md border border-emerald-200 bg-emerald-50 p-2 dark:border-emerald-900 dark:bg-emerald-950/20">
          <p className="font-medium text-emerald-900 dark:text-emerald-100">
            Valores seguros disponibles
          </p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-emerald-800 dark:text-emerald-200">
            {safeDefaults.map((entry) => (
              <li key={entry.gap_id}>
                {entry.summary}: {entry.value}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function CapabilityNeeds({
  needs,
}: {
  needs: readonly AuthoringCapabilityNeed[] | undefined;
}) {
  if (!needs?.length) return null;
  const uniqueNeeds = [
    ...new Map(
      needs.map((need) => [
        `${need.category_id}:${need.provider_id ?? "unresolved"}`,
        need,
      ])
    ).values(),
  ];
  const statusLabel: Record<AuthoringCapabilityNeed["status"], string> = {
    connected: "Conectada",
    supported_not_connected: "Disponible; falta conectar",
    catalog_only: "Opción de catálogo; integración pendiente",
    unresolved: "Por elegir",
  };
  return (
    <div className="mt-2">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
        Herramientas para ejecutar
      </p>
      <div className="mt-1 flex flex-wrap gap-1.5">
        {uniqueNeeds.map((need) => (
          <span
            key={`${need.category_id}:${need.provider_id ?? "unresolved"}`}
            className="inline-flex items-center gap-1 rounded-full border border-violet-200 bg-white px-2 py-1 text-[11px] text-violet-900 dark:border-violet-800 dark:bg-neutral-950 dark:text-violet-100"
          >
            <span>
              {need.provider_name ?? need.category_label} —{" "}
              {statusLabel[need.status]}
            </span>
            {need.connect_href ? (
              <a
                href={need.connect_href}
                className="font-semibold underline underline-offset-2"
              >
                Conectar
              </a>
            ) : null}
          </span>
        ))}
      </div>
      {uniqueNeeds.some((need) => need.resolution === "manual_fallback") ? (
        <p className="mt-1 text-[11px] text-neutral-500 dark:text-neutral-400">
          Gu preparará un resultado para uso manual mientras se evalúa una
          integración gobernada.
        </p>
      ) : null}
    </div>
  );
}

function ProposalSemanticReview({ review }: { review: DiscoveryReview }) {
  const channels =
    review.invocation_channels?.length
      ? review.invocation_channels
      : [
          {
            channel: "web_chat" as const,
            label: "Web Chat",
            availability: "available" as const,
            supports_text: true,
            supports_generic_attachments: true,
            limitations: [],
          },
        ];
  const runtimeInputs = (review.input_requirements ?? []).filter(
    isPerExecutionInputRequirement
  );
  const accountAssets = (review.input_requirements ?? []).filter(
    (requirement) => requirement.kind === "account_asset"
  );
  const gmailOutput = review.capability_needs?.some(
    (need) => need.provider_id === "gmail"
  );

  return (
    <div className="space-y-3">
      <section>
        <p className="text-[10px] font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
          Disponible desde
        </p>
        <ul className="mt-1 space-y-1 text-neutral-700 dark:text-neutral-200">
          {channels.map((channel) => (
            <li key={channel.channel}>
              <span className="font-medium">{channel.label}</span>
              {" · "}
              {channel.supports_text ? "texto" : "sin texto"}
              {" · "}
              {channel.supports_generic_attachments
                ? "archivos compatibles"
                : "archivos con soporte limitado"}
              {channel.limitations.length > 0 ? (
                <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
                  {channel.limitations.join(" ")}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <p className="text-[10px] font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
          Entradas por ejecución
        </p>
        {runtimeInputs.length > 0 ? (
          <ul className="mt-1 list-disc space-y-1 pl-4 text-neutral-700 dark:text-neutral-200">
            {runtimeInputs.map((requirement) => (
              <li key={`${requirement.kind}:${requirement.key}`}>
                {requirement.label}
                {requirement.source_hint === "chat_attachment"
                  ? " · se adjunta en el chat"
                  : ""}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-neutral-500">
            No se detectaron entradas por ejecución.
          </p>
        )}
        {accountAssets.length > 0 ? (
          <p className="mt-1 text-[11px] text-neutral-500 dark:text-neutral-400">
            Recursos reutilizables de cuenta:{" "}
            {accountAssets.map((item) => item.label).join(", ")}.
          </p>
        ) : null}
      </section>

      <CapabilityNeeds needs={review.capability_needs} />

      <section>
        <p className="text-[10px] font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
          Efectos externos
        </p>
        {review.understanding.effects.length > 0 ? (
          <ul className="mt-1 list-disc space-y-1 pl-4 text-neutral-700 dark:text-neutral-200">
            {review.understanding.effects.map((effect) => (
              <li key={effect}>{effect}</li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-neutral-500">No se declararon efectos externos.</p>
        )}
        {gmailOutput &&
        runtimeInputs.some((input) => input.kind === "runtime_input") ? (
          <p className="mt-1 text-[11px] text-neutral-500 dark:text-neutral-400">
            Los documentos fuente son evidencia o referencia. No se adjuntan ni
            se copian al cuerpo del email salvo que lo pidas.
          </p>
        ) : null}
      </section>
    </div>
  );
}

export function CompileForm({ knownCaseTypes }: { knownCaseTypes: string[] }) {
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [description, setDescription] = useState("");
  const [caseTypeHint, setCaseTypeHint] = useState("");
  const [pending, setPending] = useState(false);
  const [pendingAction, setPendingAction] = useState<AuthoringAction | null>(
    null
  );
  const [progress, setProgress] = useState<ProgressEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [questions, setQuestions] = useState<string[]>([]);
  const [composer, setComposer] = useState("");
  const [phase, setPhase] = useState<ConversationPhase>("intake");
  const [proposedKind, setProposedKind] = useState<WorkForm | null>(null);
  const [skillSubtype, setSkillSubtype] = useState<string | null>(null);
  const [review, setReview] = useState<DiscoveryReview | null>(null);
  const [confirmationHash, setConfirmationHash] = useState<string | null>(null);
  const [thread, setThread] = useState<AuthoringThreadMessage[]>([]);
  const [allowContinue, setAllowContinue] = useState(false);
  const [allowProceed, setAllowProceed] = useState(false);
  const [selectedDefaultGapIds, setSelectedDefaultGapIds] = useState<string[]>(
    []
  );
  const abortRef = useRef<AbortController | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const reviewRef = useRef<HTMLDivElement | null>(null);
  const threadEndRef = useRef<HTMLDivElement | null>(null);

  const inConversation = phase !== "intake";
  const awaitingConfirmation = phase === "proposal" && confirmationHash !== null;
  const showCaseTypeReuse = proposedKind === "case_workflow" && phase === "proposal";
  const pendingBlockers =
    review?.gap_plan?.gaps.filter(
      (gap) =>
        gap.severity === "blocking" &&
        gap.state !== "answered" &&
        gap.state !== "resolved_by_evidence" &&
        gap.state !== "defaulted"
    ) ?? [];
  const safeDefaults =
    review?.gap_plan?.gaps.flatMap((gap) =>
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
    ) ?? [];
  const canPrepareProposal = allowProceed && pendingBlockers.length === 0;

  const suggestedSlug = useMemo(
    () => (title.trim() ? suggestSlugFromTitle(title) : ""),
    [title]
  );
  const effectiveSlug = slugTouched ? slug : slug || suggestedSlug;
  const currentHumanStatus = authoringHumanStatus({
    phase,
    pendingAction,
    progress,
  });

  useEffect(() => {
    if (awaitingConfirmation) reviewRef.current?.focus();
  }, [awaitingConfirmation]);

  useEffect(() => {
    if (phase === "discovering" || phase === "checkpoint") {
      composerRef.current?.focus();
    }
  }, [phase, questions]);

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [thread, pending]);

  useEffect(() => {
    const currentParams = new URLSearchParams(window.location.search);
    const sid = currentParams.get("authoring_session");
    const gmailJustConnected = currentParams.get("gmail") === "connected";
    if (!sid || sessionId) return;
    const controller = new AbortController();
    void fetch(
      `/api/studio-authoring?sessionId=${encodeURIComponent(sid)}`,
      { signal: controller.signal }
    )
      .then(async (response) => {
        if (!response.ok) return null;
        return (await response.json()) as {
          id: string;
          status: string;
          description: string;
          title: string | null;
          suggestedSlug: string | null;
          routerKind: unknown;
          routerOutput: Record<string, unknown>;
          clarificationRound: number;
          messages: unknown[];
          progress: unknown[];
        };
      })
      .then((data) => {
        if (!data) return;
        setSessionId(data.id);
        setDescription(data.description);
        setTitle(data.title ?? "");
        setSlug(
          data.suggestedSlug && !isGenericAuthoringSlug(data.suggestedSlug)
            ? data.suggestedSlug
            : ""
        );
        setThread(
          hydrateAuthoringThread({
            description: data.description,
            messages: data.messages ?? [],
          }).map((message) =>
            gmailJustConnected && message.role === "gu"
              ? {
                  ...message,
                  capabilityNeeds: markProviderConnected(
                    message.capabilityNeeds,
                    "gmail"
                  ),
                }
              : message
          )
        );
        setProgress(
          (data.progress ?? []).flatMap((entry) => {
            if (!entry || typeof entry !== "object") return [];
            const record = entry as Record<string, unknown>;
            if (
              typeof record.stage !== "string" ||
              typeof record.message !== "string"
            ) {
              return [];
            }
            return [
              {
                type: "stage" as const,
                stage: record.stage,
                message: record.message,
                ts:
                  typeof record.ts === "number"
                    ? record.ts
                    : Date.parse(String(record.ts)) || 0,
              },
            ];
          })
        );

        const conversation = data.routerOutput?.conversation as
          | {
              conversation_phase?: ConversationPhase;
              allow_continue?: boolean;
              allow_proceed_to_proposal?: boolean;
              pending_questions?: string[];
            }
          | undefined;
        const storedDiscovery = data.routerOutput?.discovery as
          | (DiscoveryReview & { readiness?: string; final_kind?: string })
          | undefined;
        const discovery =
          gmailJustConnected && storedDiscovery
            ? {
                ...storedDiscovery,
                capability_needs: markProviderConnected(
                  storedDiscovery.capability_needs,
                  "gmail"
                ),
              }
            : storedDiscovery;
        const hash = data.routerOutput?.discovery_hash;

        if (conversation?.conversation_phase) {
          setPhase(conversation.conversation_phase);
          setAllowContinue(Boolean(conversation.allow_continue));
          setAllowProceed(Boolean(conversation.allow_proceed_to_proposal));
          if (conversation.pending_questions?.length) {
            setQuestions(conversation.pending_questions);
          }
        }
        if (
          discovery &&
          (conversation?.conversation_phase === "checkpoint" ||
            conversation?.conversation_phase === "blocked")
        ) {
          setReview(discovery);
        }

        if (discovery && isWorkForm(discovery.final_kind)) {
          if (
            conversation?.conversation_phase === "proposal" ||
            discovery.readiness === "ready_for_confirmation"
          ) {
            setProposedKind(discovery.final_kind);
          }
        }
        if (typeof discovery?.skill_subtype === "string") {
          setSkillSubtype(discovery.skill_subtype);
        }

        if (
          discovery?.understanding &&
          discovery.readiness === "ready_for_confirmation" &&
          typeof hash === "string"
        ) {
          setReview(discovery);
          setConfirmationHash(hash);
          setPhase("proposal");
        }

        if (
          data.status === "clarifying" &&
          conversation?.conversation_phase !== "checkpoint" &&
          conversation?.conversation_phase !== "blocked"
        ) {
          const lastQuestion = [...(data.messages ?? [])]
            .reverse()
            .find(
              (message): message is { questions: string[] } =>
                !!message &&
                typeof message === "object" &&
                Array.isArray((message as { questions?: unknown }).questions)
            );
          if (lastQuestion) {
            setQuestions(lastQuestion.questions);
            setPhase("discovering");
          }
        }
      })
      .catch((loadError) => {
        if (
          !(loadError instanceof DOMException && loadError.name === "AbortError")
        ) {
          setError("No se pudo reanudar la sesión de autoría.");
        }
      });
    return () => controller.abort();
  }, [sessionId]);

  async function runAuthoring(opts: {
    action: AuthoringAction;
    clarificationAnswers?: string[];
    proposalCorrection?: string;
    defaultGapIds?: string[];
  }) {
    abortRef.current?.abort();
    const abortController = new AbortController();
    abortRef.current = abortController;
    setPending(true);
    setPendingAction(opts.action);
    setError(null);
    setProgress([]);
    const baseConfirmationHash = confirmationHash;

    if (opts.action === "discover") {
      setProposedKind(null);
      setSkillSubtype(null);
      setReview(null);
      setConfirmationHash(null);
      setAllowContinue(false);
      setAllowProceed(false);
      setSelectedDefaultGapIds([]);
      setQuestions([]);
      setPhase("discovering");
      setThread([
        {
          id: nextMessageId("desc"),
          role: "user",
          kind: "description",
          text: description.trim(),
        },
      ]);
    }

    const body: Record<string, unknown> = {
      action: opts.action,
      description: description.trim(),
      title: title.trim() || undefined,
      slug: (caseTypeHint.trim() || effectiveSlug || undefined)?.replace(
        /-/g,
        "_"
      ),
      sessionId: sessionId ?? undefined,
    };
    if (opts.action === "confirm" || opts.action === "revise_proposal") {
      body.confirmationHash = baseConfirmationHash;
    }
    if (opts.action === "revise_proposal") {
      body.proposalCorrection = opts.proposalCorrection;
      setConfirmationHash(null);
    }
    if (opts.clarificationAnswers?.length) {
      body.answers = opts.clarificationAnswers;
    }
    if (opts.defaultGapIds?.length) {
      body.defaultGapIds = opts.defaultGapIds;
    }

    try {
      const res = await fetch("/api/studio-authoring", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: abortController.signal,
      });
      const contentType = res.headers.get("content-type") ?? "";
      if (!res.ok && !contentType.includes("application/x-ndjson")) {
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        setError(data.error ?? "No se pudo iniciar la autoría.");
        if (opts.action === "revise_proposal") {
          setConfirmationHash(baseConfirmationHash);
        }
        return;
      }
      if (!res.body || !contentType.includes("application/x-ndjson")) {
        setError("Respuesta de autoría inesperada (sin stream).");
        if (opts.action === "revise_proposal") {
          setConfirmationHash(baseConfirmationHash);
        }
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let redirectPath: string | null = null;

      const handleEvent = (
        event: ProgressEvent | { type: "error"; error: string; details?: string }
      ) => {
        if (event.type === "error") {
          setError(
            event.details ? `${event.error}: ${event.details}` : event.error
          );
          setQuestions([]);
          if (opts.action === "revise_proposal") {
            setConfirmationHash(baseConfirmationHash);
          }
          return;
        }
        setProgress((prev) => [...prev, event]);
        const payload = event.payload ?? {};
        const conversation = payload.conversation as
          | {
              allow_continue?: boolean;
              allow_proceed_to_proposal?: boolean;
              pending_questions?: string[];
              human_message?: string;
            }
          | undefined;

        if (event.stage === "session_ready") {
          const sid = payload.sessionId;
          if (typeof sid === "string") {
            setSessionId(sid);
            const url = new URL(window.location.href);
            url.searchParams.set("authoring_session", sid);
            window.history.replaceState({}, "", url);
          }
          const serverSlug = payload.suggested_slug;
          if (
            typeof serverSlug === "string" &&
            serverSlug &&
            !slugTouched &&
            !slug &&
            !isGenericAuthoringSlug(serverSlug)
          ) {
            setSlug(serverSlug);
          }
        }

        if (event.stage === "discovery_ready" || event.stage === "review_ready") {
          const discovery = payload.discovery as DiscoveryReview | undefined;
          if (discovery?.suggested_title && !title.trim()) {
            setTitle(discovery.suggested_title);
          }
          if (
            discovery?.suggested_slug &&
            !slugTouched &&
            !isGenericAuthoringSlug(discovery.suggested_slug)
          ) {
            setSlug(discovery.suggested_slug);
          }
          if (typeof discovery?.skill_subtype === "string") {
            setSkillSubtype(discovery.skill_subtype);
          }
        }

        if (event.stage === "clarifying") {
          const qs = Array.isArray(payload.questions)
            ? payload.questions.filter(
                (q): q is string => typeof q === "string" && q.trim().length > 0
              )
            : [];
          const questionDetails = parseQuestionDetails(payload.questionDetails);
          setQuestions(qs);
          setPhase("discovering");
          setAllowContinue(false);
          setAllowProceed(false);
          setSelectedDefaultGapIds([]);
          setReview(null);
          setConfirmationHash(null);
          setThread((prev) => [
            ...prev,
            {
              id: nextMessageId("q"),
              role: "gu",
              kind: "questions",
              text:
                typeof event.message === "string" && event.message
                  ? event.message
                  : "Para preparar un borrador seguro, necesito aclarar:",
              questions: qs,
              questionDetails,
            },
          ]);
          if (typeof payload.sessionId === "string") {
            setSessionId(payload.sessionId);
          }
        }

        if (event.stage === "checkpoint") {
          const discovery = payload.discovery as DiscoveryReview | undefined;
          const qs = Array.isArray(payload.questions)
            ? payload.questions.filter(
                (q): q is string => typeof q === "string" && q.trim().length > 0
              )
            : conversation?.pending_questions ?? [];
          const questionDetails = parseQuestionDetails(payload.questionDetails);
          setPhase("checkpoint");
          setQuestions(qs);
          setAllowContinue(Boolean(conversation?.allow_continue ?? qs.length > 0));
          setAllowProceed(Boolean(conversation?.allow_proceed_to_proposal));
          setSelectedDefaultGapIds([]);
          if (discovery) setReview(discovery);
          setThread((prev) => [
            ...prev,
            {
              id: nextMessageId("checkpoint"),
              role: "gu",
              kind: "checkpoint",
              text:
                event.message ||
                conversation?.human_message ||
                "¿Seguimos aclarando o preparo la propuesta con lo entendido?",
              questions: qs,
              questionDetails,
              understanding: discovery?.understanding,
              capabilityNeeds: discovery?.capability_needs,
              ...gapPresentationFromReview(discovery),
            },
          ]);
        }

        if (event.stage === "blocked") {
          const discovery = payload.discovery as DiscoveryReview | undefined;
          setPhase("blocked");
          setQuestions([]);
          setAllowContinue(Boolean(conversation?.allow_continue));
          setAllowProceed(false);
          setSelectedDefaultGapIds([]);
          if (discovery) setReview(discovery);
          setThread((prev) => [
            ...prev,
            {
              id: nextMessageId("blocked"),
              role: "gu",
              kind: "blocked",
              text:
                conversation?.human_message ||
                event.message ||
                "Aún faltan datos materiales. Reformula la solicitud.",
              understanding: discovery?.understanding,
              ...gapPresentationFromReview(discovery),
            },
          ]);
        }

        if (event.stage === "review_ready") {
          const value = payload.discovery as DiscoveryReview | undefined;
          const hash = payload.confirmationHash;
          if (value?.understanding && typeof hash === "string") {
            setReview(value);
            setConfirmationHash(hash);
            setQuestions([]);
            setPhase("proposal");
            setAllowContinue(false);
            setAllowProceed(false);
            setSelectedDefaultGapIds([]);
            if (isWorkForm(value.final_kind)) {
              setProposedKind(value.final_kind);
            }
            setThread((prev) => [
              ...prev,
              {
                id: nextMessageId("proposal"),
                role: "gu",
                kind: "proposal",
                text: "Esto entendí. Confirma antes de crear el borrador.",
                understanding: value.understanding,
                capabilityNeeds: value.capability_needs,
              },
            ]);
          }
        }

        if (event.stage === "redirect") {
          if (typeof payload.path === "string" && payload.path) {
            redirectPath = payload.path;
          }
        }

        if (event.stage === "done") {
          if (
            payload.awaiting !== "clarification" &&
            payload.awaiting !== "checkpoint" &&
            typeof payload.path === "string" &&
            payload.path
          ) {
            redirectPath = payload.path;
          }
          if (
            payload.awaiting !== "clarification" &&
            payload.awaiting !== "checkpoint"
          ) {
            // Keep questions only while discovery continues.
          }
        }
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          handleEvent(
            JSON.parse(trimmed) as
              | ProgressEvent
              | { type: "error"; error: string }
          );
        }
      }
      if (buffer.trim()) {
        handleEvent(
          JSON.parse(buffer.trim()) as
            | ProgressEvent
            | { type: "error"; error: string }
        );
      }

      if (redirectPath) {
        window.location.href = redirectPath;
        return;
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        if (opts.action === "revise_proposal") {
          setConfirmationHash(baseConfirmationHash);
        }
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
      if (opts.action === "revise_proposal") {
        setConfirmationHash(baseConfirmationHash);
      }
    } finally {
      if (abortRef.current === abortController) {
        abortRef.current = null;
        setPending(false);
        setPendingAction(null);
      }
    }
  }

  function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (pending) return;

    if (phase === "intake") {
      if (!description.trim()) {
        setError("Describe qué quieres construir.");
        return;
      }
      void runAuthoring({ action: "discover" });
      return;
    }

    if (phase === "discovering") {
      const answer = composer.trim();
      if (!answer) {
        setError("Escribe tu respuesta antes de continuar.");
        return;
      }
      setThread((prev) => [
        ...prev,
        {
          id: nextMessageId("answer"),
          role: "user",
          kind: "answer",
          text: answer,
        },
      ]);
      setComposer("");
      void runAuthoring({
        action: "answer",
        clarificationAnswers: [answer],
      });
      return;
    }

    if (phase === "proposal") {
      void runAuthoring({ action: "confirm" });
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-3 rounded-2xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900"
    >
      <div>
        <h3 className="text-sm font-semibold">Describir algo nuevo</h3>
        <p className="mt-0.5 text-xs text-neutral-500">
          Describe en tus palabras qué necesitas. Gu hará preguntas solo cuando
          falte contexto material y te pedirá confirmación antes de crear
          cualquier borrador.
        </p>
      </div>

      {!inConversation ? (
        <>
          <label className="block text-xs">
            <span className="font-medium text-neutral-600 dark:text-neutral-300">
              Título
            </span>
            <input
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                if (!slugTouched) setSlug(suggestSlugFromTitle(e.target.value));
              }}
              placeholder="p. ej. Seguimiento a propietarios"
              className="mt-1 w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-xs dark:border-neutral-700 dark:bg-neutral-950"
            />
          </label>

          <details className="rounded-lg border border-neutral-200 px-3 py-2 text-xs dark:border-neutral-800">
            <summary className="cursor-pointer font-medium text-neutral-600 dark:text-neutral-300">
              Opciones avanzadas
            </summary>
            <label className="mt-2 block">
              <span className="font-medium text-neutral-600 dark:text-neutral-300">
                Identificador (inglés, opcional)
              </span>
              <input
                value={effectiveSlug}
                onChange={(e) => {
                  setSlugTouched(true);
                  setSlug(
                    e.target.value
                      .toLowerCase()
                      .replace(/[^a-z0-9_]+/g, "_")
                      .replace(/_+/g, "_")
                  );
                }}
                placeholder={suggestedSlug || "owner_followup_message"}
                className="mt-1 w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 font-mono text-xs dark:border-neutral-700 dark:bg-neutral-950"
              />
            </label>
            {knownCaseTypes.length > 0 ? (
              <label className="mt-2 block">
                <span className="font-medium text-neutral-600 dark:text-neutral-300">
                  Nueva versión de un flujo ya existente
                </span>
                <input
                  list="known-case-types"
                  value={caseTypeHint}
                  onChange={(e) => setCaseTypeHint(e.target.value)}
                  placeholder="p. ej. property_optioning"
                  className="mt-1 w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-xs dark:border-neutral-700 dark:bg-neutral-950"
                />
                <datalist id="known-case-types">
                  {knownCaseTypes.map((caseType) => (
                    <option key={caseType} value={caseType} />
                  ))}
                </datalist>
              </label>
            ) : null}
          </details>

          <label className="block text-xs">
            <span className="font-medium text-neutral-600 dark:text-neutral-300">
              Descripción
            </span>
            <textarea
              rows={5}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Cada vez que prepares un seguimiento para un propietario…"
              className="mt-1 w-full resize-y rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-xs whitespace-pre-wrap break-words dark:border-neutral-700 dark:bg-neutral-950"
            />
          </label>
        </>
      ) : null}

      {inConversation ? (
        <div
          className="max-h-[28rem] space-y-3 overflow-y-auto rounded-xl border border-neutral-200 bg-neutral-50 p-3 dark:border-neutral-800 dark:bg-neutral-950/40"
          aria-live="polite"
        >
          {thread.map((message) => (
            <div
              key={message.id}
              className={
                message.role === "user"
                  ? "ml-8 rounded-lg bg-white px-3 py-2 text-xs shadow-sm dark:bg-neutral-900"
                  : "mr-8 rounded-lg border border-violet-200 bg-violet-50 px-3 py-2 text-xs dark:border-violet-900 dark:bg-violet-950/30"
              }
            >
              <p className="text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
                {message.role === "user" ? "Tú" : "Gu"}
              </p>
              <p className="mt-1 whitespace-pre-wrap break-words text-neutral-800 dark:text-neutral-100">
                {message.text}
              </p>
              {message.role === "gu" && message.questions?.length ? (
                <ol className="mt-2 list-decimal space-y-1 pl-4 text-neutral-700 dark:text-neutral-200">
                  {message.questions.map((question) => {
                    const detail = message.questionDetails?.find(
                      (candidate) => candidate.question === question
                    );
                    return (
                      <li
                        key={question}
                        className="whitespace-pre-wrap break-words"
                      >
                        {question}
                        {detail?.examples.length ? (
                          <p className="mt-1 text-[11px] text-neutral-500 dark:text-neutral-400">
                            Por ejemplo: {detail.examples.join("; ")}. Puedes
                            responder de otra manera.
                          </p>
                        ) : null}
                      </li>
                    );
                  })}
                </ol>
              ) : null}
              {message.role === "gu" &&
              message.understanding &&
              (message.kind === "checkpoint" ||
                message.kind === "blocked") ? (
                <>
                  <UnderstandingLists
                    understanding={message.understanding}
                    omitGaps
                  />
                  <GapDecisionPanel
                    blockers={message.pendingBlockers ?? []}
                    safeDefaults={message.safeDefaults}
                  />
                  <CapabilityNeeds needs={message.capabilityNeeds} />
                </>
              ) : null}
            </div>
          ))}
          <div ref={threadEndRef} />
        </div>
      ) : null}

      {inConversation && currentHumanStatus ? (
        <div
          className="flex items-center gap-2 rounded-lg border border-violet-200 bg-violet-50 px-3 py-2 text-xs text-violet-900 dark:border-violet-900 dark:bg-violet-950/30 dark:text-violet-100"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {pending ? (
            <span
              className="h-3 w-3 animate-spin rounded-full border-2 border-violet-300 border-t-violet-700 dark:border-violet-700 dark:border-t-violet-200"
              aria-hidden="true"
            />
          ) : null}
          {currentHumanStatus}
        </div>
      ) : null}

      {phase === "proposal" && review ? (
        <div
          ref={reviewRef}
          tabIndex={-1}
          className="space-y-2 rounded-xl border border-violet-300 bg-violet-50 p-3 text-xs outline-none dark:border-violet-800 dark:bg-violet-950/30"
        >
          <p className="font-semibold text-violet-900 dark:text-violet-100">
            Propuesta lista para confirmar
          </p>
          {proposedKind ? (
            <p className="text-[11px] text-violet-800 dark:text-violet-200">
              Forma propuesta: {workFormLabelFromKind(proposedKind)}
              {proposedKind === "reusable_skill" && skillSubtype
                ? ` · ${skillSubtype}`
                : ""}
            </p>
          ) : null}
          <section className="rounded-lg border border-violet-200 bg-white/70 p-2 dark:border-violet-900 dark:bg-neutral-950/40">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
              Lo que entendí
            </p>
            <UnderstandingLists
              understanding={review.understanding}
              omitSemanticSurfaces
            />
          </section>
          <section className="rounded-lg border border-violet-200 bg-white/70 p-2 dark:border-violet-900 dark:bg-neutral-950/40">
            <ProposalSemanticReview review={review} />
          </section>
          {showCaseTypeReuse ? (
            <label className="block">
              <span className="font-medium">
                Nueva versión de un flujo ya existente (opcional)
              </span>
              <input
                list="known-case-types-proposal"
                value={caseTypeHint}
                onChange={(e) => setCaseTypeHint(e.target.value)}
                className="mt-1 w-full rounded-md border border-violet-300 bg-white px-2 py-1.5 dark:border-violet-700 dark:bg-neutral-950"
              />
              <datalist id="known-case-types-proposal">
                {knownCaseTypes.map((caseType) => (
                  <option key={caseType} value={caseType} />
                ))}
              </datalist>
            </label>
          ) : null}
          <details className="rounded-md border border-violet-200 px-2 py-1 dark:border-violet-900">
            <summary className="cursor-pointer font-medium">
              Ajustar título o identificador
            </summary>
            <label className="mt-2 block">
              Título
              <input
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value);
                  if (!slugTouched) setSlug(suggestSlugFromTitle(e.target.value));
                }}
                className="mt-1 w-full rounded-md border border-violet-300 bg-white px-2 py-1.5 dark:border-violet-700 dark:bg-neutral-950"
              />
            </label>
            <label className="mt-2 block">
              Identificador
              <input
                value={effectiveSlug}
                onChange={(e) => {
                  setSlugTouched(true);
                  setSlug(
                    e.target.value
                      .toLowerCase()
                      .replace(/[^a-z0-9_]+/g, "_")
                      .replace(/_+/g, "_")
                  );
                }}
                className="mt-1 w-full rounded-md border border-violet-300 bg-white px-2 py-1.5 font-mono dark:border-violet-700 dark:bg-neutral-950"
              />
            </label>
          </details>
        </div>
      ) : null}

      {phase === "checkpoint" ? (
        <div className="space-y-2">
          <GapDecisionPanel
            blockers={pendingBlockers}
            safeDefaults={safeDefaults}
          />
          {safeDefaults.length > 0 ? (
            <fieldset className="space-y-1 rounded-md border border-emerald-200 p-2 text-xs dark:border-emerald-900">
              <legend className="px-1 font-medium">
                Aplicar valores seguros al preparar la propuesta
              </legend>
              {safeDefaults.map((entry) => (
                <label key={entry.gap_id} className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={selectedDefaultGapIds.includes(entry.gap_id)}
                    onChange={(event) =>
                      setSelectedDefaultGapIds((current) =>
                        event.target.checked
                          ? [...new Set([...current, entry.gap_id])]
                          : current.filter((gapId) => gapId !== entry.gap_id)
                      )
                    }
                  />
                  <span>
                    {entry.summary}: <strong>{entry.value}</strong>
                  </span>
                </label>
              ))}
            </fieldset>
          ) : null}
          <div className="flex flex-wrap gap-2">
          {allowContinue ? (
            <button
              type="button"
              disabled={pending}
              onClick={() => void runAuthoring({ action: "continue_discovery" })}
              className="rounded-md border border-violet-300 bg-white px-3 py-1.5 text-xs font-semibold text-violet-800 hover:bg-violet-50 disabled:opacity-50 dark:border-violet-700 dark:bg-neutral-950 dark:text-violet-200"
            >
              Seguir aclarando
            </button>
          ) : null}
          <button
            type="button"
            disabled={pending || !canPrepareProposal}
            onClick={() =>
              void runAuthoring({
                action: "proceed_to_proposal",
                defaultGapIds: selectedDefaultGapIds,
              })
            }
            className="rounded-md bg-violet-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-800 disabled:opacity-50"
          >
            Preparar propuesta con lo entendido
          </button>
          {!canPrepareProposal ? (
            <p className="w-full text-xs text-amber-700 dark:text-amber-300">
              {pendingBlockers.length > 0
                ? `Queda ${pendingBlockers.length} decisión${
                    pendingBlockers.length === 1 ? "" : "es"
                  } necesaria${
                    pendingBlockers.length === 1 ? "" : "s"
                  }. Sigue aclarando para preparar la propuesta.`
                : "Todavía no hay una forma de trabajo suficientemente clara. Sigue aclarando o reformula la descripción."}
            </p>
          ) : null}
          </div>
        </div>
      ) : null}

      {phase === "blocked" ? (
        <p className="rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          No fue posible cerrar ambigüedades materiales. Reformula la descripción
          incorporando lo ya aclarado e inicia de nuevo.
        </p>
      ) : null}

      {phase === "discovering" && !pending ? (
        <label className="block text-xs">
          <span className="font-medium text-neutral-600 dark:text-neutral-300">
            Tu respuesta
          </span>
          <textarea
            ref={composerRef}
            rows={4}
            value={composer}
            onChange={(e) => setComposer(e.target.value)}
            placeholder={
              questions.length > 1
                ? "Puedes responder varias preguntas en un solo mensaje…"
                : "Escribe tu respuesta…"
            }
            className="mt-1 w-full resize-y rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-xs whitespace-pre-wrap break-words dark:border-neutral-700 dark:bg-neutral-950"
            disabled={pending}
          />
        </label>
      ) : null}

      {phase === "proposal" && !pending ? (
        <div className="space-y-2 rounded-lg border border-neutral-200 p-3 text-xs dark:border-neutral-800">
          <label className="block">
            <span className="font-medium text-neutral-600 dark:text-neutral-300">
              Ajustar la propuesta
            </span>
            <textarea
              ref={composerRef}
              rows={3}
              value={composer}
              onChange={(e) => setComposer(e.target.value)}
              placeholder="Ejemplo: el documento se adjunta en cada ejecución; no es una plantilla permanente."
              className="mt-1 w-full resize-y rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-xs whitespace-pre-wrap break-words dark:border-neutral-700 dark:bg-neutral-950"
            />
          </label>
          <button
            type="button"
            disabled={!composer.trim() || !confirmationHash}
            onClick={() => {
              const correction = composer.trim();
              if (!correction) {
                setError("Escribe el ajuste antes de enviarlo.");
                return;
              }
              setThread((prev) => [
                ...prev,
                {
                  id: nextMessageId("correction"),
                  role: "user",
                  kind: "correction",
                  text: correction,
                },
              ]);
              setComposer("");
              void runAuthoring({
                action: "revise_proposal",
                proposalCorrection: correction,
              });
            }}
            className="rounded-md border border-violet-300 bg-white px-3 py-1.5 font-semibold text-violet-800 hover:bg-violet-50 disabled:opacity-50 dark:border-violet-700 dark:bg-neutral-950 dark:text-violet-200"
          >
            Enviar ajuste
          </button>
          <p className="text-[10px] text-neutral-500">
            El botón «Crear borrador» sigue siendo la confirmación canónica. Un
            texto aquí solo corrige la propuesta.
          </p>
        </div>
      ) : null}

      {error ? (
        <p className="rounded-md bg-red-50 px-2 py-1.5 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        {!pending &&
        (phase === "intake" ||
          phase === "discovering" ||
          phase === "proposal") ? (
          <button
            type="submit"
            disabled={
              phase === "proposal" &&
              (!confirmationHash || composer.trim().length > 0)
            }
            title={
              phase === "proposal" && composer.trim().length > 0
                ? "Envía o borra el ajuste antes de crear el borrador."
                : undefined
            }
            className="rounded-md bg-violet-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-800 disabled:opacity-50"
          >
            {phase === "discovering"
              ? "Enviar respuesta"
              : phase === "proposal"
                ? "Crear borrador"
                : "Analizar solicitud"}
          </button>
        ) : null}
        {pending ? (
          <button
            type="button"
            onClick={() => {
              abortRef.current?.abort();
              setThread((prev) => [
                ...prev,
                {
                  id: nextMessageId("stopped"),
                  role: "gu",
                  kind: "status",
                  text: "Análisis detenido. Puedes escribir una corrección o continuar cuando estés listo.",
                },
              ]);
            }}
            className="rounded-md border border-red-300 px-3 py-1.5 text-xs text-red-700 dark:border-red-800 dark:text-red-300"
          >
            Detener análisis
          </button>
        ) : null}
        {inConversation && !pending ? (
          <button
            type="button"
            onClick={() => {
              setPhase("intake");
              setThread([]);
              setQuestions([]);
              setReview(null);
              setConfirmationHash(null);
              setSessionId(null);
              setComposer("");
              setError(null);
              const url = new URL(window.location.href);
              url.searchParams.delete("authoring_session");
              window.history.replaceState({}, "", url);
            }}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs dark:border-neutral-700"
          >
            Empezar de nuevo
          </button>
        ) : null}
      </div>

      <div>
        {progress.length > 0 ? (
          <details className="rounded-md border border-neutral-200 bg-neutral-50 p-2 text-[10px] dark:border-neutral-800 dark:bg-neutral-950">
            <summary className="cursor-pointer font-medium">
              Ver detalles técnicos
            </summary>
            <div className="mt-1 max-h-40 space-y-1 overflow-y-auto">
              {progress.map((event, index) => (
                <p
                  key={`${event.ts}-${index}`}
                  className="text-neutral-600 dark:text-neutral-300"
                >
                  {event.message}
                  {" · "}
                  <span className="font-mono text-neutral-400">
                    {formatAuthoringTechnicalProgress(event).split(" · ").at(-1)}
                  </span>
                </p>
              ))}
            </div>
          </details>
        ) : null}
      </div>
    </form>
  );
}
