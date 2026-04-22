import { ChatOpenAI } from "@langchain/openai";

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
}

/** Temperatura por defecto para interacciones normales (Web/Telegram). */
export const DEFAULT_INTERACTIVE_TEMPERATURE = 0.3;
/** Temperatura para el cron runner: más determinista y menos "narrativo". */
export const DEFAULT_CRON_TEMPERATURE = 0.1;

/**
 * Default para max_tokens de salida cuando no hay `OPENROUTER_MAX_TOKENS` en el
 * entorno. Lo bajamos a 2048 para que la RESERVA de tokens que OpenRouter hace
 * contra tu saldo quepa incluso en cuentas con poco crédito (el error 402
 * "This request requires more credits, or fewer max_tokens" aparece cuando la
 * reserva supera el saldo, aunque la respuesta real fuese a ser mucho menor).
 */
export const DEFAULT_MAX_TOKENS = 2048;

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

export function createChatModel(options: CreateChatModelOptions = {}) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY");

  const temperature = options.temperature ?? DEFAULT_INTERACTIVE_TEMPERATURE;

  return new ChatOpenAI({
    modelName: "openai/gpt-4o-mini",
    temperature,
    // Capamos max_tokens de salida para evitar rechazos de OpenRouter por
    // saldo insuficiente (si no lo fijamos, el SDK pide el máximo del modelo
    // ≈16k y una cuenta con pocos créditos lo rechaza con 402).
    // Configurable por `OPENROUTER_MAX_TOKENS`; default 2048.
    maxTokens: resolveMaxTokens(),
    configuration: {
      baseURL: "https://openrouter.ai/api/v1",
      defaultHeaders: {
        "HTTP-Referer": "https://agents.local",
      },
    },
    apiKey,
  });
}

/**
 * Factory dedicada para el `compaction_node`. Usa Claude 3.5 Haiku vía el
 * mismo endpoint de OpenRouter (sin credencial ni SDK nuevos). Se mantiene
 * separada de `createChatModel()` para no acoplar las dos decisiones: si el
 * modelo principal del agente cambia (gpt-4o-mini → otro), el compactador
 * sigue siendo Haiku, que es suficiente para la tarea mecánica de resumir.
 */
export function createCompactionModel() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY");

  return new ChatOpenAI({
    modelName: "anthropic/claude-3-5-haiku",
    temperature: 0,
    maxTokens: 2048,
    configuration: {
      baseURL: "https://openrouter.ai/api/v1",
      defaultHeaders: {
        "HTTP-Referer": "https://agents.local",
      },
    },
    apiKey,
  });
}
