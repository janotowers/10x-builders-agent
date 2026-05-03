import assert from "node:assert/strict";
import {
  EXTRACTION_SYSTEM_PROMPT,
  extractJsonArray,
  validateExtracted,
  extractMemoriesFromTranscript,
  type ExtractedMemory,
} from "./memory_flush";

/**
 * Selftest del extractor de memoria a largo plazo.
 *
 * Tres niveles:
 *
 *   1. STATIC — verifica que el `EXTRACTION_SYSTEM_PROMPT` contiene las
 *      reglas críticas (5 datos transaccionales, 6 inputs de tarea) y los
 *      ejemplos NO-extraer del dominio inmobiliario. Esto garantiza que
 *      futuros refactors del prompt no pierdan estas guardas accidentalmente.
 *
 *   2. UNIT — pruebas puras de `extractJsonArray` y `validateExtracted`
 *      (parser tolerante a code fences + validador del shape).
 *
 *   3. LIVE — gated por `MEMORY_FLUSH_SELFTEST_LIVE=1`. Llama a Haiku con
 *      transcripts sintéticos del dominio real para verificar que las
 *      reglas funcionan end-to-end. Requiere `OPENROUTER_API_KEY`.
 *      Si la env var no está, los casos LIVE se skipean con log.
 */

function staticPromptTests(): void {
  assert.match(
    EXTRACTION_SYSTEM_PROMPT,
    /5\.\s+NO EXTRAIGAS DATOS TRANSACCIONALES/u,
    "regla 5 (datos transaccionales) presente"
  );
  assert.match(
    EXTRACTION_SYSTEM_PROMPT,
    /6\.\s+NO EXTRAIGAS INPUTS DE TAREA/u,
    "regla 6 (inputs de tarea) presente"
  );
  assert.match(
    EXTRACTION_SYSTEM_PROMPT,
    /9\.\s+Sé CONSERVADOR/u,
    "regla conservadora renumerada a 9"
  );
  assert.match(
    EXTRACTION_SYSTEM_PROMPT,
    /lead Julieta Evelia/u,
    "ejemplo NO-extraer del lead presente"
  );
  assert.match(
    EXTRACTION_SYSTEM_PROMPT,
    /\[assistant\] "¿Cuál es el nombre del lead\?"/u,
    "ejemplo NO-extraer de input de tarea presente"
  );
  assert.match(
    EXTRACTION_SYSTEM_PROMPT,
    /asesor inmobiliario en Mazatlán/u,
    "ejemplo SÍ-extraer (rol durable) presente"
  );
}

function jsonHelperTests(): void {
  assert.deepEqual(extractJsonArray("[]"), [], "array vacío directo");
  assert.deepEqual(
    extractJsonArray('[{"type":"semantic","content":"X"}]'),
    [{ type: "semantic", content: "X" }],
    "array bien formado"
  );
  assert.deepEqual(
    extractJsonArray('```json\n[{"type":"procedural","content":"Y"}]\n```'),
    [{ type: "procedural", content: "Y" }],
    "tolerante a code fences ```json"
  );
  assert.deepEqual(
    extractJsonArray("```\n[{\"type\":\"episodic\",\"content\":\"Z\"}]\n```"),
    [{ type: "episodic", content: "Z" }],
    "tolerante a code fences sin lenguaje"
  );
  assert.equal(extractJsonArray("no es JSON"), null, "texto plano → null");
  assert.equal(extractJsonArray('{"key":"value"}'), null, "objeto → null");
  assert.equal(extractJsonArray("[malformado"), null, "JSON inválido → null");

  // validateExtracted: descarta tipos inválidos, contenido vacío, demasiado largo.
  const longContent = "a".repeat(501);
  const items = validateExtracted([
    { type: "semantic", content: "ok" },
    { type: "wrong", content: "ignorado" },
    { type: "semantic", content: "" },
    { type: "semantic", content: "  " },
    { type: "procedural", content: longContent },
    { type: "episodic", content: "  con espacios  " },
    null,
    "no objeto",
    { content: "sin type" },
  ]);
  assert.deepEqual(
    items,
    [
      { type: "semantic", content: "ok" },
      { type: "episodic", content: "con espacios" },
    ],
    "validate descarta inválidos y trimea content"
  );
}

interface LiveCase {
  readonly name: string;
  readonly transcript: string;
  /**
   * Asserts to run on the extracted items. Should NOT throw if items match
   * expectations; should return a string with a description of the failure
   * if they don't. Returning null/undefined means pass.
   */
  readonly expect: (items: ExtractedMemory[]) => string | null | undefined;
}

const LIVE_CASES: LiveCase[] = [
  {
    name: "lead_name_as_input (regla 6)",
    transcript: [
      "[user] Ayúdame a escribir un WhatsApp para darle seguimiento a un lead",
      "[assistant] Claro, ¿cuál es el nombre del lead, su teléfono o su correo?",
      "[user] El nombre es Julieta Evelia",
      "[assistant] Listo, déjame buscar su contexto.",
    ].join("\n\n"),
    expect: (items) => {
      const leakedJulieta = items.filter((i) => /julieta/i.test(i.content));
      if (leakedJulieta.length > 0) {
        return `LEAK: extracted ${leakedJulieta.length} item(s) referenciando 'Julieta': ${JSON.stringify(leakedJulieta)}`;
      }
      return null;
    },
  },
  {
    name: "crm_data_volunteered (regla 5)",
    transcript: [
      "[user] Necesito un WhatsApp para María Pérez, vive en Reforma 123 y le interesa la casa de 5M en venta",
    ].join("\n\n"),
    expect: (items) => {
      const leaked = items.filter((i) =>
        /(maría pérez|reforma 123|5M|5 millones)/iu.test(i.content)
      );
      if (leaked.length > 0) {
        return `LEAK: ${leaked.length} item(s) con datos del CRM: ${JSON.stringify(leaked)}`;
      }
      return null;
    },
  },
  {
    name: "genuine_preference (debe extraer)",
    transcript: [
      "[user] Una cosa importante: siempre que me redactes mensajes a clientes, hazlo en tono amigable, en bullets cortos, y firma como 'Saludos, Juan Pablo'.",
    ].join("\n\n"),
    expect: (items) => {
      const procedural = items.filter((i) => i.type === "procedural");
      if (procedural.length === 0) {
        return `MISS: esperaba ≥1 item 'procedural', got: ${JSON.stringify(items)}`;
      }
      const matchesIntent = procedural.some((i) =>
        /(amigable|bullets|firma|saludos|juan pablo)/iu.test(i.content)
      );
      if (!matchesIntent) {
        return `MISS: items procedural no reflejan la preferencia: ${JSON.stringify(procedural)}`;
      }
      return null;
    },
  },
  {
    name: "personal_contact (debe extraer)",
    transcript: [
      "[user] Apunta esto: mi hermana Ana cumple años el 15 de marzo, recuérdamelo cada año.",
    ].join("\n\n"),
    expect: (items) => {
      const matches = items.filter((i) =>
        /(hermana|ana|15 de marzo|cumpleaños)/iu.test(i.content)
      );
      if (matches.length === 0) {
        return `MISS: esperaba item con info de la hermana, got: ${JSON.stringify(items)}`;
      }
      return null;
    },
  },
  {
    name: "asesor_role (debe extraer)",
    transcript: [
      "[user] Soy asesor inmobiliario en Mazatlán, llevo 8 años trabajando con propiedades residenciales.",
    ].join("\n\n"),
    expect: (items) => {
      const matches = items.filter((i) =>
        /(asesor|inmobiliario|mazatlán|residencial)/iu.test(i.content)
      );
      if (matches.length === 0) {
        return `MISS: esperaba item con rol del usuario, got: ${JSON.stringify(items)}`;
      }
      return null;
    },
  },
];

async function liveTests(): Promise<void> {
  if (process.env.MEMORY_FLUSH_SELFTEST_LIVE !== "1") {
    console.log(
      "memory_flush.selftest: live cases SKIPPED (set MEMORY_FLUSH_SELFTEST_LIVE=1 to run)"
    );
    return;
  }
  if (!process.env.OPENROUTER_API_KEY) {
    console.warn(
      "memory_flush.selftest: live mode requested but OPENROUTER_API_KEY is missing — skipping"
    );
    return;
  }

  let failures = 0;
  for (const tc of LIVE_CASES) {
    process.stdout.write(`  live: ${tc.name} ... `);
    try {
      const { items, rawText } = await extractMemoriesFromTranscript(
        tc.transcript
      );
      const failure = tc.expect(items);
      if (failure) {
        failures += 1;
        console.log(`FAIL\n    ${failure}\n    rawText: ${rawText.slice(0, 200)}`);
      } else {
        console.log(`ok (extracted=${items.length})`);
      }
    } catch (err) {
      failures += 1;
      console.log(
        `ERROR ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  if (failures > 0) {
    throw new Error(
      `memory_flush.selftest: ${failures}/${LIVE_CASES.length} live cases failed`
    );
  }
}

async function run(): Promise<void> {
  staticPromptTests();
  jsonHelperTests();
  await liveTests();
  console.log("memory_flush.selftest: ok");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
