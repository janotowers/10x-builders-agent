import assert from "node:assert/strict";
import {
  decomposeTurnIntents,
  looksLikeMultiIntentTurn,
  resolveIntentDecomposerModelId,
  shouldApplyDecomposition,
  type IntentDecomposerModel,
  type IntentDecomposition,
} from "./intent-decomposer";

// ── Pre-filtro determinístico ───────────────────────────────────────────────

// Turnos simples nunca pagan una llamada de modelo.
assert.equal(looksLikeMultiIntentTurn("aprobar"), false);
assert.equal(looksLikeMultiIntentTurn("sí"), false);
assert.equal(looksLikeMultiIntentTurn("aprobar el precio de salida"), false);

// Conector + pregunta ⇒ candidato a multi-intent.
assert.equal(
  looksLikeMultiIntentTurn(
    "Aprobar. Además, ¿cuántos leads generamos el mes pasado?"
  ),
  true
);
// Conector + longitud (decisión + corrección sin signo de pregunta).
assert.equal(
  looksLikeMultiIntentTurn(
    "aprobar el precio y cambia las recámaras de dos a tres por favor"
  ),
  true
);
// A1/A2: side question durante un gate pendiente amerita clasificar aunque
// no haya conector.
assert.equal(
  looksLikeMultiIntentTurn("¿cuántos leads generamos el mes pasado?", {
    hasPendingDecisions: true,
  }),
  true
);
assert.equal(
  looksLikeMultiIntentTurn("¿cuántos leads generamos el mes pasado?", {
    hasPendingDecisions: false,
  }),
  false,
  "sin decisiones pendientes, una pregunta suelta no amerita el modelo"
);

// ── Piso conservador ────────────────────────────────────────────────────────

const message = "Aprobar. Además, ¿cuántos leads generamos el mes pasado?";
const goodSplit: IntentDecomposition = {
  multi_intent: true,
  confidence: "high",
  intents: [
    { text: "Aprobar", kind: "decision", confidence: "high" },
    {
      text: "¿cuántos leads generamos el mes pasado?",
      kind: "question",
      confidence: "high",
    },
  ],
};

assert.equal(shouldApplyDecomposition(message, goodSplit), true);
assert.equal(shouldApplyDecomposition(message, null), false, "fail-open");
assert.equal(
  shouldApplyDecomposition(message, { ...goodSplit, multi_intent: false }),
  false
);
assert.equal(
  shouldApplyDecomposition(message, { ...goodSplit, confidence: "medium" }),
  false,
  "solo confianza global high aplica el split"
);
assert.equal(
  shouldApplyDecomposition(message, {
    ...goodSplit,
    intents: [goodSplit.intents[0]],
  }),
  false,
  "un solo intent no es split"
);
assert.equal(
  shouldApplyDecomposition(message, {
    ...goodSplit,
    intents: [
      goodSplit.intents[0],
      { ...goodSplit.intents[1], confidence: "low" },
    ],
  }),
  false,
  "cualquier intent low tumba el split"
);
// Regla anti-invención: un span que no existe en el mensaje no pasa.
assert.equal(
  shouldApplyDecomposition(message, {
    ...goodSplit,
    intents: [
      goodSplit.intents[0],
      { text: "agenda una visita al notario", kind: "other", confidence: "high" },
    ],
  }),
  false,
  "un intent alucinado no pasa el guard de contención"
);
// La contención es tolerante a acentos/puntuación (spans normalizados).
assert.equal(
  shouldApplyDecomposition(message, {
    ...goodSplit,
    intents: [
      { text: "aprobar", kind: "decision", confidence: "high" },
      {
        text: "cuantos leads generamos el mes pasado",
        kind: "question",
        confidence: "high",
      },
    ],
  }),
  true
);

// ── decomposeTurnIntents: normalización + fail-open ─────────────────────────

async function run() {
  const validModel: IntentDecomposerModel = {
    async decompose() {
      return goodSplit;
    },
  };
  const invalidModel: IntentDecomposerModel = {
    async decompose() {
      return { multi_intent: "yes", intents: "aprobar" };
    },
  };
  const throwModel: IntentDecomposerModel = {
    async decompose() {
      throw new Error("boom");
    },
  };
  const emptyIntentModel: IntentDecomposerModel = {
    async decompose() {
      return {
        multi_intent: true,
        confidence: "high",
        intents: [
          { text: "   ", kind: "decision", confidence: "high" },
          { text: "Aprobar", kind: "decision", confidence: "high" },
        ],
      };
    },
  };

  {
    const result = await decomposeTurnIntents({ message }, validModel);
    assert.equal(result?.multi_intent, true);
    assert.equal(result?.intents.length, 2);
  }
  {
    const result = await decomposeTurnIntents({ message }, invalidModel);
    assert.equal(result, null, "JSON con esquema inválido debe fallar abierto");
  }
  {
    const result = await decomposeTurnIntents({ message }, throwModel);
    assert.equal(result, null, "errores del modelo deben fallar abiertos");
  }
  {
    const result = await decomposeTurnIntents({ message: "   " }, validModel);
    assert.equal(result, null, "mensaje vacío no clasifica");
  }
  {
    const result = await decomposeTurnIntents({ message }, emptyIntentModel);
    assert.equal(
      result?.intents.length,
      1,
      "los intents vacíos se filtran en la normalización"
    );
  }

  // Cadena de resolución de modelo §9.1 (sin tocar el entorno real más allá
  // de este proceso de test).
  const savedDecomposer = process.env.WORKFLOW_INTENT_DECOMPOSER_MODEL_ID;
  const savedClassifier = process.env.OPERATIONAL_CONVERSATION_CLASSIFIER_MODEL_ID;
  try {
    process.env.WORKFLOW_INTENT_DECOMPOSER_MODEL_ID = "test/decomposer-model";
    assert.equal(resolveIntentDecomposerModelId(), "test/decomposer-model");
    delete process.env.WORKFLOW_INTENT_DECOMPOSER_MODEL_ID;
    process.env.OPERATIONAL_CONVERSATION_CLASSIFIER_MODEL_ID =
      "test/classifier-model";
    assert.equal(resolveIntentDecomposerModelId(), "test/classifier-model");
    delete process.env.OPERATIONAL_CONVERSATION_CLASSIFIER_MODEL_ID;
    assert.ok(
      resolveIntentDecomposerModelId().length > 0,
      "último recurso: MAIN_AGENT_MODEL_ID"
    );
  } finally {
    if (savedDecomposer !== undefined) {
      process.env.WORKFLOW_INTENT_DECOMPOSER_MODEL_ID = savedDecomposer;
    }
    if (savedClassifier !== undefined) {
      process.env.OPERATIONAL_CONVERSATION_CLASSIFIER_MODEL_ID = savedClassifier;
    }
  }

  console.log("intent-decomposer.selftest: ok");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
