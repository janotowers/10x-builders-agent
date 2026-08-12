import { ChatOpenAI } from "@langchain/openai";
import { createAiUsageCallbackHandler } from "./usage/ai-usage-meter";
import { openRouterClientConfiguration } from "./usage/openrouter-usage-capture";

/** Opciones runtime del modelo de chat. Se eligen en graph.ts según canal. */
export interface CreateChatModelOptions {
  /**
   * Temperatura del modelo.
   * - Interactivo (Web / Telegram): 0.2–0.3 da respuestas naturales.
   * - Cron (autoApproveTools=true): 0.0–0.1 prioriza determinismo y reduce las
   *   salidas tipo "intentaré luego" o "un momento, por favor" que el modelo
   *   tiende a producir cuando le baja la confianza.
   */
  temperature?: number;
  /** Optional model id override per channel (e.g. heartbeat). */
  modelName?: string;
  /** Optional max tokens override per channel. */
  maxTokens?: number;
}

/** Temperatura por defecto para interacciones normales (Web/Telegram). */
export const DEFAULT_INTERACTIVE_TEMPERATURE = 0.3;
/** Temperatura para el cron runner: más determinista y menos "narrativo". */
export const DEFAULT_CRON_TEMPERATURE = 0.1;
/** Temperatura para heartbeat: igual de determinista que cron. */
export const DEFAULT_HEARTBEAT_TEMPERATURE = 0.1;

/**
 * Default para max_tokens de salida cuando no hay `OPENROUTER_MAX_TOKENS` en el
 * entorno. Lo bajamos a 2048 para que la RESERVA de tokens que OpenRouter hace
 * contra tu saldo quepa incluso en cuentas con poco crédito (el error 402
 * "This request requires more credits, or fewer max_tokens" aparece cuando la
 * reserva supera el saldo, aunque la respuesta real fuese a ser mucho menor).
 */
export const DEFAULT_MAX_TOKENS = 2048;

/**
 * Defaults OpenRouter por rol. Los overrides viven en env (`*_MODEL_ID`).
 * Canonical inventory: docs/tools-design/model-providers.md §"Roles actuales".
 */
/** Default del modelo principal del agente (OpenRouter). */
export const DEFAULT_MAIN_AGENT_MODEL_ID = "openai/gpt-5.4-mini";
/** Default del modelo dedicado a compaction / memory flush. */
export const DEFAULT_COMPACTION_MODEL_ID = "anthropic/claude-haiku-4.5";
/** Default del selector pre-graph de skills (JSON estricto, temp 0). */
export const DEFAULT_SKILL_SELECTOR_MODEL_ID = "anthropic/claude-haiku-4.5";
/** Default del reviewer de Business Brain (Settings). */
export const DEFAULT_BUSINESS_BRAIN_REVIEWER_MODEL_ID =
  "anthropic/claude-haiku-4.5";
/**
 * Default del clasificador conversacional de casos (edge web/Telegram) y de la
 * 2ª opinión HITL en `unclear` (pending-decision-unclear-classifier).
 * Independiente del main agent; override con
 * `OPERATIONAL_CONVERSATION_CLASSIFIER_MODEL_ID`.
 */
export const DEFAULT_OPERATIONAL_CONVERSATION_CLASSIFIER_MODEL_ID =
  "openai/gpt-5.4-mini";
/** Default vision (analyze_property_images y tools de foto). */
export const DEFAULT_IMAGE_VISION_MODEL_ID = "openai/gpt-4.1-mini";
/** Default redacción comercial (prepare_listing_description_draft). */
export const DEFAULT_LISTING_COPY_MODEL_ID = "openai/gpt-4.1-mini";

/** Modelo principal del agente (env override > default). */
export const MAIN_AGENT_MODEL_ID =
  process.env.MAIN_AGENT_MODEL_ID?.trim() || DEFAULT_MAIN_AGENT_MODEL_ID;
/**
 * Alias legacy para minimizar cambios en imports/logs existentes.
 * Preferir MAIN_AGENT_MODEL_ID en código nuevo.
 */
export const CHAT_MODEL_ID = MAIN_AGENT_MODEL_ID;

/** Compaction / memory flush (env override > default). */
export const COMPACTION_MODEL_ID =
  process.env.COMPACTION_MODEL_ID?.trim() || DEFAULT_COMPACTION_MODEL_ID;

/** Skill selector (env override > default). */
export const SKILL_SELECTOR_MODEL_ID =
  process.env.SKILL_SELECTOR_MODEL_ID?.trim() ||
  DEFAULT_SKILL_SELECTOR_MODEL_ID;

/** Business Brain reviewer (env override > default). */
export const BUSINESS_BRAIN_REVIEWER_MODEL_ID =
  process.env.BUSINESS_BRAIN_REVIEWER_MODEL_ID?.trim() ||
  DEFAULT_BUSINESS_BRAIN_REVIEWER_MODEL_ID;

/** Clasificador conversacional de casos (env override > default). */
export const OPERATIONAL_CONVERSATION_CLASSIFIER_MODEL_ID =
  process.env.OPERATIONAL_CONVERSATION_CLASSIFIER_MODEL_ID?.trim() ||
  DEFAULT_OPERATIONAL_CONVERSATION_CLASSIFIER_MODEL_ID;

/** Vision / análisis de imágenes (env override > default). */
export const IMAGE_VISION_MODEL_ID =
  process.env.IMAGE_VISION_MODEL_ID?.trim() || DEFAULT_IMAGE_VISION_MODEL_ID;

/** Copy de listing (env override > default). */
export const LISTING_COPY_MODEL_ID =
  process.env.LISTING_COPY_MODEL_ID?.trim() || DEFAULT_LISTING_COPY_MODEL_ID;

// ============================================================
// Model policy de workers (§9.1, Slice 3.4-4)
// ============================================================

/**
 * Default del verificador de valuación (§9.1). Arranca en la clase barata;
 * se promueve a un modelo más fuerte SOLO cuando los contadores de
 * falso-accept/reject crucen el umbral declarado, nunca por preferencia.
 */
export const DEFAULT_WORKFLOW_VERIFIER_MODEL_ID = "openai/gpt-5.4-mini";
/** Default del descomponedor de intents (Phase 4; mini hasta que A2/B/D fallen). */
export const DEFAULT_WORKFLOW_INTENT_DECOMPOSER_MODEL_ID = "openai/gpt-5.4-mini";
/** Default del compilador NL → spec (Phase 4; juicio alto, volumen bajo). */
export const DEFAULT_WORKFLOW_COMPILER_MODEL_ID = "openai/gpt-5.4-mini";
/** Default del juez independiente de calificación operativa del Studio. */
export const DEFAULT_WORKFLOW_OPERATIONAL_JUDGE_MODEL_ID =
  "anthropic/claude-opus-5";

// ============================================================
// Studio authoring model policy
// ============================================================

/** Stable logical tasks used by Studio authoring and qualification. */
export const STUDIO_MODEL_TASKS = [
  "authoring_router",
  "authoring_discovery",
  "case_workflow_compiler",
  "durable_task_compiler",
  "reusable_skill_compiler",
  "skill_repair",
  "operational_judge",
  "capability_coder",
] as const;

export type StudioModelTask = (typeof STUDIO_MODEL_TASKS)[number];

export const STUDIO_MODEL_TIERS = ["primary", "escalation"] as const;

export type StudioModelTier = (typeof STUDIO_MODEL_TIERS)[number];

export type StudioModelEnv = Readonly<Record<string, string | undefined>>;

/** Cheap default for routine Studio authoring and compiler calls. */
export const DEFAULT_STUDIO_PRIMARY_MODEL_ID =
  DEFAULT_WORKFLOW_COMPILER_MODEL_ID;
/** Frontier default for escalation, repair, judging, and capability coding. */
export const DEFAULT_STUDIO_ESCALATION_MODEL_ID =
  DEFAULT_WORKFLOW_OPERATIONAL_JUDGE_MODEL_ID;

/** Code defaults after all applicable env fallbacks are exhausted. */
export const STUDIO_TASK_DEFAULT_MODEL_IDS: Readonly<
  Record<StudioModelTask, string>
> = {
  authoring_router: DEFAULT_STUDIO_PRIMARY_MODEL_ID,
  authoring_discovery: DEFAULT_STUDIO_PRIMARY_MODEL_ID,
  case_workflow_compiler: DEFAULT_STUDIO_PRIMARY_MODEL_ID,
  durable_task_compiler: DEFAULT_STUDIO_PRIMARY_MODEL_ID,
  reusable_skill_compiler: DEFAULT_STUDIO_PRIMARY_MODEL_ID,
  skill_repair: DEFAULT_STUDIO_ESCALATION_MODEL_ID,
  operational_judge: DEFAULT_WORKFLOW_OPERATIONAL_JUDGE_MODEL_ID,
  capability_coder: DEFAULT_STUDIO_ESCALATION_MODEL_ID,
};

const STUDIO_PRIMARY_ENV_CHAINS: Readonly<
  Record<Exclude<StudioModelTask, "operational_judge">, readonly string[]>
> = {
  authoring_router: [
    "WORKFLOW_AUTHORING_ROUTER_MODEL_ID",
    "WORKFLOW_COMPILER_MODEL_ID",
  ],
  authoring_discovery: [
    "WORKFLOW_AUTHORING_DISCOVERY_MODEL_ID",
    "WORKFLOW_COMPILER_MODEL_ID",
  ],
  case_workflow_compiler: [
    "WORKFLOW_CASE_COMPILER_MODEL_ID",
    "WORKFLOW_COMPILER_MODEL_ID",
  ],
  durable_task_compiler: [
    "WORKFLOW_DURABLE_TASK_COMPILER_MODEL_ID",
    "WORKFLOW_COMPILER_MODEL_ID",
  ],
  reusable_skill_compiler: [
    "WORKFLOW_AUTHORING_SKILL_MODEL_ID",
    "WORKFLOW_COMPILER_MODEL_ID",
  ],
  // The narrower repair override wins; the old shared skill chain remains a
  // fallback when it is absent, preserving existing deployments.
  skill_repair: [
    "WORKFLOW_AUTHORING_SKILL_REPAIR_MODEL_ID",
    "WORKFLOW_AUTHORING_SKILL_MODEL_ID",
    "WORKFLOW_COMPILER_MODEL_ID",
  ],
  // Capability coding is intentionally isolated from the cheap compiler env.
  capability_coder: ["WORKFLOW_CAPABILITY_CODER_MODEL_ID"],
};

const STUDIO_ESCALATION_ENV_BY_TASK: Readonly<
  Record<Exclude<StudioModelTask, "operational_judge">, string>
> = {
  authoring_router: "WORKFLOW_AUTHORING_ROUTER_ESCALATION_MODEL_ID",
  authoring_discovery: "WORKFLOW_AUTHORING_DISCOVERY_ESCALATION_MODEL_ID",
  case_workflow_compiler: "WORKFLOW_CASE_COMPILER_ESCALATION_MODEL_ID",
  durable_task_compiler: "WORKFLOW_DURABLE_TASK_COMPILER_ESCALATION_MODEL_ID",
  reusable_skill_compiler: "WORKFLOW_AUTHORING_SKILL_ESCALATION_MODEL_ID",
  skill_repair: "WORKFLOW_AUTHORING_SKILL_REPAIR_ESCALATION_MODEL_ID",
  capability_coder: "WORKFLOW_CAPABILITY_CODER_ESCALATION_MODEL_ID",
};

function firstConfiguredModelId(
  env: StudioModelEnv,
  names: readonly string[]
): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

/**
 * Pure Studio task resolver. Callers inject their env snapshot so tests and
 * request-time policy resolution do not depend on module import order.
 *
 * Primary: task-specific compatibility chain → code task default.
 * Escalation: task escalation override → shared escalation override → Opus.
 * The operational judge deliberately ignores tier and retains its dedicated
 * override → compiler override → Opus semantics.
 */
export function resolveStudioModelId(
  task: StudioModelTask,
  env: StudioModelEnv,
  tier: StudioModelTier = "primary"
): string {
  if (task === "operational_judge") {
    return resolveWorkflowOperationalJudgeModelId(env);
  }

  if (tier === "escalation") {
    return (
      firstConfiguredModelId(env, [
        STUDIO_ESCALATION_ENV_BY_TASK[task],
        "WORKFLOW_AUTHORING_ESCALATION_MODEL_ID",
      ]) || DEFAULT_STUDIO_ESCALATION_MODEL_ID
    );
  }

  return (
    firstConfiguredModelId(env, STUDIO_PRIMARY_ENV_CHAINS[task]) ||
    STUDIO_TASK_DEFAULT_MODEL_IDS[task]
  );
}

/** Verificadores independientes de workflows (env override > default). */
export const WORKFLOW_VERIFIER_MODEL_ID =
  process.env.WORKFLOW_VERIFIER_MODEL_ID?.trim() ||
  DEFAULT_WORKFLOW_VERIFIER_MODEL_ID;

/** Descomponedor de intents multi-parte (env override > default). */
export const WORKFLOW_INTENT_DECOMPOSER_MODEL_ID =
  process.env.WORKFLOW_INTENT_DECOMPOSER_MODEL_ID?.trim() ||
  DEFAULT_WORKFLOW_INTENT_DECOMPOSER_MODEL_ID;

/** Compilador de workflows NL → spec (env override > default). */
export const WORKFLOW_COMPILER_MODEL_ID =
  process.env.WORKFLOW_COMPILER_MODEL_ID?.trim() ||
  DEFAULT_WORKFLOW_COMPILER_MODEL_ID;

/**
 * Juez LLM del Studio. Cadena deliberadamente separada del ejecutor:
 * override propio → override explícito del compilador → default frontera.
 */
export function resolveWorkflowOperationalJudgeModelId(
  env: Record<string, string | undefined> = process.env
): string {
  return (
    env.WORKFLOW_OPERATIONAL_JUDGE_MODEL_ID?.trim() ||
    env.WORKFLOW_COMPILER_MODEL_ID?.trim() ||
    DEFAULT_WORKFLOW_OPERATIONAL_JUDGE_MODEL_ID
  );
}

export const WORKFLOW_OPERATIONAL_JUDGE_MODEL_ID =
  resolveWorkflowOperationalJudgeModelId();

/**
 * Mapa central alias lógico → id de OpenRouter (§9.1). Los perfiles de
 * worker declaran aliases, NUNCA strings de vendor; este mapa es el
 * allowlist — un alias fuera de él no resuelve (y el caller cae al
 * siguiente paso de la cadena de resolución). Mantener los ids dentro del
 * catálogo de precios (`CATALOG_REQUIRED_MODEL_IDS`) para que el metering
 * pueda estimar costo.
 */
export const WORKER_MODEL_ALIAS_MAP: Readonly<Record<string, string>> = {
  // Clase razonamiento: hoy ambos apuntan al default barato; `reasoning_high`
  // se re-apunta a un modelo más fuerte cuando los criterios §9.1 lo exijan
  // (el alias es el punto de corte, no los perfiles ya publicados).
  reasoning_standard: "openai/gpt-5.4-mini",
  reasoning_high: "openai/gpt-5.4-mini",
  fast_cheap: "anthropic/claude-haiku-4.5",
};

/** Cadena env por rol de worker (paso 2 de la resolución §9.1). */
const WORKER_ROLE_ENV_MODEL_IDS: Readonly<Record<string, string>> = {
  valuation_verifier: WORKFLOW_VERIFIER_MODEL_ID,
  intent_decomposer: WORKFLOW_INTENT_DECOMPOSER_MODEL_ID,
  workflow_compiler: WORKFLOW_COMPILER_MODEL_ID,
};

export interface ResolveWorkerModelInput {
  /** `model_policy_jsonb` del worker profile (puede venir vacío). */
  modelPolicy?: {
    role?: string;
    model_alias?: string;
    fallback_aliases?: string[];
    max_output_tokens?: number;
    temperature?: number;
  } | null;
  /**
   * Modo de ejecución del perfil. Los deterministas NUNCA resuelven modelo
   * (§9.1 paso 3 aplica solo a modos agénticos).
   */
  executionMode: string;
}

export interface ResolvedWorkerModel {
  modelId: string;
  /** Qué paso de la cadena resolvió: profile_alias | role_env | main_agent. */
  resolvedVia: "profile_alias" | "role_env" | "main_agent";
  maxTokens: number;
  temperature: number;
}

/**
 * ModelPolicyResolver (§9.1). Orden de resolución — primer hit gana:
 *   1. alias del perfil (model_alias, luego fallback_aliases) contra el
 *      allowlist central;
 *   2. env default del rol (`WORKFLOW_VERIFIER_MODEL_ID`, …);
 *   3. `MAIN_AGENT_MODEL_ID` como último recurso, SOLO para modos agénticos
 *      (un deterministic_service que llegue aquí es un bug del caller ⇒ null).
 */
export function resolveWorkerModel(
  input: ResolveWorkerModelInput
): ResolvedWorkerModel | null {
  if (
    input.executionMode === "deterministic_service" ||
    input.executionMode === "external_service" ||
    input.executionMode === "human"
  ) {
    return null;
  }
  const policy = input.modelPolicy ?? {};
  const maxTokens =
    typeof policy.max_output_tokens === "number" && policy.max_output_tokens > 0
      ? Math.floor(policy.max_output_tokens)
      : DEFAULT_MAX_TOKENS;
  const temperature =
    typeof policy.temperature === "number" ? policy.temperature : 0;

  const aliases = [
    ...(policy.model_alias ? [policy.model_alias] : []),
    ...(policy.fallback_aliases ?? []),
  ];
  for (const alias of aliases) {
    const modelId = WORKER_MODEL_ALIAS_MAP[alias];
    if (modelId) {
      return { modelId, resolvedVia: "profile_alias", maxTokens, temperature };
    }
  }

  const roleEnv = policy.role ? WORKER_ROLE_ENV_MODEL_IDS[policy.role] : undefined;
  if (roleEnv) {
    return { modelId: roleEnv, resolvedVia: "role_env", maxTokens, temperature };
  }

  return {
    modelId: MAIN_AGENT_MODEL_ID,
    resolvedVia: "main_agent",
    maxTokens,
    temperature,
  };
}

/**
 * Heartbeat: si `HEARTBEAT_MODEL_ID` está vacío, el canal hereda el modelo
 * principal en `graph.ts` (no hay un default barato aparte en código).
 */
export function resolveHeartbeatModelId(): string | undefined {
  return process.env.HEARTBEAT_MODEL_ID?.trim() || undefined;
}

/** Resuelve maxTokens: variable de entorno > default. */
function resolveMaxTokens(): number {
  const raw = process.env.OPENROUTER_MAX_TOKENS?.trim();
  if (!raw) return DEFAULT_MAX_TOKENS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.warn(
      `[model] OPENROUTER_MAX_TOKENS="${raw}" no es un número válido; usando default ${DEFAULT_MAX_TOKENS}.`
    );
    return DEFAULT_MAX_TOKENS;
  }
  return Math.floor(n);
}

/**
 * Shared ChatOpenAI options for every OpenRouter factory: raw response
 * retention (LangChain metadata path) + fetch interceptor (HTTP usage.cost
 * stash) + usage metering callback.
 */
function openRouterChatOpenAIOptions(params: {
  modelName: string;
  modelRole: string;
  temperature: number;
  maxTokens: number;
}) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY");

  return {
    modelName: params.modelName,
    temperature: params.temperature,
    maxTokens: params.maxTokens,
    configuration: openRouterClientConfiguration(),
    apiKey,
    // Conserva `usage.cost` de OpenRouter en additional_kwargs.__raw_response
    // (ChatOpenAI solo copia usage a response_metadata si hay system_fingerprint).
    __includeRawResponse: true as const,
    // Belt-and-suspenders: OpenRouter currently returns usage by default;
    // older docs required usage.include.
    modelKwargs: { usage: { include: true } },
    callbacks: [
      createAiUsageCallbackHandler({
        modelId: params.modelName,
        modelRole: params.modelRole,
      }),
    ],
  };
}

export function createChatModel(options: CreateChatModelOptions = {}) {
  const temperature = options.temperature ?? DEFAULT_INTERACTIVE_TEMPERATURE;
  const modelName = options.modelName ?? MAIN_AGENT_MODEL_ID;
  const maxTokens = options.maxTokens ?? resolveMaxTokens();

  return new ChatOpenAI(
    openRouterChatOpenAIOptions({
      modelName,
      modelRole: "main_agent",
      temperature,
      maxTokens,
    })
  );
}

/**
 * Factory dedicada para el `compaction_node`. Usa Haiku vía el mismo endpoint
 * de OpenRouter (sin credencial ni SDK nuevos). Se mantiene separada de
 * `createChatModel()` para no acoplar las dos decisiones: si el modelo
 * principal del agente cambia, el compactador sigue siendo Haiku-class, que
 * es suficiente para la tarea mecánica de resumir.
 */
export function createCompactionModel() {
  return new ChatOpenAI(
    openRouterChatOpenAIOptions({
      modelName: COMPACTION_MODEL_ID,
      modelRole: "compaction",
      temperature: 0,
      maxTokens: 2048,
    })
  );
}

/**
 * Factory for the pre-graph skill selector (V1-B). Tiny prompt, strict JSON
 * output; deterministic temperature so the same input picks the same skill
 * and tests are stable.
 */
export function createSkillSelectorModel() {
  return new ChatOpenAI(
    openRouterChatOpenAIOptions({
      modelName: SKILL_SELECTOR_MODEL_ID,
      modelRole: "skill_selector",
      temperature: 0,
      maxTokens: 128,
    })
  );
}

/**
 * Factory for the Settings-side Business Brain reviewer. It rewrites short
 * user-authored preferences into structured, system-compatible copy.
 */
export function createBusinessBrainReviewerModel() {
  return new ChatOpenAI(
    openRouterChatOpenAIOptions({
      modelName: BUSINESS_BRAIN_REVIEWER_MODEL_ID,
      modelRole: "business_brain_reviewer",
      temperature: 0,
      maxTokens: 700,
    })
  );
}

/**
 * Factory para workers model-backed del plano de trabajo (Slice 3.4). El
 * caller resuelve primero la política con `resolveWorkerModel` y pasa el
 * resultado; `modelRole` viaja al metering de ai_usage_events junto con el
 * id RESUELTO (3.4-6) — nunca el alias.
 */
export function createWorkerModel(params: {
  resolved: ResolvedWorkerModel;
  modelRole: string;
}) {
  return new ChatOpenAI(
    openRouterChatOpenAIOptions({
      modelName: params.resolved.modelId,
      modelRole: params.modelRole,
      temperature: params.resolved.temperature,
      maxTokens: params.resolved.maxTokens,
    })
  );
}
