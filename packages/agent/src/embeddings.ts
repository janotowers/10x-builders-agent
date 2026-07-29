/**
 * Wrapper para el endpoint de embeddings de OpenRouter.
 *
 * Se aísla aquí (no en `model.ts`) porque:
 * - No usamos ChatOpenAI/LangChain — es un fetch crudo a `/v1/embeddings`
 *   y no necesitamos el overhead del SDK.
 * - Lo usan DOS callers independientes (`memory_injection_node` y
 *   `memory_flush`) y conviene tener una única implementación con timeout,
 *   manejo de errores y validación de dimensiones.
 *
 * Ver `docs/memory/long_term_memory_plan.md` (sección "Constantes") para
 * los defaults y las variables de entorno que los overridean.
 */

import {
  recordOpenRouterCallUsage,
  type OpenRouterUsagePayload,
} from "./usage/ai-usage-meter";

export const DEFAULT_EMBEDDING_MODEL = "google/gemini-embedding-001";
export const DEFAULT_EMBEDDING_DIM = 1536;
const DEFAULT_TIMEOUT_MS = 10_000;

function resolveEmbeddingModel(): string {
  return process.env.MEMORY_EMBEDDING_MODEL?.trim() || DEFAULT_EMBEDDING_MODEL;
}

function resolveEmbeddingDim(): number {
  const raw = process.env.MEMORY_EMBEDDING_DIM?.trim();
  if (!raw) return DEFAULT_EMBEDDING_DIM;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_EMBEDDING_DIM;
  return Math.floor(n);
}

export interface GenerateEmbeddingOptions {
  /** Override del modelo por llamada (útil en tests). */
  model?: string;
  /** Timeout duro en ms. Default 10s. */
  timeoutMs?: number;
}

/**
 * Genera un embedding para `text` usando el modelo configurado por env
 * (`MEMORY_EMBEDDING_MODEL`, default `google/gemini-embedding-001`).
 *
 * Respuesta: array de números de tamaño `MEMORY_EMBEDDING_DIM` (default 1536).
 * Lanza si:
 * - falta la API key,
 * - el endpoint responde con error HTTP,
 * - la dimensión devuelta no coincide con la configurada (evita persistir un
 *   vector incompatible con la columna `vector(1536)` de Postgres).
 *
 * El caller decide si captura el error (el nodo de inyección degrada
 * silenciosamente; el flush avanza al watermark solo si todo sale bien).
 */
export async function generateEmbedding(
  text: string,
  options: GenerateEmbeddingOptions = {}
): Promise<number[]> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY");

  const model = options.model ?? resolveEmbeddingModel();
  const expectedDim = resolveEmbeddingDim();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const trimmed = text.trim();
  if (!trimmed) throw new Error("generateEmbedding: empty input");

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const recordUsage = (input: {
    usage: OpenRouterUsagePayload | null;
    providerRequestId?: string | null;
    startedAt: number;
    status: "ok" | "error";
    errorCode?: string | null;
  }) => {
    // Slice 0.4 — metering best-effort (nunca bloquea el embedding).
    void recordOpenRouterCallUsage({
      modelId: model,
      modelRole: "embeddings",
      operation: "embedding",
      usage: input.usage,
      providerRequestId: input.providerRequestId ?? null,
      latencyMs: Date.now() - input.startedAt,
      status: input.status,
      errorCode: input.errorCode ?? null,
    });
  };

  const startedAt = Date.now();
  try {
    const response = await fetch("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": "https://agents.local",
      },
      // `dimensions` le pide al modelo que trunque el vector a ese tamaño.
      // Es la forma estándar (OpenAI-compatible) de usar Matryoshka
      // Representation Learning: Gemini embedding-001 devuelve 3072 dims por
      // default, pero nuestro índice pgvector está limitado a 2000 dims y
      // fue dimensionado a 1536 (mejor relación calidad/costo).
      // El parámetro es silenciosamente ignorado por modelos que no soportan
      // truncación, así que el guard `raw.length !== expectedDim` de abajo
      // sigue siendo la red de seguridad.
      body: JSON.stringify({
        model,
        input: trimmed,
        encoding_format: "float",
        dimensions: expectedDim,
        // Slice 0.4.1 — ask for usage.cost (OpenRouter includes it by default
        // today; keep the flag for older accounting docs / future changes).
        usage: { include: true },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      recordUsage({
        usage: null,
        startedAt,
        status: "error",
        errorCode: `http_${response.status}`,
      });
      throw new Error(
        `OpenRouter embeddings ${response.status}: ${body.slice(0, 300)}`
      );
    }

    const json = (await response.json()) as {
      id?: string;
      data?: Array<{ embedding?: unknown }>;
      usage?: OpenRouterUsagePayload;
    };
    recordUsage({
      usage: json?.usage ?? null,
      providerRequestId: typeof json.id === "string" ? json.id : null,
      startedAt,
      status: "ok",
    });
    const raw = json?.data?.[0]?.embedding;
    if (!Array.isArray(raw)) {
      throw new Error("OpenRouter embeddings response missing data[0].embedding");
    }

    // Validación estricta: la columna vector(1536) rechaza dimensiones
    // distintas. Si caemos aquí después de pedir `dimensions`, es que el
    // provider ignoró el parámetro (cambió el default sin avisar) — mejor
    // fallar con mensaje claro que obtener un error opaco de Postgres.
    if (raw.length !== expectedDim) {
      throw new Error(
        `Embedding dim mismatch: got ${raw.length}, expected ${expectedDim} ` +
          `(model=${model}). Ajusta MEMORY_EMBEDDING_DIM o MEMORY_EMBEDDING_MODEL.`
      );
    }

    return raw as number[];
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Cosine similarity entre dos vectores. Devuelve 1 si son idénticos, 0 si son
 * ortogonales, -1 si son opuestos. Si las dimensiones no coinciden, devuelve 0
 * (no lanza — caller ya tiene su propio guard).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  if (denom === 0) return 0;
  return dot / denom;
}
