/**
 * Escenarios normativos A1/A2/B1/B2/D (Technical Plan §12; analysis §12.5)
 * como fixtures del multiplexer de turno (Slice 4.1). El modelo y el router
 * van inyectados (mismo patrón de mocking que los selftests de
 * clasificadores): aquí se verifica el CONTRATO de composición — nunca
 * pérdida silenciosa, nunca aprobación con monto discrepante, deferral
 * explícito de lo no actuado. Los gates reales tienen sus propios selftests.
 */
import assert from "node:assert/strict";
import type { DbClient } from "@agents/db";
import type { InternalUserNotification } from "@agents/types";
import {
  composePendingDecisionTurns,
  resolveDecomposedPendingDecisionTurn,
  type DecomposedTurnDeps,
} from "./decomposed-turn";
import type {
  PendingDecisionTurn,
  PendingDecisionTurnParams,
} from "./pending-decision-router";
import type { IntentDecomposition } from "./intent-decomposer";
import { deferredAgentContinuationText } from "./residual-intent";

const db = null as unknown as DbClient;

function pending(kinds: string[]): InternalUserNotification[] {
  return kinds.map(
    (kind, index) =>
      ({ id: `n-${index}`, kind }) as unknown as InternalUserNotification
  );
}

/**
 * Router simulado con la semántica documentada de los gates:
 *  - "aprobar" sin monto (o con monto igual a la propuesta 5.2M) ⇒ aprueba;
 *  - "aprobar $X" con monto distinto ⇒ clarifica y NO aprueba (Finding 3);
 *  - corrección de recámaras ⇒ actualización selectiva (C1);
 *  - preguntas/analytics ⇒ ningún gate coincide (handled: false).
 */
function makeFakeRouter() {
  const applied: string[] = [];
  const afterReplyRuns: string[] = [];
  const routedTexts: string[] = [];
  const routeTurn = async (
    _db: DbClient,
    params: PendingDecisionTurnParams
  ): Promise<PendingDecisionTurn> => {
    const text = params.text.toLowerCase();
    routedTexts.push(params.text);
    if (text.includes("aprobar")) {
      const amount = text.match(/\$?\s*([\d.]+)\s*m/);
      if (amount && amount[1] !== "5.2") {
        return {
          handled: true,
          routed: "price_approval",
          ok: false,
          status: "amount_mismatch",
          caseId: "case-1",
          notificationId: "n-price",
          message:
            "Mencionaste $4.8M pero la propuesta registrada es $5.2M. ¿Confirmas la propuesta o la ajustamos?",
          residual: null,
        };
      }
      applied.push("price_approval");
      return {
        handled: true,
        routed: "price_approval",
        ok: true,
        status: "approved",
        caseId: "case-1",
        notificationId: "n-price",
        decision: "approved",
        message: "Listo: precio aprobado con la propuesta registrada ($5.2M).",
        residual: null,
        runAfterReply: async () => {
          afterReplyRuns.push("price_approval");
        },
      };
    }
    if (text.includes("recámaras") || text.includes("recamaras")) {
      applied.push("case_data_update");
      return {
        handled: true,
        routed: "case_data_update",
        ok: true,
        status: "updated",
        caseId: "case-1",
        message:
          "Actualicé las recámaras de 2 a 3. Se refrescará la descripción comercial; la valuación no cambia.",
        residual: null,
        runAfterReply: async () => {
          afterReplyRuns.push("case_data_update");
        },
      };
    }
    return { handled: false };
  };
  return { routeTurn, applied, afterReplyRuns, routedTexts };
}

function depsWith(
  fake: ReturnType<typeof makeFakeRouter>,
  decomposition: IntentDecomposition | null,
  logs: Array<Record<string, unknown>>
): DecomposedTurnDeps {
  return {
    routeTurn: fake.routeTurn,
    decompose: async () => decomposition,
    log: (entry) => logs.push(entry),
  };
}

const LEADS_QUESTION = "¿cuántos leads generamos el mes pasado?";

async function scenarioA1() {
  // A1: side question con price_approval pendiente. El turno se contesta por
  // el agente (handled: false aquí), la aprobación queda intacta y la
  // liberación queda REGISTRADA (no solo "ningún gate coincidió").
  const fake = makeFakeRouter();
  const logs: Array<Record<string, unknown>> = [];
  const decomposition: IntentDecomposition = {
    multi_intent: false,
    confidence: "high",
    intents: [{ text: LEADS_QUESTION, kind: "question", confidence: "high" }],
  };
  const turn = await resolveDecomposedPendingDecisionTurn(
    db,
    {
      userId: "u1",
      text: LEADS_QUESTION,
      channel: "telegram",
      pendingNotifications: pending(["price_approval"]),
    },
    depsWith(fake, decomposition, logs)
  );
  assert.equal(turn.handled, false, "A1: el turno cae al agente");
  assert.deepEqual(fake.applied, [], "A1: la aprobación queda sin tocar");
  assert.deepEqual(fake.routedTexts, [LEADS_QUESTION], "A1: texto íntegro");
  const released = logs.find((entry) => entry.event === "side_question_released");
  assert.ok(released, "A1: la liberación queda registrada");
  assert.deepEqual(released?.pending_kinds, ["price_approval"]);
  console.log("✓ A1: side question con price_approval pendiente");
}

async function scenarioA2() {
  // A2: misma side question con un gate pegajoso (contract_data_review)
  // pendiente. Sin depender de suerte de fraseo: la clasificación question
  // registra la liberación; la decisión pendiente no avanza.
  const fake = makeFakeRouter();
  const logs: Array<Record<string, unknown>> = [];
  const decomposition: IntentDecomposition = {
    multi_intent: false,
    confidence: "medium",
    intents: [{ text: LEADS_QUESTION, kind: "question", confidence: "medium" }],
  };
  const turn = await resolveDecomposedPendingDecisionTurn(
    db,
    {
      userId: "u1",
      text: LEADS_QUESTION,
      channel: "web",
      pendingNotifications: pending(["contract_data_review"]),
    },
    depsWith(fake, decomposition, logs)
  );
  assert.equal(turn.handled, false, "A2: el turno cae al agente");
  assert.deepEqual(fake.applied, [], "A2: el gate pegajoso no se resuelve");
  assert.ok(
    logs.some((entry) => entry.event === "side_question_released"),
    "A2: liberación registrada también en gates pegajosos"
  );
  console.log("✓ A2: side question con contract_data_review pendiente");
}

async function scenarioB1() {
  // B1: decisión + pregunta no relacionada. La decisión se aplica a la
  // propuesta registrada; la pregunta persiste explícitamente (residual) en
  // UNA respuesta compuesta — nunca descarte silencioso.
  const fake = makeFakeRouter();
  const logs: Array<Record<string, unknown>> = [];
  const text = `Aprobar. Además, ${LEADS_QUESTION}`;
  const decomposition: IntentDecomposition = {
    multi_intent: true,
    confidence: "high",
    intents: [
      { text: "Aprobar", kind: "decision", confidence: "high" },
      { text: LEADS_QUESTION, kind: "question", confidence: "high" },
    ],
  };
  const turn = await resolveDecomposedPendingDecisionTurn(
    db,
    {
      userId: "u1",
      text,
      channel: "telegram",
      pendingNotifications: pending(["price_approval"]),
    },
    depsWith(fake, decomposition, logs)
  );
  assert.ok(turn.handled, "B1: turno manejado");
  if (!turn.handled) return;
  assert.equal(turn.ok, true);
  assert.deepEqual(fake.applied, ["price_approval"], "B1: una sola aprobación");
  assert.ok(turn.message.includes("precio aprobado"));
  assert.equal(turn.residual?.reason, "unmatched_intent");
  assert.ok(
    turn.residual?.text.includes("leads"),
    "B1: la pregunta no consumida queda en el residual"
  );
  // Slice 4.1-5: el residual unmatched_intent es señal de continuación al
  // agente (los adaptadores re-despachan este texto tras el ack). El ack
  // "No actué sobre" queda solo para unparsed_remainder / fallback.
  const continuation = deferredAgentContinuationText({ residual: turn.residual });
  assert.ok(continuation, "B1: hay texto de continuación al agente");
  assert.ok(
    continuation!.includes("leads"),
    "B1: la continuación es la pregunta diferida"
  );
  assert.equal(
    deferredAgentContinuationText({
      residual: { text: "resto del parser", reason: "unparsed_remainder" },
    }),
    null,
    "B1: unparsed_remainder NO continúa al agente"
  );
  assert.ok(
    logs.some((entry) => entry.event === "decomposition_applied"),
    "B1: instrumentación del split"
  );
  console.log(
    "✓ B1: decisión + pregunta ⇒ efecto aplicado + continuación al agente"
  );
}

async function scenarioB2() {
  // B2 (Finding 3): monto discrepante ⇒ clarificar, NUNCA aprobar. La side
  // question del mismo turno queda igualmente reconocida.
  const fake = makeFakeRouter();
  const logs: Array<Record<string, unknown>> = [];
  const text = `Aprobar $4.8M y dime ${LEADS_QUESTION}`;
  const decomposition: IntentDecomposition = {
    multi_intent: true,
    confidence: "high",
    intents: [
      { text: "Aprobar $4.8M", kind: "decision", confidence: "high" },
      { text: LEADS_QUESTION, kind: "question", confidence: "high" },
    ],
  };
  const turn = await resolveDecomposedPendingDecisionTurn(
    db,
    {
      userId: "u1",
      text,
      channel: "telegram",
      pendingNotifications: pending(["price_approval"]),
    },
    depsWith(fake, decomposition, logs)
  );
  assert.ok(turn.handled, "B2: el gate de precio reclama el intent");
  if (!turn.handled) return;
  assert.equal(turn.ok, false, "B2: no aprobado");
  assert.equal(turn.status, "amount_mismatch");
  assert.deepEqual(fake.applied, [], "B2: cero aprobaciones aplicadas");
  assert.ok(turn.message.includes("$5.2M"), "B2: clarifica contra la propuesta");
  assert.ok(
    turn.residual?.text.includes("leads"),
    "B2: la side question no se pierde en silencio"
  );
  console.log("✓ B2: monto discrepante ⇒ clarifica sin aprobar; pregunta reconocida");
}

async function scenarioD() {
  // D: tres intents — aprobación + corrección de datos + pregunta. Cada uno
  // se ejecuta o se reporta explícitamente como no actuado; la respuesta es
  // compuesta, nunca una sola confirmación que implique que todo se atendió.
  const fake = makeFakeRouter();
  const logs: Array<Record<string, unknown>> = [];
  const text = `Aprobar, cambia las recámaras de dos a tres y dime ${LEADS_QUESTION}`;
  const decomposition: IntentDecomposition = {
    multi_intent: true,
    confidence: "high",
    intents: [
      { text: "Aprobar", kind: "decision", confidence: "high" },
      {
        text: "cambia las recámaras de dos a tres",
        kind: "data_update",
        confidence: "high",
      },
      { text: LEADS_QUESTION, kind: "question", confidence: "high" },
    ],
  };
  const turn = await resolveDecomposedPendingDecisionTurn(
    db,
    {
      userId: "u1",
      text,
      channel: "telegram",
      pendingNotifications: pending(["price_approval"]),
    },
    depsWith(fake, decomposition, logs)
  );
  assert.ok(turn.handled, "D: turno manejado");
  if (!turn.handled) return;
  assert.equal(turn.ok, true);
  assert.equal(turn.status, "composed");
  assert.equal(turn.routed, "price_approval+case_data_update");
  assert.deepEqual(
    fake.applied,
    ["price_approval", "case_data_update"],
    "D: ambos efectos persisten de forma independiente"
  );
  assert.ok(turn.message.includes("precio aprobado"), "D: ack de aprobación");
  assert.ok(turn.message.includes("recámaras"), "D: ack de corrección (C1 selectivo)");
  assert.ok(
    turn.residual?.text.includes("leads") &&
      turn.residual.reason === "unmatched_intent",
    "D: la pregunta se difiere explícitamente, no se descarta"
  );
  // runAfterReply compuesto conserva el orden de los gates.
  assert.ok(turn.runAfterReply, "D: after-reply compuesto presente");
  await turn.runAfterReply?.();
  assert.deepEqual(fake.afterReplyRuns, ["price_approval", "case_data_update"]);
  console.log("✓ D: tres intents ⇒ dos ejecutados + uno diferido explícito");
}

async function edgeCases() {
  // Ningún intent manejado ⇒ handled:false y el turno COMPLETO va al agente.
  {
    const fake = makeFakeRouter();
    const decomposition: IntentDecomposition = {
      multi_intent: true,
      confidence: "high",
      intents: [
        { text: "dime cuántos leads llegaron", kind: "question", confidence: "high" },
        { text: "cuántas visitas hubo", kind: "question", confidence: "high" },
      ],
    };
    const turn = await resolveDecomposedPendingDecisionTurn(
      db,
      {
        userId: "u1",
        text: "dime cuántos leads llegaron y cuántas visitas hubo",
        channel: "web",
        pendingNotifications: pending(["price_approval"]),
      },
      depsWith(fake, decomposition, [])
    );
    assert.equal(turn.handled, false, "sin gate que reclame ⇒ agente");
  }

  // Comandos y arranques explícitos de caso nunca se descomponen.
  {
    const fake = makeFakeRouter();
    let decomposeCalls = 0;
    const turn = await resolveDecomposedPendingDecisionTurn(
      db,
      {
        userId: "u1",
        text: "/start y además aprobar el precio, ¿cuántos leads llegaron?",
        channel: "telegram",
        isCommand: true,
      },
      {
        routeTurn: fake.routeTurn,
        decompose: async () => {
          decomposeCalls += 1;
          return null;
        },
        log: () => {},
      }
    );
    assert.equal(decomposeCalls, 0, "comando: sin llamada al decomposer");
    assert.ok(turn.handled, "comando: passthrough directo al router");
  }

  // Piso no alcanzado (confianza media) ⇒ passthrough con texto íntegro y
  // registro de mis-split candidato.
  {
    const fake = makeFakeRouter();
    const logs: Array<Record<string, unknown>> = [];
    const text = `Aprobar. Además, ${LEADS_QUESTION}`;
    const decomposition: IntentDecomposition = {
      multi_intent: true,
      confidence: "medium",
      intents: [
        { text: "Aprobar", kind: "decision", confidence: "high" },
        { text: LEADS_QUESTION, kind: "question", confidence: "high" },
      ],
    };
    const turn = await resolveDecomposedPendingDecisionTurn(
      db,
      {
        userId: "u1",
        text,
        channel: "telegram",
        pendingNotifications: pending(["price_approval"]),
      },
      depsWith(fake, decomposition, logs)
    );
    assert.ok(turn.handled, "piso no alcanzado: el router ve el turno entero");
    assert.deepEqual(fake.routedTexts, [text]);
    assert.ok(
      logs.some((entry) => entry.event === "decomposition_rejected"),
      "mis-split candidato instrumentado"
    );
  }

  // Composición pura: sin manejados ⇒ handled:false.
  assert.deepEqual(
    composePendingDecisionTurns([
      {
        intent: { text: "x", kind: "question", confidence: "high" },
        turn: { handled: false },
      },
    ]),
    { handled: false }
  );

  console.log("✓ edge cases: passthrough, comandos, piso, composición vacía");
}

async function main() {
  await scenarioA1();
  await scenarioA2();
  await scenarioB1();
  await scenarioB2();
  await scenarioD();
  await edgeCases();
  console.log("decomposed-turn.selftest: ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
