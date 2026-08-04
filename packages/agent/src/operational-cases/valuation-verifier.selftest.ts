/**
 * Selftests del valuation verifier (Slice 3.4-3) y del ModelPolicyResolver
 * (Slice 3.4-4, §9.1).
 *
 * Contratos que se prueban:
 *   - Checks deterministas: muestra defendible, orden mínimo ≤ ideal ≤
 *     salida, banda de plausibilidad vs referencia de comparables.
 *   - El modelo puede ENDURECER el verdict (pass→fail) pero nunca suavizar
 *     un fail determinista.
 *   - Aislamiento de contexto: el prompt del modelo contiene EXACTAMENTE
 *     comparable_set + property_facts + proposed_prices — jamás el
 *     razonamiento del productor.
 *   - Resolución §9.1: alias del perfil → env del rol → MAIN_AGENT_MODEL_ID
 *     (solo agentic); deterministas nunca resuelven modelo.
 */
import assert from "node:assert/strict";
import {
  MAIN_AGENT_MODEL_ID,
  WORKER_MODEL_ALIAS_MAP,
  WORKFLOW_VERIFIER_MODEL_ID,
  resolveWorkerModel,
} from "../model";
import {
  runDeterministicValuationChecks,
  verifyValuationRecommendation,
} from "./valuation-verifier";

const GOOD_COMPARABLE_SET = {
  filters_used: { zone: "Metepec", operation: "venta" },
  stats: { price: { median: 5_000_000, sample_size: 5 } },
  data_quality: { usable_count: 5, unique_comparable_count: 5 },
};

const PROPERTY_FACTS = {
  "property.search_zone": "Metepec",
  "property.property_type": "casa",
  "property.area_construida_m2": 220,
};

async function main(): Promise<void> {
  // ---- Checks deterministas ------------------------------------------------
  {
    const { checks, findings } = runDeterministicValuationChecks({
      comparableSet: GOOD_COMPARABLE_SET,
      propertyFacts: PROPERTY_FACTS,
      proposedPrices: { salida: 5_200_000, ideal: 5_000_000, minimo: 4_500_000 },
    });
    assert.equal(checks.defensible_sample, true);
    assert.equal(checks.price_ordering_ok, true);
    assert.equal(checks.plausibility_ok, true);
    assert.equal(findings.length, 0, "caso sano: sin findings");
  }
  {
    // Muestra no defendible (2 únicos < 3).
    const { checks } = runDeterministicValuationChecks({
      comparableSet: {
        ...GOOD_COMPARABLE_SET,
        data_quality: { usable_count: 2, unique_comparable_count: 2 },
      },
      propertyFacts: PROPERTY_FACTS,
      proposedPrices: { salida: 5_200_000 },
    });
    assert.equal(checks.defensible_sample, false);
  }
  {
    // Orden inválido: mínimo > salida.
    const { checks, findings } = runDeterministicValuationChecks({
      comparableSet: GOOD_COMPARABLE_SET,
      propertyFacts: PROPERTY_FACTS,
      proposedPrices: { salida: 4_000_000, ideal: 4_500_000, minimo: 5_000_000 },
    });
    assert.equal(checks.price_ordering_ok, false);
    assert.ok(findings.some((f) => f.includes("Orden de precios")));
  }
  {
    // Error grosero de magnitud: salida 10x la referencia.
    const { checks } = runDeterministicValuationChecks({
      comparableSet: GOOD_COMPARABLE_SET,
      propertyFacts: PROPERTY_FACTS,
      proposedPrices: { salida: 50_000_000 },
    });
    assert.equal(checks.plausibility_ok, false);
  }

  // ---- Capa modelo: endurece, nunca suaviza --------------------------------
  {
    // Deterministas pasan; el modelo detecta algo y falla el verdict.
    let promptSeen = "";
    const result = await verifyValuationRecommendation(
      {
        comparableSet: GOOD_COMPARABLE_SET,
        propertyFacts: PROPERTY_FACTS,
        proposedPrices: { salida: 5_200_000, ideal: 5_000_000, minimo: 4_500_000 },
      },
      {
        invoke: async (prompt) => {
          promptSeen = prompt;
          return JSON.stringify({
            verdict: "fail",
            findings: ["Los comparables son de otra colonia."],
          });
        },
      }
    );
    assert.equal(result.verdict, "fail", "el modelo puede endurecer");
    assert.ok(result.findings.includes("Los comparables son de otra colonia."));
    assert.ok(result.model, "modelo resuelto reportado");

    // Aislamiento: el prompt es EXACTAMENTE las tres entradas del contrato.
    const parsed = JSON.parse(promptSeen) as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(parsed).sort(),
      ["comparable_set", "property_facts", "proposed_prices"],
      "contexto aislado: nada más entra al verificador"
    );
  }
  {
    // Fail determinista es inapelable aunque el modelo diga pass.
    const result = await verifyValuationRecommendation(
      {
        comparableSet: GOOD_COMPARABLE_SET,
        propertyFacts: PROPERTY_FACTS,
        proposedPrices: { salida: 4_000_000, minimo: 5_000_000 },
      },
      {
        invoke: async () => JSON.stringify({ verdict: "pass", findings: [] }),
      }
    );
    assert.equal(result.verdict, "fail", "el modelo no suaviza un fail determinista");
  }
  {
    // Modelo ilegible: verdict determinista + finding de degradación.
    const result = await verifyValuationRecommendation(
      {
        comparableSet: GOOD_COMPARABLE_SET,
        propertyFacts: PROPERTY_FACTS,
        proposedPrices: { salida: 5_200_000 },
      },
      { invoke: async () => "no soy json" }
    );
    assert.equal(result.verdict, "pass");
    assert.ok(result.findings.some((f) => f.includes("ilegible")));
    assert.equal(result.model, null);
  }

  // ---- ModelPolicyResolver §9.1 ---------------------------------------------
  {
    // 1) alias del perfil gana.
    const viaAlias = resolveWorkerModel({
      modelPolicy: { role: "valuation_verifier", model_alias: "reasoning_standard" },
      executionMode: "specialized_agent",
    });
    assert.ok(viaAlias);
    assert.equal(viaAlias.resolvedVia, "profile_alias");
    assert.equal(viaAlias.modelId, WORKER_MODEL_ALIAS_MAP.reasoning_standard);

    // 2) alias desconocido → env del rol.
    const viaRole = resolveWorkerModel({
      modelPolicy: { role: "valuation_verifier", model_alias: "no_existe" },
      executionMode: "specialized_agent",
    });
    assert.ok(viaRole);
    assert.equal(viaRole.resolvedVia, "role_env");
    assert.equal(viaRole.modelId, WORKFLOW_VERIFIER_MODEL_ID);

    // 3) sin política → MAIN_AGENT_MODEL_ID (solo modos agénticos).
    const viaMain = resolveWorkerModel({
      modelPolicy: null,
      executionMode: "specialized_agent",
    });
    assert.ok(viaMain);
    assert.equal(viaMain.resolvedVia, "main_agent");
    assert.equal(viaMain.modelId, MAIN_AGENT_MODEL_ID);

    // 4) deterministas NUNCA resuelven modelo.
    assert.equal(
      resolveWorkerModel({
        modelPolicy: { model_alias: "reasoning_high" },
        executionMode: "deterministic_service",
      }),
      null
    );

    // 5) budgets de la política se respetan.
    const budgeted = resolveWorkerModel({
      modelPolicy: { model_alias: "reasoning_standard", max_output_tokens: 3000, temperature: 0 },
      executionMode: "specialized_agent",
    });
    assert.equal(budgeted!.maxTokens, 3000);
    assert.equal(budgeted!.temperature, 0);
  }

  console.log("valuation-verifier.selftest: OK");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
