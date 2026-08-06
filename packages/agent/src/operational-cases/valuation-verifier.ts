/**
 * Verificador independiente de valuación (Slice 3.4-3; Technical Plan §9,
 * activation bar: verificación independiente + aislamiento de contexto).
 *
 * Contrato de aislamiento: el contexto del verificador es el comparable set
 * + los hechos de la propiedad + los NÚMEROS propuestos — NUNCA el
 * razonamiento de la recomendación (verificar el argumento del productor
 * contaminaría la segunda opinión). Superficie read-only: sin tools, sin DB;
 * función pura de sus entradas + una llamada de modelo opcional.
 *
 * Dos capas:
 *   1. Checks deterministas (siempre corren; sin modelo): muestra defendible,
 *      orden mínimo ≤ ideal ≤ salida, banda de plausibilidad vs mediana de
 *      comparables. Cualquier fallo ⇒ verdict fail (el modelo no puede
 *      "des-fallar" un check determinista).
 *   2. Revisión model-backed (opcional; §9.1 role `valuation_verifier`):
 *      segunda opinión estructurada pass/fail + findings. Sin API key el
 *      verificador degrada a solo-determinista y lo dice en findings.
 *
 * La evidencia (verdict + findings) gatea el artefacto price_recommendation:
 * el executor registered_specialized_worker deja el work item en review en fail, y el caller
 * invalida el artefacto — nunca se auto-aprueba nada aquí (HITL intacto).
 */
import {
  createWorkerModel,
  resolveWorkerModel,
  type ResolvedWorkerModel,
} from "../model";
import {
  comparablesHasDefensibleSample,
  comparablesUniqueCount,
  MIN_DEFENSIBLE_UNIQUE_COMPARABLES,
} from "./comparables-analysis";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

export interface ValuationVerifierInput {
  /** Contenido del artefacto comparable_set (comparables_analysis). */
  comparableSet: Record<string, unknown>;
  /** Hechos de la propiedad (property.*): zona, tipo, áreas… */
  propertyFacts: Record<string, unknown>;
  /** Números propuestos (jamás el razonamiento del productor). */
  proposedPrices: {
    salida?: number | null;
    ideal?: number | null;
    minimo?: number | null;
  };
}

export interface ValuationVerifierChecks {
  defensible_sample: boolean;
  unique_comparables: number;
  price_ordering_ok: boolean;
  plausibility_ok: boolean | null;
  /** Mediana de precio comparable usada para la banda (null sin stats). */
  reference_price: number | null;
}

export interface ValuationVerifierResult {
  verdict: "pass" | "fail";
  findings: string[];
  checks: ValuationVerifierChecks;
  /** Modelo RESUELTO usado por la capa 2 (null si degradó a determinista). */
  model: { modelId: string; resolvedVia: ResolvedWorkerModel["resolvedVia"] } | null;
}

/**
 * Banda de plausibilidad amplia: la propuesta de salida debe caer dentro de
 * [0.5×, 2.0×] de la referencia de comparables. No es una banda de pricing
 * (esa es política de metodología) sino un detector de errores groseros
 * (orden de magnitud, unidad equivocada).
 */
const PLAUSIBILITY_LOW_FACTOR = 0.5;
const PLAUSIBILITY_HIGH_FACTOR = 2.0;

function referenceComparablePrice(
  comparableSet: Record<string, unknown>
): number | null {
  const stats = isRecord(comparableSet.stats) ? comparableSet.stats : null;
  const price = stats && isRecord(stats.price) ? stats.price : null;
  return (
    positiveNumber(price?.median) ??
    positiveNumber(price?.p50) ??
    positiveNumber(price?.mean) ??
    null
  );
}

/** Capa 1: checks deterministas (read-only, sin modelo). */
export function runDeterministicValuationChecks(
  input: ValuationVerifierInput
): { checks: ValuationVerifierChecks; findings: string[] } {
  const findings: string[] = [];
  const unique = comparablesUniqueCount(input.comparableSet);
  const defensible = comparablesHasDefensibleSample(input.comparableSet);
  if (!defensible) {
    findings.push(
      `Muestra no defendible: ${unique} comparables únicos (mínimo ${MIN_DEFENSIBLE_UNIQUE_COMPARABLES}).`
    );
  }

  const salida = positiveNumber(input.proposedPrices.salida);
  const ideal = positiveNumber(input.proposedPrices.ideal);
  const minimo = positiveNumber(input.proposedPrices.minimo);
  let orderingOk = true;
  if (minimo != null && ideal != null && minimo > ideal) orderingOk = false;
  if (ideal != null && salida != null && ideal > salida) orderingOk = false;
  if (minimo != null && salida != null && minimo > salida) orderingOk = false;
  if (!orderingOk) {
    findings.push(
      "Orden de precios inválido: se requiere mínimo ≤ ideal ≤ salida."
    );
  }
  if (salida == null) {
    findings.push("La propuesta no trae precio de salida verificable.");
  }

  const reference = referenceComparablePrice(input.comparableSet);
  let plausibilityOk: boolean | null = null;
  if (salida != null && reference != null) {
    plausibilityOk =
      salida >= reference * PLAUSIBILITY_LOW_FACTOR &&
      salida <= reference * PLAUSIBILITY_HIGH_FACTOR;
    if (!plausibilityOk) {
      findings.push(
        `Salida ${salida} fuera de la banda de plausibilidad [${Math.round(reference * PLAUSIBILITY_LOW_FACTOR)}, ${Math.round(reference * PLAUSIBILITY_HIGH_FACTOR)}] vs referencia de comparables ${reference}.`
      );
    }
  } else if (salida != null && reference == null) {
    findings.push(
      "Sin estadística de precio en el comparable set: no se pudo verificar plausibilidad."
    );
  }

  return {
    checks: {
      defensible_sample: defensible,
      unique_comparables: unique,
      price_ordering_ok: orderingOk,
      plausibility_ok: plausibilityOk,
      reference_price: reference,
    },
    findings,
  };
}

function deterministicVerdict(checks: ValuationVerifierChecks): "pass" | "fail" {
  if (!checks.defensible_sample) return "fail";
  if (!checks.price_ordering_ok) return "fail";
  if (checks.plausibility_ok === false) return "fail";
  return "pass";
}

/** Segunda opinión model-backed, inyectable para selftests. */
export type VerifierModelInvoke = (prompt: string) => Promise<string>;

function defaultModelInvoke(resolved: ResolvedWorkerModel): VerifierModelInvoke {
  return async (prompt: string) => {
    const model = createWorkerModel({
      resolved,
      modelRole: "valuation_verifier",
    });
    const response = await model.invoke([
      {
        role: "system",
        content:
          "Eres un verificador independiente de valuaciones inmobiliarias. Respondes EXCLUSIVAMENTE un JSON {\"verdict\":\"pass\"|\"fail\",\"findings\":[\"...\"]}. Evalúas si la propuesta de precios es consistente con el comparable set y los hechos de la propiedad. No conoces ni pides el razonamiento del productor.",
      },
      { role: "user", content: prompt },
    ]);
    return typeof response.content === "string"
      ? response.content
      : JSON.stringify(response.content);
  };
}

function parseModelVerdict(raw: string): {
  verdict: "pass" | "fail";
  findings: string[];
} | null {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    const verdict = parsed.verdict;
    if (verdict !== "pass" && verdict !== "fail") return null;
    const findings = Array.isArray(parsed.findings)
      ? parsed.findings.filter((f): f is string => typeof f === "string")
      : [];
    return { verdict, findings };
  } catch {
    return null;
  }
}

export async function verifyValuationRecommendation(
  input: ValuationVerifierInput,
  deps?: {
    /** Inyectable en selftests; default = modelo §9.1 role valuation_verifier. */
    invoke?: VerifierModelInvoke;
    /** Política del worker profile (model_policy_jsonb); default vacía. */
    modelPolicy?: Record<string, unknown> | null;
  }
): Promise<ValuationVerifierResult> {
  const deterministic = runDeterministicValuationChecks(input);
  const findings = [...deterministic.findings];
  let verdict = deterministicVerdict(deterministic.checks);

  const resolved = resolveWorkerModel({
    modelPolicy: deps?.modelPolicy ?? { role: "valuation_verifier" },
    executionMode: "registered_specialized_worker",
  });

  let modelInfo: ValuationVerifierResult["model"] = null;
  const canCallModel =
    Boolean(deps?.invoke) || Boolean(process.env.OPENROUTER_API_KEY);
  if (resolved && canCallModel) {
    const invoke = deps?.invoke ?? defaultModelInvoke(resolved);
    // Contexto AISLADO: comparable set + hechos + números. Nada más.
    const prompt = JSON.stringify(
      {
        comparable_set: input.comparableSet,
        property_facts: input.propertyFacts,
        proposed_prices: input.proposedPrices,
      },
      null,
      2
    );
    try {
      const raw = await invoke(prompt);
      const parsed = parseModelVerdict(raw);
      if (parsed) {
        modelInfo = { modelId: resolved.modelId, resolvedVia: resolved.resolvedVia };
        if (parsed.verdict === "fail") {
          // El modelo puede endurecer el verdict, nunca suavizarlo: un fail
          // determinista es inapelable.
          verdict = "fail";
        }
        findings.push(...parsed.findings);
      } else {
        findings.push(
          "Revisión de modelo ilegible; verdict basado solo en checks deterministas."
        );
      }
    } catch (modelError) {
      findings.push(
        `Revisión de modelo falló (${(modelError as Error)?.message ?? "error"}); verdict basado solo en checks deterministas.`
      );
    }
  } else {
    findings.push(
      "Revisión de modelo omitida (sin OPENROUTER_API_KEY); verdict basado solo en checks deterministas."
    );
  }

  return { verdict, findings, checks: deterministic.checks, model: modelInfo };
}
