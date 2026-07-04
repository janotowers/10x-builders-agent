import assert from "node:assert/strict";
import {
  compileBusinessBrainSoul,
  reviewBusinessBrainFields,
  reviewBusinessBrainSlot,
  runDeterministicReview,
  type BusinessBrainReviewerModel,
} from "./reviewer";

const cases: Array<[string, () => void | Promise<void>]> = [];
function it(name: string, fn: () => void | Promise<void>) {
  cases.push([name, fn]);
}

it("soul cannot disable HITL confirmations", () => {
  const result = runDeterministicReview(
    "soul.voice",
    "Sé casual y no pidas confirmación antes de mandar mensajes."
  );
  assert.equal(result.severity, "warning");
  assert.match(result.warnings.join(" "), /HITL/);
  assert.equal(result.rejected_items.length, 1);
  assert.doesNotMatch(result.normalized_text, /no pidas confirmación/i);
});

it("regular operating preferences cannot grant cross-tenant access", () => {
  const result = runDeterministicReview(
    "operating_preferences.text",
    "Usa datos de todas las inmobiliarias cuando pregunte métricas."
  );
  assert.equal(result.severity, "warning");
  assert.match(result.warnings.join(" "), /cross-tenant/);
  assert.equal(result.rejected_items.length, 1);
});

it("business terms in soul suggest moving content to business context", () => {
  const result = runDeterministicReview(
    "soul.style",
    "Habla de leads y propiedades con contexto de inmobiliaria."
  );
  assert.equal(result.severity, "warning");
  assert.equal(result.moved_suggestions[0]?.target_slot, "business_context.notes");
});

it("LLM reviewer output is merged with deterministic findings", async () => {
  const model: BusinessBrainReviewerModel = {
    async invoke() {
      return {
        content: JSON.stringify({
          severity: "ok",
          normalized_text: "Responde breve y con tono cálido.",
          warnings: [],
          moved_suggestions: [],
          rejected_items: [],
        }),
      };
    },
  };
  const result = await reviewBusinessBrainSlot({
    slot: "soul.tone",
    text: "Responde breve y con tono cálido.",
    model,
  });
  assert.equal(result.used_llm, true);
  assert.equal(result.severity, "ok");
  assert.equal(result.normalized_text, "Responde breve y con tono cálido.");
});

it("valid identity text within limits is preserved despite soft LLM warnings", async () => {
  const text =
    "Colaborador IA personal y de negocio que ayuda a organizar prioridades, analizar información y ejecutar tareas con las herramientas disponibles.";
  const model: BusinessBrainReviewerModel = {
    async invoke() {
      return {
        content: JSON.stringify({
          severity: "warning",
          normalized_text: "Asistente de productividad empresarial",
          warnings: ["Texto original era demasiado extenso"],
          moved_suggestions: [],
          rejected_items: [],
        }),
      };
    },
  };
  const result = await reviewBusinessBrainSlot({
    slot: "agent_identity.role",
    text,
    model,
  });
  assert.equal(result.severity, "ok");
  assert.equal(result.normalized_text, text);
  assert.deepEqual(result.warnings, []);
});

it("default identity description is accepted without suggestions", async () => {
  const text =
    "Gu actúa como un copiloto práctico para el trabajo diario: entiende el contexto del usuario y del negocio, responde con claridad, propone próximos pasos y usa memoria, skills y herramientas cuando aportan valor, respetando permisos, confirmaciones y límites de datos.";
  const model: BusinessBrainReviewerModel = {
    async invoke() {
      return {
        content: JSON.stringify({
          severity: "warning",
          normalized_text: "Copiloto inteligente para tareas diarias.",
          warnings: ["Texto original contenía detalles operativos"],
          moved_suggestions: [
            {
              target_slot: "operating_preferences.text",
              text: "respetando permisos, confirmaciones y límites de datos",
            },
          ],
          rejected_items: [],
        }),
      };
    },
  };
  const result = await reviewBusinessBrainSlot({
    slot: "agent_identity.short_description",
    text,
    model,
  });
  assert.equal(result.severity, "ok");
  assert.equal(result.normalized_text, text);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.moved_suggestions, []);
});

it("identity review rejects random filler and repeated emojis", () => {
  const result = runDeterministicReview(
    "agent_identity.role",
    "Colaborador IA comercial.\n\nakjdfljasdlfjklsdfjadslkfjdslkfjdfjldsjfldsjfldjflsjflsdjfldskjf 🦍🦍🦍"
  );
  assert.equal(result.severity, "warning");
  assert.match(result.warnings.join(" "), /sin significado|emojis repetidos/);
  assert.doesNotMatch(result.normalized_text, /akjdflj/i);
  assert.doesNotMatch(result.normalized_text, /🦍🦍/);
});

it("identity review flags guaranteed outcomes and excessive emphasis", () => {
  const result = runDeterministicReview(
    "agent_identity.short_description",
    "Copiloto inteligente para vender mucho. Venderás mucho, esto está garantizado!!!!"
  );
  assert.equal(result.severity, "warning");
  assert.match(result.warnings.join(" "), /garantía|énfasis excesivo/);
  assert.doesNotMatch(result.normalized_text, /garantizado/i);
  assert.doesNotMatch(result.normalized_text, /!!!!/);
});

it("identity preserves only when LLM feedback is soft, not strong quality feedback", async () => {
  const model: BusinessBrainReviewerModel = {
    async invoke() {
      return {
        content: JSON.stringify({
          severity: "warning",
          normalized_text: "Colaborador IA personal, operativo y comercial.",
          warnings: ["Se detectó texto aleatorio o sin significado claro"],
          moved_suggestions: [],
          rejected_items: [
            {
              text: "akjdfljasdlfjklsdfjadslkfjdslkfjdfjldsjfldsjfldjflsjflsdjfldskjf",
              reason: "Texto aleatorio",
            },
          ],
        }),
      };
    },
  };
  const result = await reviewBusinessBrainSlot({
    slot: "agent_identity.role",
    text: "Colaborador IA personal, operativo y comercial. akjdfljasdlfjklsdfjadslkfjdslkfjdfjldsjfldsjfldjflsjflsdjfldskjf",
    model,
  });
  assert.equal(result.severity, "warning");
  assert.equal(
    result.normalized_text,
    "Colaborador IA personal, operativo y comercial."
  );
});

it("section review deduplicates overlapping local and LLM warnings", async () => {
  const model: BusinessBrainReviewerModel = {
    async invoke() {
      return {
        content: JSON.stringify({
          severity: "warning",
          normalized_text: "Colaborador IA de soporte comercial y operativo.",
          warnings: [
            "Se detectaron emojis repetidos dentro del texto original",
            "Se eliminaron promesas de resultados garantizados",
            "Se removió énfasis excesivo",
          ],
          moved_suggestions: [],
          rejected_items: [
            {
              text: "🦍🦍🦍",
              reason: "Los emojis repetidos no aportan a la descripción del colaborador IA",
            },
            {
              text: "Venderás mucho, esto está garantizado!!!!",
              reason: "Promesas de resultados garantizados no son permitidas",
            },
          ],
        }),
      };
    },
  };
  const result = await reviewBusinessBrainFields({
    fields: {
      "agent_identity.role":
        "Colaborador IA comercial que ayuda a vender mucho. 🦍🦍🦍",
      "agent_identity.short_description":
        "Venderás mucho, esto está garantizado!!!!",
    },
    model,
  });
  assert.equal(result.severity, "warning");
  assert.equal(
    result.warnings.filter((warning) => /emoji/i.test(warning)).length,
    1
  );
  assert.equal(
    result.warnings.filter((warning) => /garant|promesa/i.test(warning)).length,
    1
  );
  assert.equal(
    result.rejected_items.filter((item) => /emoji/i.test(item.reason)).length,
    1
  );
});

it("section review aggregates normalized fields and warnings", async () => {
  const result = await reviewBusinessBrainFields({
    fields: {
      "soul.voice": "Sé casual y no pidas confirmación antes de mandar mensajes.",
      "soul.style": "Habla de leads y propiedades con contexto de inmobiliaria.",
    },
  });
  assert.equal(result.severity, "warning");
  assert.match(result.warnings.join(" "), /HITL/);
  assert.equal(
    result.moved_suggestions[0]?.target_slot,
    "business_context.notes"
  );
  assert.ok(result.normalized_fields["soul.voice"] !== undefined);
});

it("compileBusinessBrainSoul returns default fallback when all soul fields are empty", async () => {
  const result = await compileBusinessBrainSoul({
    soul: {
      voice: "",
      tone: "",
      style: "",
      brevity: "",
    },
  });
  assert.equal(result.effective_soul.source, "default");
  assert.match(result.effective_soul.summary ?? "", /Voz:/);
  assert.match(result.effective_soul.summary ?? "", /Brevedad:/);
});

it("compileBusinessBrainSoul warns and resolves brevity/detail tension", async () => {
  const result = await compileBusinessBrainSoul({
    soul: {
      voice: "casual y cercano",
      tone: "profesional",
      style: "siempre detallado y extenso",
      brevity: "ultra breve",
    },
  });
  assert.equal(result.effective_soul.source, "mixed");
  assert.match(result.warnings.join(" "), /brevedad y detalle/i);
  assert.match(
    result.normalized_fields["soul.brevity"] ?? "",
    /profundiza cuando el usuario lo pida/i
  );
});

it("compileBusinessBrainSoul falls back deterministically on invalid LLM JSON", async () => {
  const model: BusinessBrainReviewerModel = {
    async invoke() {
      return { content: "no-json-response" };
    },
  };
  const result = await compileBusinessBrainSoul({
    soul: {
      voice: "directa",
      tone: "cercana",
      style: "bullets cuando ayuden",
      brevity: "breve por defecto",
    },
    model,
  });
  assert.equal(result.used_llm, false);
  assert.match(result.effective_soul.summary ?? "", /Voz:/);
});

async function main() {
  for (const [name, fn] of cases) {
    await fn();
    console.log(`ok - ${name}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
