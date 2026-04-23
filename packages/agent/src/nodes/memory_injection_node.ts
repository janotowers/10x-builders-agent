import {
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { DbClient } from "@agents/db";
import {
  getFlushState,
  searchMemories,
  incrementRetrievalCount,
  updateLastUserInputEmbedding,
} from "@agents/db";
import type { GraphStateType } from "../state";
import {
  cosineSimilarity,
  generateEmbedding,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_EMBEDDING_DIM,
} from "../embeddings";
import { logMemoryInject } from "./memory_log";

/**
 * `memory_injection_node` — nodo inicial del grafo (primer nodo tras
 * `__start__`, antes de `compaction`).
 *
 * Qué hace en un turno "normal" (Web/Telegram, sin cron, sin resume HITL):
 *   1. Toma el ÚLTIMO `HumanMessage` del estado (el input de este turno).
 *   2. Genera su embedding (una sola llamada a OpenRouter).
 *   3. Compara con `last_user_input_embedding` para decidir topic-shift
 *      (`memoryFlushPending` = `true` si cosine < `TOPIC_SHIFT_THRESHOLD`).
 *      Semántica: si cosine(prev_user_input, current_user_input) < 0.55 
 *      → se marca memoryFlushPending=true → el fireAndForgetFlush lo tomará como razón shift y disparará el flush.
 *      Ojo con la dirección: más alto el threshold = más sensible (más shifts). 
 *      Bajarlo a 0.3 lo vuelve muy conservador; subirlo a 0.8 dispara casi en cada turno.
 *   4. Busca memorias similares vía RPC `match_memories` (top K por cosine).
 *   5. Reescribe IN-PLACE el primer `SystemMessage` anteponiendo un bloque
 *      `[MEMORIA DEL USUARIO] ...` al contenido original. Se emite un
 *      `SystemMessage` con el MISMO `id` para que `messagesStateReducer`
 *      haga swap (el id original se preserva → sigue en `keepIds` de
 *      compaction, no se duplica, no se pierde el prompt).
 *   6. Persiste el embedding actual para que el próximo turno tenga base
 *      contra la cual medir shift.
 *
 * Qué NO hace:
 *   - Ejecutar el flush (eso es `flushSessionMemory`, fuera del grafo).
 *   - Tocar HITL, `iterationCount`, `compactionCount`, ni `autoApproveTools`.
 *   - Correr en modo cron (`autoApproveTools=true`): guard → no-op.
 *   - Correr en resume HITL: guard → no-op (el `last_user_input_embedding`
 *     ya fue escrito por el turno original que disparó el interrupt).
 *
 * Fallos silenciosos: si el embedding/RPC fallan, el nodo retorna `{}` y el
 * grafo continúa como si la memoria no existiera. Nunca bloquea el turno.
 */

const TOPIC_SHIFT_THRESHOLD_DEFAULT = 0.55;
const RETRIEVE_TOP_K_DEFAULT = 8;
const MATCH_THRESHOLD_DEFAULT = 0.35;
const MEMORY_BLOCK_MAX_CHARS = 1500;

function resolveTopicShiftThreshold(): number {
  const raw = process.env.MEMORY_TOPIC_SHIFT_THRESHOLD?.trim();
  if (!raw) return TOPIC_SHIFT_THRESHOLD_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return TOPIC_SHIFT_THRESHOLD_DEFAULT;
  return n;
}

function resolveRetrieveTopK(): number {
  const raw = process.env.MEMORY_RETRIEVE_TOP_K?.trim();
  if (!raw) return RETRIEVE_TOP_K_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return RETRIEVE_TOP_K_DEFAULT;
  return Math.floor(n);
}

function resolveMatchThreshold(): number {
  const raw = process.env.MEMORY_MATCH_THRESHOLD?.trim();
  if (!raw) return MATCH_THRESHOLD_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return MATCH_THRESHOLD_DEFAULT;
  return n;
}

interface MemoryInjectionDeps {
  db: DbClient;
  userId: string;
  /**
   * `true` cuando runAgent fue llamado con `resumeDecision`. En ese caso el
   * nodo hace no-op: el HumanMessage del turno ya fue procesado por la
   * ejecución original que disparó el interrupt; ni queremos recomputar
   * embedding (ya existe) ni volver a inyectar (el SystemMessage ya está
   * en el checkpoint con la memoria aplicada).
   */
  isResume: boolean;
}

function getLastHumanMessage(messages: BaseMessage[]): HumanMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m instanceof HumanMessage) return m;
  }
  return null;
}

function contentToString(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    return raw
      .map((p) => {
        if (typeof p === "string") return p;
        if (p && typeof p === "object" && "text" in p) {
          return String((p as { text: unknown }).text ?? "");
        }
        return "";
      })
      .join("");
  }
  return raw ? String(raw) : "";
}

function buildMemoryBlock(
  matches: Array<{ type: string; content: string }>
): string {
  if (matches.length === 0) return "";
  const header = "[MEMORIA DEL USUARIO — recuerdos persistentes, consúltalos al responder]";
  const lines: string[] = [header];
  let total = header.length;
  for (const m of matches) {
    const line = `- (${m.type}) ${m.content}`;
    if (total + line.length + 1 > MEMORY_BLOCK_MAX_CHARS) break;
    lines.push(line);
    total += line.length + 1;
  }
  return lines.join("\n");
}

export function createMemoryInjectionNode(deps: MemoryInjectionDeps) {
  const { db, userId, isResume } = deps;
  const topicShiftThreshold = resolveTopicShiftThreshold();
  const retrieveTopK = resolveRetrieveTopK();
  const matchThreshold = resolveMatchThreshold();

  return async function memoryInjectionNode(
    state: GraphStateType
  ): Promise<Partial<GraphStateType>> {
    // --- Guard 1: cron ---
    // La sesión `channel = 'cron'` ejecuta prompts deterministas ya aprobados
    // por el usuario al programarlos; inyectar memoria del usuario podría
    // contaminar el prompt con hechos que no aplican a esa ejecución
    // programada (y además gastamos embeddings innecesariamente).
    if (state.autoApproveTools) {
      void logMemoryInject({
        sessionId: state.sessionId,
        userId,
        userInput: null,
        outcome: "skipped_cron",
        memoryFlushPending: false,
      }).catch(() => {});
      return {};
    }

    // --- Guard 2: resume HITL ---
    // En un resume, runAgent pasa `resumeDecision` y LangGraph retoma el
    // grafo desde el interrupt. No hay nuevo HumanMessage que indexar.
    if (isResume) {
      void logMemoryInject({
        sessionId: state.sessionId,
        userId,
        userInput: null,
        outcome: "skipped_resume",
        memoryFlushPending: false,
      }).catch(() => {});
      return {};
    }

    // --- Guard 3: sin HumanMessage ---
    const lastHuman = getLastHumanMessage(state.messages ?? []);
    if (!lastHuman) {
      void logMemoryInject({
        sessionId: state.sessionId,
        userId,
        userInput: null,
        outcome: "skipped_no_input",
        memoryFlushPending: false,
      }).catch(() => {});
      return {};
    }
    const userInput = contentToString(lastHuman.content).trim();
    if (!userInput) {
      void logMemoryInject({
        sessionId: state.sessionId,
        userId,
        userInput: null,
        outcome: "skipped_no_input",
        memoryFlushPending: false,
      }).catch(() => {});
      return {};
    }

    // --- Embedding del input actual (coste: 1 llamada) ---
    const embeddingStart = Date.now();
    let currentEmbedding: number[];
    try {
      currentEmbedding = await generateEmbedding(userInput);
    } catch (err) {
      console.error("[memory_injection] embedding failed:", err);
      void logMemoryInject({
        sessionId: state.sessionId,
        userId,
        userInput,
        outcome: "embedding_failed",
        memoryFlushPending: false,
      }).catch(() => {});
      return {};
    }
    const embeddingLatency = Date.now() - embeddingStart;

    // --- Topic-shift + fetch de memorias en paralelo ---
    // `getFlushState` da el embedding previo (para cosine) y nada más;
    // `searchMemories` es independiente. Los lanzamos en paralelo para
    // ahorrar round-trips a Supabase.
    const retrievalStart = Date.now();
    const [flushStateResult, matchesResult] = await Promise.allSettled([
      getFlushState(db, state.sessionId),
      searchMemories(db, {
        userId,
        embedding: currentEmbedding,
        limit: retrieveTopK,
        matchThreshold,
      }),
    ]);
    const retrievalLatency = Date.now() - retrievalStart;

    let topicShift = false;
    let hasPrevEmbedding = false;
    let cosineValue: number | null = null;
    if (flushStateResult.status === "fulfilled" && flushStateResult.value) {
      const prev = flushStateResult.value.lastUserInputEmbedding;
      if (prev && prev.length === currentEmbedding.length) {
        hasPrevEmbedding = true;
        const sim = cosineSimilarity(prev, currentEmbedding);
        cosineValue = sim;
        topicShift = sim < topicShiftThreshold;
      }
    }

    const matches =
      matchesResult.status === "fulfilled" ? matchesResult.value : [];

    // --- Persistir embedding actual para el próximo turno (no-blocking) ---
    updateLastUserInputEmbedding(db, state.sessionId, currentEmbedding).catch(
      (err) =>
        console.error(
          "[memory_injection] updateLastUserInputEmbedding failed:",
          err
        )
    );

    // --- Si no hay memorias relevantes, solo propagamos el shift ---
    if (matches.length === 0) {
      void logMemoryInject({
        sessionId: state.sessionId,
        userId,
        userInput,
        outcome: "ok",
        embedding: {
          model: DEFAULT_EMBEDDING_MODEL,
          dim: DEFAULT_EMBEDDING_DIM,
          latencyMs: embeddingLatency,
        },
        topicShift: {
          hasPrevEmbedding,
          cosine: cosineValue,
          threshold: topicShiftThreshold,
          shift: topicShift,
        },
        retrieval: {
          topK: retrieveTopK,
          threshold: matchThreshold,
          returned: 0,
          latencyMs: retrievalLatency,
          matches: [],
        },
        injection: {
          rewrittenSystemMessage: false,
          blockChars: 0,
          firstSystemIdx: -1,
        },
        memoryFlushPending: topicShift,
      }).catch(() => {});
      return { memoryFlushPending: topicShift };
    }

    // --- Construir bloque de memoria e inyectarlo en el primer SystemMessage ---
    const memoryBlock = buildMemoryBlock(matches);
    const firstSystemIdx = (state.messages ?? []).findIndex(
      (m) => m instanceof SystemMessage
    );
    const updates: BaseMessage[] = [];
    let rewrote = false;
    if (firstSystemIdx >= 0) {
      const current = state.messages[firstSystemIdx];
      const currentContent = contentToString(current.content);
      // Si ya inyectamos antes en este checkpoint (raro fuera de resume, pero
      // defensivo), no duplicamos el bloque.
      if (!currentContent.startsWith("[MEMORIA DEL USUARIO")) {
        const newContent = `${memoryBlock}\n\n---\n\n${currentContent}`;
        // Emitimos un SystemMessage con el MISMO id: messagesStateReducer
        // hace swap in-place, así compaction sigue encontrándolo en keepIds.
        const rewritten = current.id
          ? new SystemMessage({ id: current.id, content: newContent })
          : new SystemMessage(newContent);
        updates.push(rewritten);
        rewrote = true;
      }
    }

    // --- Incrementar retrieval_count de las memorias efectivamente usadas ---
    // Fire-and-forget: si falla, el turno sigue; la próxima retrieval las
    // encontrará igualmente por similitud.
    incrementRetrievalCount(
      db,
      matches.map((m) => m.id)
    ).catch((err) =>
      console.error("[memory_injection] incrementRetrievalCount failed:", err)
    );

    void logMemoryInject({
      sessionId: state.sessionId,
      userId,
      userInput,
      outcome: "ok",
      embedding: {
        model: DEFAULT_EMBEDDING_MODEL,
        dim: DEFAULT_EMBEDDING_DIM,
        latencyMs: embeddingLatency,
      },
      topicShift: {
        hasPrevEmbedding,
        cosine: cosineValue,
        threshold: topicShiftThreshold,
        shift: topicShift,
      },
      retrieval: {
        topK: retrieveTopK,
        threshold: matchThreshold,
        returned: matches.length,
        latencyMs: retrievalLatency,
        matches: matches.map((m) => ({
          type: m.type,
          content: m.content,
          similarity: m.similarity,
          retrievalCount: m.retrieval_count,
        })),
      },
      injection: {
        rewrittenSystemMessage: rewrote,
        blockChars: memoryBlock.length,
        firstSystemIdx,
        memoryBlock,
      },
      memoryFlushPending: topicShift,
    }).catch(() => {});

    return {
      ...(updates.length > 0 ? { messages: updates } : {}),
      memoryFlushPending: topicShift,
    };
  };
}
