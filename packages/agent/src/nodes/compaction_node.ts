import {
  AIMessage,
  HumanMessage,
  RemoveMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { GraphStateType } from "../state";
import {
  buildLogHeader,
  formatMessageBreakdown,
  formatMessagesSnapshot,
  isVerboseLog,
  previewMultiline,
  previewOneLine,
  resolvePreviewChars,
  resolveSummaryPreviewChars,
  resolveTranscriptPreviewChars,
  writeCompactionLogBlock,
} from "./compaction_log";

/** Ventana objetivo de tokens de entrada para el modelo principal del agente.
 *  gpt-4o-mini acepta 128k pero dejamos un colchón amplio. Ajustable por env
 *  `COMPACTION_WINDOW_TOKENS` sin tocar código. */
function resolveWindowTokens(): number {
  const raw = process.env.COMPACTION_WINDOW_TOKENS?.trim();
  if (!raw) return 120_000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 120_000;
}

export const COMPACTION_WINDOW_TOKENS = resolveWindowTokens();

/**
 * Fracción de `COMPACTION_WINDOW_TOKENS` a partir de la cual se dispara la
 * **etapa 2** (compactación con LLM / Haiku). Por debajo solo corre la etapa 1
 * (microcompact de tool results, costo ~0).
 *
 * Se usa 0.8 (80%) y no 1.0 para dejar margen: la propia llamada al compactador
 * y el resumen de 9 secciones consumen tokens; si esperáramos al 100% del
 * contexto del agente principal, el turno podría quedar sin aire antes de
 * compactar. El umbral en tokens efectivo es
 * `floor(COMPACTION_WINDOW_TOKENS * COMPACTION_THRESHOLD)` (ver `needsLLMCompaction`).
 */
export const COMPACTION_THRESHOLD = 0.001;

/** Cantidad de `ToolMessage` recientes que la etapa 1 (microcompact) NUNCA
 *  limpia. Sirve para que el modelo vea los resultados operativos más
 *  recientes sin interferencia. */
export const RECENT_TOOL_RESULTS_KEEP = 5;

/** Cantidad de mensajes operativos (AI/Tool) recientes que la etapa 2
 *  (LLM compaction) conserva además del SystemMessage inicial y la última
 *  HumanMessage. */
export const RECENT_OPS_KEEP = 5;

/** Tras este número de fallos consecutivos del LLM, el nodo deja de intentar
 *  la etapa 2 (passthrough con microcompact). Evita loops infinitos si el
 *  endpoint del compactador está caído. */
export const COMPACTION_MAX_FAILURES = 3;

const TOOL_RESULT_CLEARED = "[tool result cleared]";

/**
 * Prompt del compactador. Pide 9 secciones estructuradas que cubren lo mínimo
 * para que el agente continúe operando sin el historial completo. Los bloques
 * `<analysis>` se eliminan antes de reinyectar (algunos modelos los usan como
 * scratchpad interno y no queremos gastar tokens ni contexto en eso).
 */
const COMPACTION_SYSTEM_PROMPT = `Eres un compactador de historial de conversación. Resume el siguiente transcript del agente en 9 secciones EXACTAS, en español, sin inventar nada que no esté en el transcript. Si una sección no aplica, escribe "N/A" en una sola línea.

Formato obligatorio (títulos exactos):
1. Objetivo del usuario:
2. Hechos establecidos:
3. Decisiones tomadas:
4. Acciones pendientes:
5. Archivos/recursos tocados:
6. Herramientas invocadas y resultado:
7. Estado actual:
8. Próximo paso sugerido:
9. Notas:

Reglas:
- Sé conciso: bullets cortos, no prosa larga.
- No copies tool outputs completos; resume.
- Si usas un bloque <analysis>...</analysis> como scratchpad, el sistema lo eliminará, así que evítalo.`;

const ANALYSIS_BLOCK_REGEX = /<analysis>[\s\S]*?<\/analysis>/g;

/** Serializa el content de un BaseMessage a string para estimación y prompt. */
function contentToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === "string") return p;
        if (p && typeof p === "object" && "text" in p) {
          return String((p as { text: unknown }).text ?? "");
        }
        return JSON.stringify(p);
      })
      .join("\n");
  }
  if (content == null) return "";
  return JSON.stringify(content);
}

/** Heurística tokens = chars/4. Buena aproximación para texto en español +
 *  JSON, suficiente para decidir el umbral de 80% con margen conservador. */
function estimateTokens(messages: BaseMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += contentToString(m.content).length;
    if (m instanceof AIMessage && m.tool_calls?.length) {
      chars += JSON.stringify(m.tool_calls).length;
    }
  }
  return Math.ceil(chars / 4);
}

/** Serializa un mensaje a una línea legible para el prompt del compactador. */
function formatForTranscript(m: BaseMessage): string {
  const type = m.getType();
  const body = contentToString(m.content).trim();
  if (m instanceof AIMessage && m.tool_calls?.length) {
    const calls = m.tool_calls
      .map((tc) => `${tc.name}(${JSON.stringify(tc.args ?? {})})`)
      .join(", ");
    return `[ai tool_calls=${calls}]${body ? `\n${body}` : ""}`;
  }
  if (m instanceof ToolMessage) {
    return `[tool result tool_call_id=${m.tool_call_id}]\n${body}`;
  }
  return `[${type}]\n${body}`;
}

/**
 * Contrato estructural mínimo del modelo de compactación: sólo necesitamos
 * invocarlo con un array de BaseMessage y recibir algo que tenga `content`.
 * Se define así (y no como `Pick<ChatOpenAI, "invoke">`) para no acoplar el
 * nodo a los tipos exactos del SDK y permitir mocks simples en los tests.
 */
export interface CompactionModelLike {
  invoke: (messages: BaseMessage[]) => Promise<{ content: unknown }>;
}

interface CompactionNodeDeps {
  compactionModel: CompactionModelLike;
}

/**
 * Factory del compaction node. Se instancia por ejecución de `runAgent` para
 * inyectar el modelo de compactación sin atar el nodo a una decisión global.
 *
 * El nodo es **transparente**: si no hay nada que hacer devuelve `{}` y el
 * grafo continúa como si no existiera. No toca HITL, ni el autoApprove, ni
 * las tool_calls pendientes.
 */
export function createCompactionNode(deps: CompactionNodeDeps) {
  const { compactionModel } = deps;

  return async function compactionNode(
    state: GraphStateType
  ): Promise<Partial<GraphStateType>> {
    const messages = state.messages ?? [];
    if (messages.length === 0) return {};

    const sessionIdForLog = state.sessionId ?? "(no-session)";
    const verbose = isVerboseLog();
    // Buffer de secciones del log. Al final se concatenan con "\n\n" para que
    // cada bloque lógico quede visualmente separado como en las capturas.
    const logSections: string[] = [buildLogHeader(sessionIdForLog)];

    const tokensPre = estimateTokens(messages);

    // -------------------- Etapa 1: microcompact --------------------
    // Limpia el contenido de ToolMessages antiguos (todos salvo los últimos
    // RECENT_TOOL_RESULTS_KEEP). Mantiene tool_call_id y posición en la
    // secuencia emitiendo un reemplazo con el MISMO id (messagesStateReducer
    // hace swap in-place cuando coincide el id).
    const toolIndices: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      if (messages[i] instanceof ToolMessage) toolIndices.push(i);
    }
    const keepFromIdx =
      toolIndices.length > RECENT_TOOL_RESULTS_KEEP
        ? toolIndices[toolIndices.length - RECENT_TOOL_RESULTS_KEEP]
        : -1;

    const microUpdates: BaseMessage[] = [];
    type ClearedEntry = { id: string; call: string; previewBefore: string };
    const cleared: ClearedEntry[] = [];
    const previewChars = resolvePreviewChars();
    for (const idx of toolIndices) {
      if (idx >= keepFromIdx) break;
      const tm = messages[idx] as ToolMessage;
      if (!tm.id) continue; // sin id no podemos reemplazar en sitio
      const current = contentToString(tm.content);
      if (current === TOOL_RESULT_CLEARED) continue; // ya limpio, idempotente
      cleared.push({
        id: String(tm.id).slice(0, 8),
        call: tm.tool_call_id,
        previewBefore: previewOneLine(current, previewChars),
      });
      microUpdates.push(
        new ToolMessage({
          id: tm.id,
          tool_call_id: tm.tool_call_id,
          content: TOOL_RESULT_CLEARED,
        })
      );
    }

    // Bloque MICROCOMPACT (siempre presente).
    if (cleared.length === 0) {
      logSections.push(
        `MICROCOMPACT — nothing to clear (tool results ≤ ${RECENT_TOOL_RESULTS_KEEP})\n  messages: ${messages.length} — tokens: ${tokensPre}`
      );
    } else {
      const kept = Math.min(toolIndices.length, RECENT_TOOL_RESULTS_KEEP);
      const lines: string[] = [];
      lines.push(
        `MICROCOMPACT — cleared ${cleared.length} tool result(s), kept ${kept}`
      );
      lines.push(`  total messages before: ${messages.length}`);
      lines.push(
        `  total messages after:  ${messages.length} (mismo conteo, cleared messages):`
      );
      for (const c of cleared) {
        lines.push(`    - [Tool ${c.call}] id=${c.id} "${c.previewBefore}"`);
      }
      logSections.push(lines.join("\n"));
    }

    // Mensajes "efectivos" tras aplicar microcompact (solo para estimar
    // tokens de la etapa 2; no modificamos state aquí).
    const effectiveMessages = messages.map((m) => {
      if (!(m instanceof ToolMessage)) return m;
      const hit = microUpdates.find((u) => u.id === m.id);
      return hit ?? m;
    });

    // -------------------- Etapa 2: LLM compaction --------------------
    const tokens = estimateTokens(effectiveMessages);
    const threshold = Math.floor(COMPACTION_WINDOW_TOKENS * COMPACTION_THRESHOLD);
    const needsLLMCompaction = tokens >= threshold;
    const occupancy = tokens / COMPACTION_WINDOW_TOKENS;
    const occupancyPct = (occupancy * 100).toFixed(1);
    const thresholdPct = (COMPACTION_THRESHOLD * 100).toFixed(1);

    if (!needsLLMCompaction) {
      logSections.push(
        `LLM COMPACTION — skipped (occupancy ${occupancyPct}% < ${thresholdPct}%)`
      );
      await flushSections(logSections, effectiveMessages, null, null, verbose);
      return microUpdates.length > 0 ? { messages: microUpdates } : {};
    }

    // Circuit breaker: si ya fallamos 3 veces en este turno no intentamos más.
    if ((state.compactionCount ?? 0) >= COMPACTION_MAX_FAILURES) {
      logSections.push(
        `LLM COMPACTION — skipped (circuit breaker: compactionCount=${state.compactionCount} ≥ ${COMPACTION_MAX_FAILURES})`
      );
      await flushSections(logSections, effectiveMessages, null, null, verbose);
      return microUpdates.length > 0 ? { messages: microUpdates } : {};
    }

    // Identificamos qué preservar: primer SystemMessage, última HumanMessage y
    // los últimos RECENT_OPS_KEEP mensajes operativos (AI/Tool).
    const keepIds = new Set<string>();
    const initialSystemIdx = messages.findIndex((m) => m instanceof SystemMessage);
    if (initialSystemIdx >= 0 && messages[initialSystemIdx].id) {
      keepIds.add(messages[initialSystemIdx].id!);
    }
    let lastHumanIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i] instanceof HumanMessage) {
        lastHumanIdx = i;
        break;
      }
    }
    if (lastHumanIdx >= 0 && messages[lastHumanIdx].id) {
      keepIds.add(messages[lastHumanIdx].id!);
    }
    // Últimos N mensajes operativos (AI/Tool), recorriendo desde el final.
    let opsKept = 0;
    for (let i = messages.length - 1; i >= 0 && opsKept < RECENT_OPS_KEEP; i--) {
      const m = messages[i];
      if (m instanceof AIMessage || m instanceof ToolMessage) {
        if (m.id) {
          keepIds.add(m.id);
          opsKept++;
        }
      }
    }

    // Bloque TRIGGERED + BEFORE (antes de invocar al LLM).
    const beforeHeader: string[] = [
      `LLM COMPACTION — TRIGGERED (occupancy ${occupancyPct}% ≥ ${thresholdPct}%)`,
      `BEFORE: ${effectiveMessages.length} messages — ${tokens} tokens`,
      `BEFORE message breakdown:`,
      formatMessageBreakdown(effectiveMessages),
    ];
    logSections.push(beforeHeader.join("\n"));

    // Construimos el transcript para el compactador (usamos los mensajes ya
    // microcompactados para no gastar tokens en tool results viejos).
    const transcript = effectiveMessages.map(formatForTranscript).join("\n\n");
    const summaryPrompt = `${COMPACTION_SYSTEM_PROMPT}\n\n--- TRANSCRIPT ---\n${transcript}\n--- FIN ---`;

    let summary: string;
    try {
      const response = await compactionModel.invoke([
        new SystemMessage(summaryPrompt),
      ]);
      const raw = contentToString(
        (response as { content: unknown }).content
      );
      summary = raw.replace(ANALYSIS_BLOCK_REGEX, "").trim();
      if (!summary) throw new Error("empty compaction summary");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[compaction_node] LLM compaction failed:", err);
      logSections.push(`LLM COMPACTION — ERROR: ${msg}`);
      if (verbose) {
        logSections.push(
          err instanceof Error && err.stack ? err.stack : String(err)
        );
      }
      await flushSections(logSections, effectiveMessages, null, null, verbose);
      return {
        messages: microUpdates,
        compactionCount: (state.compactionCount ?? 0) + 1,
      };
    }

    // Éxito: emitimos RemoveMessage para todo lo que no está en keepIds y
    // añadimos el resumen como SystemMessage nuevo.
    const removals: BaseMessage[] = [];
    for (const m of messages) {
      if (!m.id) continue;
      if (keepIds.has(m.id)) continue;
      removals.push(new RemoveMessage({ id: m.id }));
    }
    const summaryMessage = new SystemMessage(
      `[CONTEXTO COMPACTADO]\n${summary}`
    );

    // Vista AFTER: simulamos cómo quedaría el historial tras aplicar
    // microUpdates + RemoveMessage + SystemMessage nuevo. Esto es lo que
    // verá el `agent_node` en su próximo turno.
    const keepIdsSet = keepIds;
    const afterMessages: BaseMessage[] = effectiveMessages.filter(
      (m) => m.id && keepIdsSet.has(m.id)
    );
    afterMessages.push(summaryMessage);
    const tokensAfter = estimateTokens(afterMessages);
    const saved = tokens - tokensAfter;

    const afterLines: string[] = [
      `LLM COMPACTION — SUCCESS`,
      `AFTER: ${afterMessages.length} messages — ~${tokensAfter} tokens (saved ~${saved} tokens)`,
      `AFTER message breakdown:`,
      formatMessageBreakdown(afterMessages),
      `SUMMARY (first ${resolveSummaryPreviewChars()} chars):`,
      previewMultiline(summary, resolveSummaryPreviewChars()),
    ];
    logSections.push(afterLines.join("\n"));

    // Combinamos: primero los reemplazos de microcompact (puede haber mensajes
    // que también van a ser removidos; si el id coincide, RemoveMessage gana
    // porque se procesa después gracias al orden del array). Luego las
    // remociones y por último el resumen.
    const updates: BaseMessage[] = [
      ...microUpdates,
      ...removals,
      summaryMessage,
    ];

    await flushSections(
      logSections,
      effectiveMessages,
      afterMessages,
      transcript,
      verbose
    );

    return {
      messages: updates,
      compactionCount: 0,
    };
  };
}

/**
 * Concatena las secciones del log y añade (opcional) el anexo VERBOSE con los
 * snapshots detallados y el transcript enviado al LLM. Termina escribiendo
 * todo en el archivo con una línea en blanco de separación.
 */
async function flushSections(
  sections: string[],
  effectiveMessages: BaseMessage[],
  afterMessages: BaseMessage[] | null,
  transcript: string | null,
  verbose: boolean
): Promise<void> {
  const parts = [...sections];
  if (verbose) {
    parts.push(
      formatMessagesSnapshot(
        effectiveMessages,
        "VERBOSE snapshot: effective (post-microcompact)"
      )
    );
    if (afterMessages) {
      parts.push(
        formatMessagesSnapshot(
          afterMessages,
          "VERBOSE snapshot: after (lo que verá el agente)"
        )
      );
    }
    if (transcript) {
      parts.push(
        `VERBOSE transcript (${transcript.length} chars, primeros ${resolveTranscriptPreviewChars()}):\n${previewMultiline(transcript, resolveTranscriptPreviewChars())}`
      );
    }
  }
  await writeCompactionLogBlock(parts.join("\n\n"));
}
