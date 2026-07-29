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
