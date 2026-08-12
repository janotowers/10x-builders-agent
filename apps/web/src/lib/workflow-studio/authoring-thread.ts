/**
 * Helpers puros para el hilo conversacional de Studio authoring.
 */
import {
  answerBodyFromClarification,
  authoringCapabilityNeedSchema,
  authoringClarifyingQuestionSchema,
  authoringGapPlanSchema,
  authoringInvocationChannelSchema,
  inputRequirementSchema,
  parseAuthoringRouterOutput,
  type AuthoringCapabilityNeed,
  type AuthoringClarifyingQuestion,
  type AuthoringDiscoveryCompactState,
  type AuthoringDiscoveryOutput,
  type AuthoringInvocationChannel,
  type AuthoringOutboundContract,
  type AuthoringGap,
  type InputRequirement,
  type AuthoringRouterOutput,
} from "@agents/workflows";

export type AuthoringDiscoveryFailureClass =
  | "provider_contract_retryable"
  | "material_validation_failed"
  | "internal_error";

export type StoredAuthoringRouterResult = AuthoringRouterOutput & {
  modelId: string | null;
  source: "deterministic" | "model" | "fail_closed";
};

export function readStoredAuthoringRouterResult(
  routerOutput: Record<string, unknown> | null | undefined
): StoredAuthoringRouterResult | null {
  const parsed = parseAuthoringRouterOutput(routerOutput?.router);
  if (!parsed) return null;
  const stored = routerOutput?.router as Record<string, unknown>;
  return {
    ...parsed,
    modelId: typeof stored.modelId === "string" ? stored.modelId : null,
    source:
      stored.source === "deterministic" ||
      stored.source === "model" ||
      stored.source === "fail_closed"
        ? stored.source
        : "model",
  };
}

export const RETRYABLE_DISCOVERY_COPY =
  "No pude completar el análisis después de los intentos automáticos disponibles. Puedes reintentarlo manualmente; no se creó ningún borrador ni se consumió una ronda.";

export function readAuthoringDiscoveryFailureClass(
  value: unknown
): AuthoringDiscoveryFailureClass | null {
  return value === "provider_contract_retryable" ||
    value === "material_validation_failed" ||
    value === "internal_error"
    ? value
    : null;
}

export function isRetryableAuthoringDiscoveryFailure(
  failureClass: unknown
): failureClass is "provider_contract_retryable" | "internal_error" {
  return (
    failureClass === "provider_contract_retryable" ||
    failureClass === "internal_error"
  );
}

export function authoringFailureOutcome(failureClass: unknown): {
  retryable: boolean;
  awaiting: "retry_discovery" | "reformulate";
  humanCopy: string | null;
  hideHumanBlockers: boolean;
} {
  if (isRetryableAuthoringDiscoveryFailure(failureClass)) {
    return {
      retryable: true,
      awaiting: "retry_discovery",
      humanCopy: RETRYABLE_DISCOVERY_COPY,
      hideHumanBlockers: true,
    };
  }
  return {
    retryable: false,
    awaiting: "reformulate",
    humanCopy: null,
    hideHumanBlockers: false,
  };
}

export function shouldAppendAuthoringInputMessage(action: string): boolean {
  return action !== "retry_discovery";
}

export function authoringClarificationRoundIncrement(params: {
  action: string;
  answerCount: number;
}): number {
  return params.action === "retry_discovery" || params.answerCount === 0 ? 0 : 1;
}

export function selectAuthoringRetryCompactState(params: {
  lastValidCompact: AuthoringDiscoveryCompactState | null;
  currentCompact: AuthoringDiscoveryCompactState | null;
  failureClass: unknown;
}): AuthoringDiscoveryCompactState | null {
  return (
    params.lastValidCompact ??
    (isRetryableAuthoringDiscoveryFailure(params.failureClass)
      ? null
      : params.currentCompact)
  );
}

export function visibleAuthoringBlockers(
  gaps: readonly AuthoringGap[],
  failureClass?: AuthoringDiscoveryFailureClass | null
): AuthoringGap[] {
  if (isRetryableAuthoringDiscoveryFailure(failureClass)) return [];
  return gaps.filter(
    (gap) =>
      gap.severity === "blocking" &&
      gap.state !== "answered" &&
      gap.state !== "resolved_by_evidence" &&
      gap.state !== "defaulted"
  );
}

export type AuthoringUnderstanding = {
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

export type AuthoringThreadQuestionDetail = AuthoringClarifyingQuestion & {
  /** Campo estructural opcional hasta que el schema compartido lo exporte. */
  display_number?: number;
};

export type AuthoringThreadQuestionPresentation = {
  question: string;
  gapId?: string;
  displayNumber: number;
  examples: string[];
};

export type AuthoringThreadQuestionNumberingRegistry = {
  nextNumber: number;
  byGapId: Record<string, number>;
  byLegacyQuestion: Record<string, number>;
};

export type AuthoringThreadMessage =
  | {
      id: string;
      role: "user";
      kind: "description" | "answer" | "correction";
      text: string;
    }
  | {
      id: string;
      role: "gu";
      kind: "questions" | "checkpoint" | "proposal" | "blocked" | "status";
      text: string;
      questions?: string[];
      questionDetails?: AuthoringThreadQuestionDetail[];
      questionPresentations?: AuthoringThreadQuestionPresentation[];
      understanding?: AuthoringUnderstanding;
      capabilityNeeds?: AuthoringCapabilityNeed[];
      inputRequirements?: InputRequirement[];
      invocationChannels?: AuthoringInvocationChannel[];
      pendingBlockers?: AuthoringGap[];
      safeDefaults?: Array<{
        gap_id: string;
        summary: string;
        value: string;
      }>;
    };

export type SlugConflictPayload = {
  slug: string;
  status: string;
  version: number;
  updatedAt: string;
};

export function normalizeAuthoringSkillSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/_/g, "-")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}

export function resolveActiveSlugConflict(params: {
  slugConflict: SlugConflictPayload | null;
  effectiveSlug: string;
  suggestedSlug?: string | null;
}): SlugConflictPayload | null {
  const conflict = params.slugConflict;
  if (!conflict) return null;
  return normalizeAuthoringSkillSlug(
    params.effectiveSlug || params.suggestedSlug || ""
  ) === conflict.slug
    ? conflict
    : null;
}

export function reusableSkillConflictFromExisting(params: {
  finalKind: string;
  normalizedSlug: string;
  currentSessionId: string;
  existing: {
    studioAuthoringSessionId: string | null;
    status: string;
    version: number;
    updatedAt: string;
  } | null;
}): SlugConflictPayload | null {
  if (
    params.finalKind !== "reusable_skill" ||
    !params.normalizedSlug ||
    !params.existing ||
    params.existing.studioAuthoringSessionId === params.currentSessionId
  ) {
    return null;
  }
  return {
    slug: params.normalizedSlug,
    status: params.existing.status,
    version: params.existing.version,
    updatedAt: params.existing.updatedAt,
  };
}

const OUTBOUND_CAPABILITY_CATEGORIES = new Set([
  "user_email",
  "transactional_email",
  "messaging",
]);

export function requiresFinalSendConfirmation(params: {
  outboundContract?: Pick<AuthoringOutboundContract, "delivery"> | null;
  capabilityNeeds?: readonly AuthoringCapabilityNeed[] | null;
}): boolean {
  return (
    params.outboundContract?.delivery.mode === "after_approval" ||
    Boolean(
      params.capabilityNeeds?.some(
        (need) =>
          need.status === "connected" &&
          OUTBOUND_CAPABILITY_CATEGORIES.has(need.category_id)
      )
    )
  );
}

export type StructuredExternalEffect = {
  id: string;
  copy: string;
};

export function deriveStructuredExternalEffects(params: {
  requestedSideEffects: AuthoringDiscoveryOutput["requested_side_effects"];
  outboundContract?: Pick<AuthoringOutboundContract, "delivery"> | null;
  capabilityNeeds?: readonly AuthoringCapabilityNeed[] | null;
}): StructuredExternalEffect[] {
  const effects = new Set(params.requestedSideEffects);
  const provider =
    params.capabilityNeeds?.find(
      (need) =>
        OUTBOUND_CAPABILITY_CATEGORIES.has(need.category_id) &&
        need.status === "connected"
    )?.provider_name ?? null;
  const providerCopy = provider ? ` mediante ${provider}` : "";
  const result: StructuredExternalEffect[] = [];
  if (effects.has("send_message")) {
    result.push({
      id: `send_message:${params.outboundContract?.delivery.mode ?? "unknown"}`,
      copy:
        params.outboundContract?.delivery.mode === "after_approval"
          ? `Enviar el mensaje${providerCopy} al destinatario después de tu aprobación.`
          : `Enviar el mensaje${providerCopy} al destinatario.`,
    });
  }
  if (effects.has("schedule_recurrence")) {
    result.push({
      id: "schedule_recurrence",
      copy: "Programar ejecuciones recurrentes.",
    });
  }
  if (effects.has("external_write")) {
    result.push({
      id: "external_write",
      copy: "Escribir o actualizar un recurso externo.",
    });
  }
  if (effects.has("create_case")) {
    result.push({
      id: "create_case",
      copy: "Crear o abrir un caso operativo.",
    });
  }
  return result;
}

export function shouldAutoScrollAuthoringThread(
  previousLength: number,
  nextThread: readonly Pick<AuthoringThreadMessage, "role">[]
): boolean {
  return (
    nextThread.length > previousLength &&
    nextThread[nextThread.length - 1]?.role === "gu"
  );
}

function positiveDisplayNumber(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
    ? value
    : undefined;
}

function legacyQuestionKey(question: string): string {
  return question.replace(/\s+/g, " ").trim().toLocaleLowerCase("es");
}

export function readAuthoringThreadQuestionDetails(
  value: unknown
): AuthoringThreadQuestionDetail[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const parsed = authoringClarifyingQuestionSchema.safeParse(item);
    if (!parsed.success) return [];
    const displayNumber =
      item && typeof item === "object"
        ? positiveDisplayNumber(
            (item as Record<string, unknown>).display_number
          )
        : undefined;
    return [
      {
        ...parsed.data,
        ...(displayNumber === undefined
          ? {}
          : { display_number: displayNumber }),
      },
    ];
  });
}

export function createAuthoringThreadQuestionNumberingRegistry(): AuthoringThreadQuestionNumberingRegistry {
  return { nextNumber: 1, byGapId: {}, byLegacyQuestion: {} };
}

function seedPersistedQuestionNumbers(
  messages: readonly unknown[]
): AuthoringThreadQuestionNumberingRegistry {
  const registry = createAuthoringThreadQuestionNumberingRegistry();
  const used = new Set<number>();
  for (const raw of messages) {
    if (!raw || typeof raw !== "object") continue;
    const details = readAuthoringThreadQuestionDetails(
      (raw as Record<string, unknown>).question_details
    );
    for (const detail of details) {
      const displayNumber = positiveDisplayNumber(detail.display_number);
      if (displayNumber === undefined || used.has(displayNumber)) continue;
      const gapId = detail.gap_id?.trim();
      const legacyKey = legacyQuestionKey(detail.question);
      if (gapId) {
        if (registry.byGapId[gapId] !== undefined) continue;
        registry.byGapId[gapId] = displayNumber;
      } else {
        if (registry.byLegacyQuestion[legacyKey] !== undefined) continue;
        registry.byLegacyQuestion[legacyKey] = displayNumber;
      }
      used.add(displayNumber);
    }
  }
  return registry;
}

function nextAvailableDisplayNumber(
  registry: AuthoringThreadQuestionNumberingRegistry,
  used: Set<number>
): number {
  let candidate = Math.max(1, registry.nextNumber);
  while (used.has(candidate)) candidate += 1;
  registry.nextNumber = candidate + 1;
  return candidate;
}

/**
 * Vista numerada pura para live rendering. La identidad principal es gap_id;
 * para sesiones legacy se usa el texto normalizado como mejor esfuerzo.
 */
export function numberAuthoringThreadQuestions(params: {
  questions: readonly string[];
  questionDetails?: readonly AuthoringThreadQuestionDetail[];
  registry?: AuthoringThreadQuestionNumberingRegistry;
}): {
  presentations: AuthoringThreadQuestionPresentation[];
  registry: AuthoringThreadQuestionNumberingRegistry;
} {
  const source =
    params.registry ?? createAuthoringThreadQuestionNumberingRegistry();
  const registry: AuthoringThreadQuestionNumberingRegistry = {
    nextNumber: source.nextNumber,
    byGapId: { ...source.byGapId },
    byLegacyQuestion: { ...source.byLegacyQuestion },
  };
  const used = new Set([
    ...Object.values(registry.byGapId),
    ...Object.values(registry.byLegacyQuestion),
  ]);
  const presentations = params.questions.flatMap((rawQuestion) => {
    const question = rawQuestion.trim();
    if (!question) return [];
    const detail = params.questionDetails?.find(
      (candidate) => candidate.question === rawQuestion || candidate.question === question
    );
    const gapId = detail?.gap_id?.trim() || undefined;
    const legacyKey = legacyQuestionKey(question);
    let displayNumber = gapId
      ? registry.byGapId[gapId]
      : registry.byLegacyQuestion[legacyKey];
    if (displayNumber === undefined) {
      const persisted = positiveDisplayNumber(detail?.display_number);
      if (persisted !== undefined && !used.has(persisted)) {
        displayNumber = persisted;
        used.add(persisted);
        registry.nextNumber = Math.max(registry.nextNumber, persisted + 1);
      } else {
        displayNumber = nextAvailableDisplayNumber(registry, used);
        used.add(displayNumber);
      }
      if (gapId) registry.byGapId[gapId] = displayNumber;
      else registry.byLegacyQuestion[legacyKey] = displayNumber;
    }
    return [
      {
        question,
        gapId,
        displayNumber,
        examples: detail?.examples ?? [],
      },
    ];
  });
  return { presentations, registry };
}

export function authoringQuestionNumberingRegistryFromThread(
  thread: readonly AuthoringThreadMessage[]
): AuthoringThreadQuestionNumberingRegistry {
  const registry = createAuthoringThreadQuestionNumberingRegistry();
  for (const message of thread) {
    if (message.role !== "gu") continue;
    for (const presentation of message.questionPresentations ?? []) {
      const number = positiveDisplayNumber(presentation.displayNumber);
      if (number === undefined) continue;
      if (presentation.gapId) {
        registry.byGapId[presentation.gapId] ??= number;
      } else {
        registry.byLegacyQuestion[
          legacyQuestionKey(presentation.question)
        ] ??= number;
      }
      registry.nextNumber = Math.max(registry.nextNumber, number + 1);
    }
  }
  return registry;
}

function persistedHumanMessage(
  message: Record<string, unknown>
): string | undefined {
  return typeof message.human_message === "string" &&
    message.human_message.trim()
    ? message.human_message.trim()
    : undefined;
}

function asUnderstanding(value: unknown): AuthoringUnderstanding | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.objective !== "string") return undefined;
  const list = (key: string): string[] =>
    Array.isArray(record[key])
      ? record[key].filter(
          (item): item is string => typeof item === "string" && item.trim().length > 0
        )
      : [];
  return {
    objective: record.objective,
    sources: list("sources"),
    actors: list("actors"),
    decisions: list("decisions"),
    effects: list("effects"),
    capabilities: list("capabilities"),
    acceptance_criteria: list("acceptance_criteria"),
    assumptions: list("assumptions"),
    gaps: list("gaps"),
  };
}

function asCapabilityNeeds(value: unknown): AuthoringCapabilityNeed[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const parsed = authoringCapabilityNeedSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

function asInputRequirements(value: unknown): InputRequirement[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const parsed = inputRequirementSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

function asInvocationChannels(value: unknown): AuthoringInvocationChannel[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const parsed = authoringInvocationChannelSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

function asGapPresentation(
  message: Record<string, unknown>,
  failureClass?: AuthoringDiscoveryFailureClass | null
): {
  pendingBlockers: AuthoringGap[];
  safeDefaults: Array<{ gap_id: string; summary: string; value: string }>;
} {
  const plan = authoringGapPlanSchema.safeParse(message.gap_plan);
  const gaps = plan.success ? plan.data.gaps : [];
  const pendingBlockers = visibleAuthoringBlockers(gaps, failureClass);
  const safeDefaults = gaps.flatMap((gap) =>
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
  );
  return { pendingBlockers, safeDefaults };
}

export function hydrateAuthoringThread(params: {
  description: string;
  messages: unknown[];
  failureClass?: AuthoringDiscoveryFailureClass | null;
}): AuthoringThreadMessage[] {
  const thread: AuthoringThreadMessage[] = [];
  let numberingRegistry = seedPersistedQuestionNumbers(params.messages);
  if (params.description.trim()) {
    thread.push({
      id: "description",
      role: "user",
      kind: "description",
      text: params.description.trim(),
    });
  }
  for (const [index, raw] of params.messages.entries()) {
    if (!raw || typeof raw !== "object") continue;
    const message = raw as Record<string, unknown>;
    const role = message.role;
    if (
      (role === "discovery_question" || role === "compiler_clarify") &&
      Array.isArray(message.questions)
    ) {
      const questions = message.questions.filter(
        (item): item is string =>
          typeof item === "string" && item.trim().length > 0
      );
      if (questions.length === 0) continue;
      const questionDetails = readAuthoringThreadQuestionDetails(
        message.question_details
      );
      const numbered = numberAuthoringThreadQuestions({
        questions,
        questionDetails,
        registry: numberingRegistry,
      });
      numberingRegistry = numbered.registry;
      thread.push({
        id: `q-${index}`,
        role: "gu",
        kind: "questions",
        text:
          persistedHumanMessage(message) ??
          "Para preparar un borrador seguro, necesito aclarar:",
        questions,
        questionDetails,
        questionPresentations: numbered.presentations,
      });
    } else if (role === "user_answer" && typeof message.content === "string") {
      thread.push({
        id: `a-${index}`,
        role: "user",
        kind: "answer",
        text: answerBodyFromClarification(message.content),
      });
    } else if (
      role === "proposal_correction" &&
      typeof message.content === "string"
    ) {
      thread.push({
        id: `r-${index}`,
        role: "user",
        kind: "correction",
        text: message.content.trim(),
      });
    } else if (role === "discovery_checkpoint") {
      const questions = Array.isArray(message.questions)
        ? message.questions.filter(
            (item): item is string =>
              typeof item === "string" && item.trim().length > 0
          )
        : undefined;
      const questionDetails = readAuthoringThreadQuestionDetails(
        message.question_details
      );
      const numbered = numberAuthoringThreadQuestions({
        questions: questions ?? [],
        questionDetails,
        registry: numberingRegistry,
      });
      numberingRegistry = numbered.registry;
      const gapPresentation = asGapPresentation(message, params.failureClass);
      thread.push({
        id: `c-${index}`,
        role: "gu",
        kind: "checkpoint",
        text:
          persistedHumanMessage(message) ??
          (gapPresentation.pendingBlockers.length > 0
            ? `Queda ${gapPresentation.pendingBlockers.length} decisión${
                gapPresentation.pendingBlockers.length === 1 ? "" : "es"
              } necesaria${
                gapPresentation.pendingBlockers.length === 1 ? "" : "s"
              }.`
            : "Ya tengo bastante contexto. ¿Seguimos aclarando o preparo la propuesta?"),
        questions,
        questionDetails,
        questionPresentations: numbered.presentations,
        understanding: asUnderstanding(message.content),
        capabilityNeeds: asCapabilityNeeds(message.capability_needs),
        inputRequirements: asInputRequirements(message.input_requirements),
        invocationChannels: asInvocationChannels(message.invocation_channels),
        pendingBlockers: gapPresentation.pendingBlockers,
        safeDefaults: gapPresentation.safeDefaults,
      });
    } else if (role === "understanding_summary") {
      const understanding = asUnderstanding(message.content);
      if (!understanding) continue;
      thread.push({
        id: `p-${index}`,
        role: "gu",
        kind: "proposal",
        text:
          persistedHumanMessage(message) ??
          "Esto entendí. Confirma antes de crear el borrador.",
        understanding,
        capabilityNeeds: asCapabilityNeeds(message.capability_needs),
        inputRequirements: asInputRequirements(message.input_requirements),
        invocationChannels: asInvocationChannels(message.invocation_channels),
        ...asGapPresentation(message, params.failureClass),
      });
    }
  }
  return thread;
}

export type AuthoringProgressLike = {
  stage: string;
  message: string;
};

export function applyAuthoringRoundIntro<
  T extends { human_message?: string },
>(params: {
  phase: string;
  conversation: T;
  roundIntro?: string | null;
}): T {
  return params.phase === "discovering" && params.roundIntro
    ? { ...params.conversation, human_message: params.roundIntro }
    : params.conversation;
}

export function formatAuthoringTechnicalProgress(
  event: AuthoringProgressLike
): string {
  const stage =
    event.stage === "done" && /^Esperando\b/i.test(event.message)
      ? "esperando_entrada"
      : event.stage;
  return `${event.message} · ${stage}`;
}

export function authoringHumanStatus(params: {
  phase: string;
  pendingAction?: string | null;
  progress?: readonly AuthoringProgressLike[];
  failureClass?: AuthoringDiscoveryFailureClass | null;
}): string {
  if (params.pendingAction === "confirm") {
    return "Gu está creando el borrador…";
  }
  if (params.pendingAction === "revise_proposal") {
    return "Gu está aplicando tu ajuste a la propuesta…";
  }
  if (params.pendingAction === "answer") {
    return "Gu está analizando tu respuesta…";
  }
  if (params.pendingAction === "retry_discovery") {
    return "Gu está reintentando el análisis…";
  }
  if (params.pendingAction) {
    return "Gu está analizando la solicitud…";
  }
  if (isRetryableAuthoringDiscoveryFailure(params.failureClass)) {
    return RETRYABLE_DISCOVERY_COPY;
  }
  const latest = params.progress?.[params.progress.length - 1];
  if (latest?.message.trim()) return latest.message.trim();
  switch (params.phase) {
    case "discovering":
      return "Gu espera tu respuesta para continuar.";
    case "checkpoint":
      return "Elige si seguimos aclarando o preparamos la propuesta.";
    case "proposal":
      return "La propuesta está lista para revisar, ajustar o confirmar.";
    case "blocked":
      return "La sesión conserva lo aclarado, pero necesita una reformulación.";
    case "redirect":
      return "Esta solicitud continuará en el chat.";
    default:
      return "";
  }
}

export function shouldShowAuthoringStatusBar(params: {
  inConversation: boolean;
  status: string;
  phase: string;
  pending: boolean;
  retryableFailure: boolean;
}): boolean {
  return (
    params.inConversation &&
    Boolean(params.status.trim()) &&
    (params.phase !== "proposal" || params.pending) &&
    (!params.retryableFailure || params.pending)
  );
}

/** Separación UI: forma de trabajo ≠ estado conversacional. */
export function workFormLabelFromKind(
  kind: string | null | undefined
): string | null {
  switch (kind) {
    case "case_workflow":
      return "Flujo de caso";
    case "durable_task":
      return "Tarea durable";
    case "reusable_skill":
      return "Skill reusable";
    case "schedule":
      return "Programación";
    case "redirect_to_chat":
      return "Consulta en chat";
    default:
      return null;
  }
}
