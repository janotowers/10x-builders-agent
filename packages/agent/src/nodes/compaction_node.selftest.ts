import assert from "node:assert/strict";
import {
  AIMessage,
  HumanMessage,
  RemoveMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { messagesStateReducer } from "@langchain/langgraph";
import {
  COMPACTION_THRESHOLD,
  COMPACTION_WINDOW_TOKENS,
  RECENT_TOOL_RESULTS_KEEP,
  createCompactionNode,
} from "./compaction_node";
import type { GraphStateType } from "../state";

// --------- utilidades del self-test ---------

/** Aplica el reducer de LangGraph igual que lo haría el grafo real, para
 *  verificar el efecto neto (incluye asignación de IDs y swap/remove). */
function applyReducer(state: BaseMessage[], updates: BaseMessage[]): BaseMessage[] {
  return messagesStateReducer(state, updates);
}

/** Estado base mínimo que usa el nodo. No hace falta sessionId, etc. */
function baseState(messages: BaseMessage[], overrides: Partial<GraphStateType> = {}): GraphStateType {
  return {
    messages,
    sessionId: "s",
    userId: "u",
    systemPrompt: "sys",
    pendingConfirmation: null,
    autoApproveTools: false,
    compactionCount: 0,
    iterationCount: 0,
    ...overrides,
  } as GraphStateType;
}

function buildToolMessages(n: number): BaseMessage[] {
  const out: BaseMessage[] = [];
  for (let i = 0; i < n; i++) {
    out.push(
      new AIMessage({
        content: "",
        tool_calls: [
          { id: `call_${i}`, name: "bash", args: { prompt: `cmd ${i}` } },
        ],
      })
    );
    out.push(
      new ToolMessage({
        content: `result ${i} con mucho contenido ${"x".repeat(50)}`,
        tool_call_id: `call_${i}`,
      })
    );
  }
  return out;
}

// --------- Caso 1: microcompact preserva los últimos 5 ToolMessages ---------

async function testMicrocompactPreservesLast5() {
  const initial = [
    new SystemMessage("sys prompt"),
    new HumanMessage("hola"),
    ...buildToolMessages(8),
  ];
  const withIds = applyReducer([], initial);
  const node = createCompactionNode({
    compactionModel: {
      // No debe invocarse en este caso (bajo umbral).
      invoke: async () => {
        throw new Error("compactionModel should not be invoked under threshold");
      },
    },
  });
  const patch = await node(baseState(withIds));
  const finalMsgs = applyReducer(withIds, patch.messages ?? []);

  const toolMsgs = finalMsgs.filter((m) => m instanceof ToolMessage) as ToolMessage[];
  assert.equal(toolMsgs.length, 8, "total ToolMessages kept");

  const cleared = toolMsgs.filter((m) => m.content === "[tool result cleared]");
  const intact = toolMsgs.filter((m) => m.content !== "[tool result cleared]");
  assert.equal(
    intact.length,
    RECENT_TOOL_RESULTS_KEEP,
    `últimas ${RECENT_TOOL_RESULTS_KEEP} ToolMessages intactas`
  );
  assert.equal(cleared.length, 8 - RECENT_TOOL_RESULTS_KEEP, "viejas limpias");

  // Los últimos 5 deben ser los últimos por índice (tool_call_ids 3..7).
  const intactIds = new Set(intact.map((m) => m.tool_call_id));
  for (let i = 3; i <= 7; i++) {
    assert.ok(intactIds.has(`call_${i}`), `call_${i} debe seguir intacta`);
  }

  // Idempotente: volver a correr no cambia nada.
  const patch2 = await node(baseState(finalMsgs));
  assert.ok(
    !patch2.messages || patch2.messages.length === 0,
    "segunda pasada es no-op"
  );

  console.log("ok microcompact preserves last 5");
}

// --------- Caso 2: bajo umbral no se llama al LLM ---------

async function testBelowThresholdSkipsLLM() {
  let invoked = 0;
  const node = createCompactionNode({
    compactionModel: {
      invoke: async () => {
        invoked++;
        return new AIMessage({ content: "no deberia" });
      },
    },
  });
  const msgs = applyReducer([], [
    new SystemMessage("sys"),
    new HumanMessage("hola"),
    new AIMessage({ content: "hi" }),
  ]);
  await node(baseState(msgs));
  assert.equal(invoked, 0, "LLM no invocado bajo umbral");
  console.log("ok below-threshold skips LLM");
}

// --------- Caso 3: sobre umbral llama LLM, limpia analysis y borra viejos ---------

async function testAboveThresholdCompactsAndStripsAnalysis() {
  // Forzamos contenido enorme para superar el umbral con chars/4.
  const hugeChars = Math.floor(COMPACTION_WINDOW_TOKENS * COMPACTION_THRESHOLD * 4 * 1.1);
  const big = "x".repeat(hugeChars);
  const initial = [
    new SystemMessage("sys prompt"),
    new HumanMessage("tarea inicial"),
    new AIMessage({
      content: big,
      tool_calls: [{ id: "c1", name: "bash", args: {} }],
    }),
    new ToolMessage({ content: big, tool_call_id: "c1" }),
    new AIMessage({
      content: "",
      tool_calls: [{ id: "c2", name: "bash", args: {} }],
    }),
    new ToolMessage({ content: "result 2", tool_call_id: "c2" }),
    new AIMessage({
      content: "",
      tool_calls: [{ id: "c3", name: "bash", args: {} }],
    }),
    new ToolMessage({ content: "result 3", tool_call_id: "c3" }),
    new HumanMessage("siguiente paso"),
  ];
  const withIds = applyReducer([], initial);

  let invoked = 0;
  const node = createCompactionNode({
    compactionModel: {
      invoke: async () => {
        invoked++;
        return new AIMessage({
          content:
            "<analysis>pensando…</analysis>\n1. Objetivo del usuario: tarea inicial\n2. Hechos establecidos: N/A\n3. Decisiones tomadas: N/A\n4. Acciones pendientes: N/A\n5. Archivos/recursos tocados: N/A\n6. Herramientas invocadas y resultado: bash x3\n7. Estado actual: en curso\n8. Próximo paso sugerido: continuar\n9. Notas: N/A",
        });
      },
    },
  });
  const patch = await node(baseState(withIds));
  assert.equal(invoked, 1, "LLM invocado una vez");
  assert.equal(patch.compactionCount, 0, "contador reseteado en éxito");

  const finalMsgs = applyReducer(withIds, patch.messages ?? []);

  // Debe existir el SystemMessage de contexto compactado, sin <analysis>.
  const compacted = finalMsgs.find(
    (m) =>
      m instanceof SystemMessage &&
      String(m.content).startsWith("[CONTEXTO COMPACTADO]")
  ) as SystemMessage | undefined;
  assert.ok(compacted, "SystemMessage compactado presente");
  assert.ok(
    !String(compacted!.content).includes("<analysis>"),
    "bloque <analysis> eliminado"
  );

  // El SystemMessage inicial sigue, la última HumanMessage sigue.
  assert.ok(
    finalMsgs.some(
      (m) => m instanceof SystemMessage && String(m.content) === "sys prompt"
    ),
    "SystemMessage inicial preservado"
  );
  assert.ok(
    finalMsgs.some(
      (m) => m instanceof HumanMessage && String(m.content) === "siguiente paso"
    ),
    "última HumanMessage preservada"
  );

  // Debe haber menos mensajes que antes (se borró al menos uno).
  assert.ok(
    finalMsgs.length < withIds.length + 1,
    "messages reducidos tras compaction"
  );

  console.log("ok above-threshold compaction + analysis stripping");
}

// --------- Caso 4: circuit breaker tras 3 fallos ---------

async function testCircuitBreakerAfterFailures() {
  const hugeChars = Math.floor(COMPACTION_WINDOW_TOKENS * COMPACTION_THRESHOLD * 4 * 1.1);
  const big = "x".repeat(hugeChars);
  const initial = [
    new SystemMessage("sys"),
    new HumanMessage("q"),
    new AIMessage({
      content: big,
      tool_calls: [{ id: "c1", name: "bash", args: {} }],
    }),
    new ToolMessage({ content: big, tool_call_id: "c1" }),
    new HumanMessage("q2"),
  ];
  const withIds = applyReducer([], initial);

  let invoked = 0;
  const failingNode = createCompactionNode({
    compactionModel: {
      invoke: async () => {
        invoked++;
        throw new Error("boom");
      },
    },
  });

  // Primer fallo.
  const p1 = await failingNode(baseState(withIds, { compactionCount: 0 }));
  assert.equal(p1.compactionCount, 1);
  // Segundo fallo.
  const p2 = await failingNode(baseState(withIds, { compactionCount: 1 }));
  assert.equal(p2.compactionCount, 2);
  // Tercer fallo.
  const p3 = await failingNode(baseState(withIds, { compactionCount: 2 }));
  assert.equal(p3.compactionCount, 3);

  assert.equal(invoked, 3, "LLM invocado 3 veces");

  // Con compactionCount=3 NO debe invocarse más: passthrough con microcompact.
  const p4 = await failingNode(baseState(withIds, { compactionCount: 3 }));
  assert.equal(invoked, 3, "LLM NO invocado tras 3 fallos");
  // El patch puede contener microcompact (reemplazos) pero NO remociones.
  const removes = (p4.messages ?? []).filter((m) => m instanceof RemoveMessage);
  assert.equal(removes.length, 0, "no hay RemoveMessage en passthrough");

  console.log("ok circuit breaker after 3 failures");
}

// --------- Caso 5: guard del iterationCount no se toca ---------

async function testNoIterationCountInPatch() {
  const node = createCompactionNode({
    compactionModel: {
      invoke: async () => new AIMessage({ content: "irrelevante" }),
    },
  });
  const msgs = applyReducer([], [
    new SystemMessage("sys"),
    new HumanMessage("hi"),
  ]);
  const patch = await node(baseState(msgs, { iterationCount: 4 }));
  assert.equal(
    (patch as { iterationCount?: number }).iterationCount,
    undefined,
    "compaction_node NO debe tocar iterationCount"
  );
  console.log("ok iterationCount untouched");
}

// --------- runner ---------

async function main() {
  await testMicrocompactPreservesLast5();
  await testBelowThresholdSkipsLLM();
  await testAboveThresholdCompactsAndStripsAnalysis();
  await testCircuitBreakerAfterFailures();
  await testNoIterationCountInPatch();
  console.log("compaction_node self-test ok (5 cases)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
