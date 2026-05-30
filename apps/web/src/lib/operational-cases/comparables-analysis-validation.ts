/**
 * Validación de muestra defendible en comparables_analysis.
 * Patrón: PATTERN_COMPARABLES_INSUFFICIENT_NO_ADVANCE
 */

export const COMPARABLES_INSUFFICIENT_N4_SCENARIO_ID =
  "comparables_in_progress_insufficient_data";

export const COMPARABLES_COMPLETE_N4_SCENARIO_ID =
  "comparables_in_progress_complete";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function positiveNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function arrayLength(value: unknown) {
  return Array.isArray(value) ? value.length : 0;
}

/** Comparables marcados usables en data_quality o inferidos por stats/listas. */
export function comparablesUsableCount(analysis: unknown): number {
  if (!isRecord(analysis)) return 0;
  const dq = isRecord(analysis.data_quality) ? analysis.data_quality : null;
  if (dq && positiveNumber(dq.usable_count)) return dq.usable_count as number;

  const stats = isRecord(analysis.stats) ? analysis.stats : null;
  const statsDq =
    stats && isRecord(stats.data_quality) ? stats.data_quality : null;
  if (statsDq && positiveNumber(statsDq.usable_count)) {
    return statsDq.usable_count as number;
  }

  const listKeys = [
    "active_listings",
    "internal_inventory",
    "historical_references",
    "closed_deals",
  ] as const;
  let fromLists = 0;
  for (const key of listKeys) {
    const arr = analysis[key];
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      if (isRecord(item) && item.usable_as_comparable === true) fromLists += 1;
      else if (isRecord(item) && item.usable_as_comparable !== false) {
        if (positiveNumber(item.price) || positiveNumber(item.area_m2)) fromLists += 1;
      }
    }
  }
  if (fromLists > 0) return fromLists;

  if (stats) {
    const active = typeof stats.active_count === "number" ? stats.active_count : 0;
    const hist =
      typeof stats.historical_reference_count === "number"
        ? stats.historical_reference_count
        : 0;
    const internal =
      typeof stats.internal_inventory_count === "number"
        ? stats.internal_inventory_count
        : 0;
    const sum = active + hist + internal;
    if (sum > 0) return sum;
  }

  return (
    arrayLength(analysis.active_listings) +
    arrayLength(analysis.internal_inventory) +
    arrayLength(analysis.historical_references) +
    arrayLength(analysis.closed_deals)
  );
}

export function comparablesHasDefensibleSample(analysis: unknown): boolean {
  if (!isRecord(analysis)) return false;
  if (comparablesUsableCount(analysis) > 0) return true;
  const stats = analysis.stats;
  if (!isRecord(stats)) return false;
  const price = stats.price;
  if (isRecord(price) && positiveNumber(price.sample_size)) return true;
  if (positiveNumber(stats.active_count)) return true;
  if (positiveNumber(stats.historical_reference_count)) return true;
  if (positiveNumber(stats.internal_inventory_count)) return true;
  return false;
}

export type ComparablesOutcomeValidation = {
  defensible: boolean;
  usable_count: number;
  errors: string[];
};

export function validateComparablesCaseOutcome(params: {
  comparables_analysis: unknown;
  current_step: string;
  status: string;
  notify_user_executed: boolean;
}): ComparablesOutcomeValidation {
  const defensible = comparablesHasDefensibleSample(params.comparables_analysis);
  const usable_count = comparablesUsableCount(params.comparables_analysis);
  const errors: string[] = [];

  if (defensible) {
    if (params.current_step !== "price_proposal_pending") {
      errors.push(
        "Con comparables usables el caso debe avanzar a current_step=price_proposal_pending."
      );
    }
    if (params.status !== "active" && params.status !== "waiting_internal") {
      errors.push(
        "Con comparables usables se espera status=active (o waiting_internal si hay HITL de precio)."
      );
    }
  } else {
    if (params.current_step === "price_proposal_pending") {
      errors.push(
        "Sin comparables usables (todas las fuentes) no debe avanzar a price_proposal_pending."
      );
    }
    if (params.current_step !== "comparables_in_progress") {
      errors.push(
        "Sin comparables usables el caso debe permanecer en comparables_in_progress."
      );
    }
    if (params.status !== "waiting_internal") {
      errors.push(
        "Sin comparables usables se espera status=waiting_internal (asesor debe ampliar criterios)."
      );
    }
    if (!params.notify_user_executed) {
      errors.push(
        "Sin comparables usables debe ejecutarse notify_user al asesor con filtros y sugerencias."
      );
    }
  }

  return { defensible, usable_count, errors };
}

/** N4 escenario «sin comparables usables»: solo valida la rama insuficiente. */
export function validateComparablesInsufficientStepOutcome(params: {
  comparables_analysis: unknown;
  current_step: string;
  status: string;
  notify_user_executed: boolean;
}): ComparablesOutcomeValidation {
  const usable_count = comparablesUsableCount(params.comparables_analysis);
  const errors: string[] = [];

  if (usable_count > 0) {
    errors.push(
      `El escenario negativo requiere 0 comparables usables; el análisis persistido reporta ${usable_count}.`
    );
  }
  if (params.current_step === "price_proposal_pending") {
    errors.push(
      "Sin comparables usables (todas las fuentes) no debe avanzar a price_proposal_pending."
    );
  }
  if (params.current_step !== "comparables_in_progress") {
    errors.push(
      "Sin comparables usables el caso debe permanecer en comparables_in_progress."
    );
  }
  if (params.status !== "waiting_internal") {
    errors.push(
      "Sin comparables usables se espera status=waiting_internal (asesor debe ampliar criterios)."
    );
  }
  if (!params.notify_user_executed) {
    errors.push(
      "Sin comparables usables debe ejecutarse notify_user al asesor con filtros y sugerencias."
    );
  }

  return { defensible: false, usable_count, errors };
}

/** N4 escenario «análisis completo»: solo valida la rama con muestra defendible. */
export function validateComparablesCompleteStepOutcome(params: {
  comparables_analysis: unknown;
  current_step: string;
  status: string;
  notify_user_executed: boolean;
}): ComparablesOutcomeValidation {
  const defensible = comparablesHasDefensibleSample(params.comparables_analysis);
  const usable_count = comparablesUsableCount(params.comparables_analysis);
  const errors: string[] = [];

  if (!defensible || usable_count <= 0) {
    errors.push(
      "El escenario positivo requiere comparables usables > 0 en comparables_analysis."
    );
  }
  if (params.current_step !== "price_proposal_pending") {
    errors.push(
      "Con comparables usables el caso debe avanzar a current_step=price_proposal_pending."
    );
  }
  if (params.status !== "active" && params.status !== "waiting_internal") {
    errors.push(
      "Con comparables usables se espera status=active (o waiting_internal si hay HITL de precio)."
    );
  }

  return { defensible, usable_count, errors };
}
