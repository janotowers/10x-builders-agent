/**
 * Descomposición conservadora de intents por turno (Slice 4.1; Technical
 * Plan §12: decompose → dispatch por intent → compose).
 *
 * Dos garantías duras:
 *   1. CONSERVADOR: bajo el piso de confianza (o ante cualquier fallo del
 *      modelo/parseo) se degrada al comportamiento actual — un solo intent
 *      igual al turno completo. El residual de 0.1 sigue siendo la red de
 *      seguridad para lo que este módulo no detecte.
 *   2. SIN INVENCIÓN: cada intent propuesto debe ser un span literal del
 *      mensaje original (comparación normalizada). Un split alucinado no
 *      pasa `shouldApplyDecomposition`, aunque el modelo reporte confianza
 *      alta.
 *
 * Modelo (§9.1): `WORKFLOW_INTENT_DECOMPOSER_MODEL_ID` →
 * `OPERATIONAL_CONVERSATION_CLASSIFIER_MODEL_ID` → `MAIN_AGENT_MODEL_ID`.
 * Fail-open: cualquier error devuelve null y el caller enruta el turno
 * completo como hoy.
 */

import { z } from "zod";
import {
  MAIN_AGENT_MODEL_ID,
  recordOpenRouterCallUsage,
  type OpenRouterUsagePayload,
} from "@agents/agent";

export type DecomposedIntentKind =
  | "decision"
  | "data_update"
  | "question"
  | "other";

export const IntentDecompositionSchema = z.object({
  /** true solo si el turno contiene MÁS de una petición independiente. */
  multi_intent: z.boolean(),
  confidence: z.enum(["high", "medium", "low"]),
  intents: z
    .array(
      z.object({
        /** Span literal del mensaje original (sin parafrasear). */
        text: z.string().min(1),
        kind: z.enum(["decision", "data_update", "question", "other"]),
        confidence: z.enum(["high", "medium", "low"]),
      })
    )
    .max(4),
  reason: z.string().optional(),
});

export type IntentDecomposition = z.infer<typeof IntentDecompositionSchema>;
export type DecomposedIntent = IntentDecomposition["intents"][number];

export interface IntentDecomposerInput {
  message: string;
  /** Kinds de notificaciones HITL pendientes (contexto, no obligatorio). */
  pendingKinds?: string[] | null;
}

export interface IntentDecomposerModel {
  decompose(input: IntentDecomposerInput): Promise<unknown>;
}

/** Cadena de resolución de modelo del §9.1 para este rol. */
export function resolveIntentDecomposerModelId(): string {
  return (
    process.env.WORKFLOW_INTENT_DECOMPOSER_MODEL_ID?.trim() ||
    process.env.OPERATIONAL_CONVERSATION_CLASSIFIER_MODEL_ID?.trim() ||
    MAIN_AGENT_MODEL_ID
  );
}

// ─── Pre-filtro determinístico (evita una llamada de modelo por turno) ──────

const CONNECTOR_PATTERN =
  /(?:\by\b|\be\b|\badem[aá]s\b|\btambi[eé]n\b|\bluego\b|\bdespu[eé]s\b|\baparte\b|;)/i;
const QUESTION_PATTERN =
  /[¿?]|\b(?:cu[aá]nt[oa]s?|qu[eé]|c[oó]mo|cu[aá]l(?:es)?|d[oó]nde|cu[aá]ndo|por qu[eé]|dime|expl[ií]came|mu[eé]strame)\b/i;

/**
 * Heurística barata previa al modelo:
 *  (a) señales de multi-intent: un conector/separador de cláusulas junto con
 *      señal de pregunta o suficiente longitud;
 *  (b) con decisiones pendientes (`hasPendingDecisions`), cualquier señal de
 *      pregunta amerita clasificar el turno (escenarios A1/A2: una side
 *      question durante un gate pegajoso debe quedar clasificada y
 *      registrada, no solo "ningún gate coincidió").
 */
export function looksLikeMultiIntentTurn(
  text: string,
  opts: { hasPendingDecisions?: boolean } = {}
): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 8) return false;
  const hasConnector = CONNECTOR_PATTERN.test(trimmed);
  const hasQuestion = QUESTION_PATTERN.test(trimmed);
  if (hasConnector && (hasQuestion || trimmed.length >= 40)) return true;
  if (opts.hasPendingDecisions && hasQuestion) return true;
  return false;
}

// ─── Normalización + piso de confianza ──────────────────────────────────────

function normalizeForContainment(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}$%]+/gu, " ")
    .trim();
}

function normalizeDecomposition(value: unknown): IntentDecomposition | null {
  const parsed = IntentDecompositionSchema.safeParse(value);
  if (!parsed.success) return null;
  const intents = parsed.data.intents
    .map((intent) => ({ ...intent, text: intent.text.trim() }))
    .filter((intent) => intent.text.length > 0);
  return { ...parsed.data, intents };
}

/**
 * Piso conservador (Slice 4.1-1). Solo se aplica el split cuando:
 *   - el modelo afirma multi_intent con confianza global "high";
 *   - hay entre 2 y 4 intents, ninguno con confianza "low";
 *   - cada intent es un span literal del mensaje (normalizado) — regla
 *     anti-invención;
 *   - los intents no se reducen a un solo segmento (split trivial).
 * Todo lo demás ⇒ un solo intent = turno completo.
 */
export function shouldApplyDecomposition(
  message: string,
  decomposition: IntentDecomposition | null | undefined
): boolean {
  if (!decomposition) return false;
  if (!decomposition.multi_intent) return false;
  if (decomposition.confidence !== "high") return false;
  const intents = decomposition.intents;
  if (intents.length < 2 || intents.length > 4) return false;
  if (intents.some((intent) => intent.confidence === "low")) return false;
  const normalizedMessage = normalizeForContainment(message);
  for (const intent of intents) {
    const normalizedIntent = normalizeForContainment(intent.text);
    if (!normalizedIntent) return false;
    if (!normalizedMessage.includes(normalizedIntent)) return false;
  }
  return true;
}

// ─── Invocación del modelo ──────────────────────────────────────────────────

function parseJsonContent(content: unknown) {
  if (typeof content !== "string") return content;
  const trimmed = content.trim();
  if (!trimmed) return null;
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return JSON.parse(fenced?.[1] ?? trimmed);
}

function buildDecomposerPrompt(input: IntentDecomposerInput): string {
  const pendingContext =
    input.pendingKinds && input.pendingKinds.length > 0
      ? `pending decisions awaiting the user: ${input.pendingKinds.join(", ")}`
      : "no pending decisions";
  return [
    "Split this Spanish message from a real-estate operator into independent intents.",
    "Return ONLY compact JSON matching this TypeScript shape:",
    '{"multi_intent":boolean,"confidence":"high|medium|low","intents":[{"text":string,"kind":"decision|data_update|question|other","confidence":"high|medium|low"}],"reason"?:string}',
    "",
    "Rules:",
    "- Each intent.text MUST be a verbatim span copied from the message. Never paraphrase, translate, or merge words that are not adjacent.",
    "- multi_intent=true ONLY when the message contains two or more independent requests (e.g. a decision AND an unrelated question).",
    "- kind=decision: approving/rejecting/adjusting a pending business decision (price, contract, listing, review).",
    "- kind=data_update: correcting or providing case data (e.g. 'cambia las recámaras de dos a tres').",
    "- kind=question: a question or information request (e.g. 'cuántos leads generamos el mes pasado').",
    "- kind=other: anything else (courtesy, scheduling requests, unclear).",
    "- A single request with subordinate clauses is ONE intent (multi_intent=false).",
    "- Use confidence=low when unsure; low confidence disables the split downstream.",
    "- Keep the original order of the message.",
    "",
    `context: ${pendingContext}`,
    `message: ${JSON.stringify(input.message)}`,
  ].join("\n");
}

async function invokeOpenRouterDecomposer(input: IntentDecomposerInput) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;
  const model = resolveIntentDecomposerModelId();
  const startedAt = Date.now();
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://agents.local",
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 300,
      response_format: { type: "json_object" },
      usage: { include: true },
      messages: [
        {
          role: "system",
          content:
            "You are a strict JSON intent splitter. Never call tools. Never answer conversationally.",
        },
        { role: "user", content: buildDecomposerPrompt(input) },
      ],
    }),
  });
  if (!response.ok) {
    void recordOpenRouterCallUsage({
      modelId: model,
      modelRole: "intent_decomposer",
      operation: "classification",
      latencyMs: Date.now() - startedAt,
      status: "error",
      errorCode: `http_${response.status}`,
    });
    console.warn(
      "[intent-decomposer] OpenRouter failed:",
      response.status,
      await response.text().catch(() => "")
    );
    return null;
  }
  const json = (await response.json()) as {
    id?: string;
    choices?: Array<{ message?: { content?: unknown } }>;
    usage?: OpenRouterUsagePayload;
  };
  void recordOpenRouterCallUsage({
    modelId: model,
    modelRole: "intent_decomposer",
    operation: "classification",
    usage: json.usage ?? null,
    providerRequestId: typeof json.id === "string" ? json.id : null,
    latencyMs: Date.now() - startedAt,
  });
  return parseJsonContent(json.choices?.[0]?.message?.content);
}

/**
 * Devuelve la descomposición, o null ante mensaje vacío / fallo del modelo /
 * JSON inválido. El caller trata null como "un solo intent = turno completo".
 */
export async function decomposeTurnIntents(
  input: IntentDecomposerInput,
  model?: IntentDecomposerModel
): Promise<IntentDecomposition | null> {
  if (!input.message.trim()) return null;
  try {
    const raw = model
      ? await model.decompose(input)
      : await invokeOpenRouterDecomposer(input);
    return normalizeDecomposition(raw);
  } catch (error) {
    console.warn("[intent-decomposer] failed:", error);
    return null;
  }
}
