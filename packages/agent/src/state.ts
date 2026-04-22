import { Annotation, messagesStateReducer } from "@langchain/langgraph";
import type { BaseMessage } from "@langchain/core/messages";
import type { PendingConfirmation } from "@agents/types";

/**
 * GraphState centralizado. Se extrajo del `graph.ts` inline original para que
 * el `compaction_node` pueda importarlo y mantener contratos tipados.
 *
 * Diferencias frente al reducer inline previo:
 * - `messages` usa `messagesStateReducer` (es el reducer estándar de LangGraph).
 *   Por default hace append, igual que el inline anterior, pero además entiende
 *   `RemoveMessage` y reemplazo por `id`. Necesario para que la etapa de LLM
 *   compaction pueda *borrar* mensajes viejos, no solo concatenar un resumen.
 * - `compactionCount`: contador de fallos consecutivos de LLM compaction para
 *   el circuit breaker del nodo.
 * - `iterationCount`: contador propio que se incrementa en `agentNode` cada vez
 *   que el modelo devuelve tool_calls. Antes se derivaba contando AIMessages en
 *   `state.messages`, pero si la compactación borra AIMessages viejos, ese
 *   conteo baja y `MAX_TOOL_ITERATIONS` deja de aplicar. Con un campo propio el
 *   guard sobrevive a cualquier borrado.
 */
export const GraphState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  sessionId: Annotation<string>(),
  userId: Annotation<string>(),
  systemPrompt: Annotation<string>(),
  pendingConfirmation: Annotation<PendingConfirmation | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  /**
   * When true, tools that would normally trigger an HITL interrupt are executed
   * directly. Used by the cron runner: the user already approved the
   * `schedule_task` itself, so inner tools should not require a second approval.
   */
  autoApproveTools: Annotation<boolean>({
    reducer: (_prev, next) => next,
    default: () => false,
  }),
  /**
   * Fallos consecutivos del LLM de compaction. Reducer de reemplazo: el nodo
   * gestiona el incremento/reset explícitamente. Cuando llega a 3 el nodo
   * deja de intentar la etapa LLM para este turno (passthrough con
   * microcompact), evitando loops infinitos.
   */
  compactionCount: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),
  /**
   * Iteraciones de tool_calls del agente en el turno actual. Reducer aditivo:
   * `agentNode` emite `{ iterationCount: 1 }` sólo cuando su respuesta trae
   * tool_calls. `shouldContinue` corta al llegar a `MAX_TOOL_ITERATIONS`.
   */
  iterationCount: Annotation<number>({
    reducer: (prev, next) => (prev ?? 0) + (next ?? 0),
    default: () => 0,
  }),
});

export type GraphStateType = typeof GraphState.State;
