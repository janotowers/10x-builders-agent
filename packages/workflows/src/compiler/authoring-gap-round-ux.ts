/**
 * UX pura y determinística para una ronda de gaps de Studio authoring.
 *
 * Este módulo no selecciona preguntas ni modifica el gap plan. Solo compara
 * planes ya calculados, redacta la introducción de la ronda y conserva la
 * numeración visible de los gaps que efectivamente se presentan.
 */
import {
  isAuthoringGapResolved,
  type AuthoringGap,
  type AuthoringGapPlan,
} from "./authoring-gap-planner";

export const AUTHORING_ROUND_COPY_FALLBACK =
  "Necesito un poco más de contexto para preparar un borrador seguro.";

export type AuthoringGapRoundDeltaKind =
  | "first"
  | "resolved"
  | "partial"
  | "new"
  | "requeued"
  | "unlocked"
  | "remaining";

export type AuthoringGapRoundDeltaEntry = {
  kind: AuthoringGapRoundDeltaKind;
  gap_id: string;
  summary: string;
  previous_state?: AuthoringGap["state"];
  current_state?: AuthoringGap["state"];
  question_changed?: boolean;
};

export type AuthoringGapRoundDelta = {
  first: AuthoringGapRoundDeltaEntry[];
  resolved: AuthoringGapRoundDeltaEntry[];
  partial: AuthoringGapRoundDeltaEntry[];
  new: AuthoringGapRoundDeltaEntry[];
  requeued: AuthoringGapRoundDeltaEntry[];
  unlocked: AuthoringGapRoundDeltaEntry[];
  remaining: AuthoringGapRoundDeltaEntry[];
};

export type AuthoringQuestionNumberingRegistry = {
  next_number: number;
  by_gap_id: Record<string, number>;
};

export type AuthoringNumberedQuestion<T> = T & {
  gap_id?: string;
  display_number?: number;
};

function isResolved(gap: AuthoringGap | undefined): boolean {
  return Boolean(gap && isAuthoringGapResolved(gap));
}

function entry(
  kind: AuthoringGapRoundDeltaKind,
  current: AuthoringGap,
  previous?: AuthoringGap
): AuthoringGapRoundDeltaEntry {
  return {
    kind,
    gap_id: current.id,
    summary: current.summary,
    previous_state: previous?.state,
    current_state: current.state,
    question_changed: Boolean(
      previous &&
        (previous.question !== current.question ||
          previous.summary !== current.summary)
    ),
  };
}

/**
 * Clasifica una ronda usando solo el plan anterior, el actual y la identidad
 * de los gaps ya presentados. Las categorías de presentación son excluyentes;
 * `resolved` y `remaining` describen el resto del plan.
 */
export function classifyAuthoringGapRound(params: {
  previousPlan?: AuthoringGapPlan;
  currentPlan: AuthoringGapPlan;
  presentedGapIds: readonly string[];
  previouslyPresentedGapIds?: readonly string[];
  isFirstRound?: boolean;
}): AuthoringGapRoundDelta {
  const result: AuthoringGapRoundDelta = {
    first: [],
    resolved: [],
    partial: [],
    new: [],
    requeued: [],
    unlocked: [],
    remaining: [],
  };
  const previousById = new Map(
    (params.previousPlan?.gaps ?? []).map((gap) => [gap.id, gap])
  );
  const currentById = new Map(
    params.currentPlan.gaps.map((gap) => [gap.id, gap])
  );
  const presented = new Set(params.presentedGapIds);
  const previouslyPresented = new Set(
    params.previouslyPresentedGapIds ?? []
  );
  const firstRound =
    params.isFirstRound ??
    (params.previousPlan === undefined && previouslyPresented.size === 0);

  for (const previous of previousById.values()) {
    const current = currentById.get(previous.id);
    if (!isResolved(previous) && isResolved(current)) {
      result.resolved.push(entry("resolved", current!, previous));
    }
  }

  for (const current of params.currentPlan.gaps) {
    if (isResolved(current)) continue;
    const previous = previousById.get(current.id);
    if (!presented.has(current.id)) {
      result.remaining.push(entry("remaining", current, previous));
      continue;
    }
    if (firstRound) {
      result.first.push(entry("first", current, previous));
    } else if (
      previous?.state === "blocked_dependency" &&
      current.state !== "blocked_dependency"
    ) {
      result.unlocked.push(entry("unlocked", current, previous));
    } else if (
      previous &&
      previouslyPresented.has(current.id) &&
      (previous.question !== current.question ||
        previous.summary !== current.summary)
    ) {
      result.partial.push(entry("partial", current, previous));
    } else if (
      previous &&
      (previouslyPresented.has(current.id) || previous.state === "asked")
    ) {
      result.requeued.push(entry("requeued", current, previous));
    } else {
      result.new.push(entry("new", current, previous));
    }
  }

  return result;
}

/**
 * Redacta copy español a partir de la clasificación, sin texto generado por
 * modelo. Las disposiciones del modelo deciden qué quedó resuelto o pendiente;
 * esta capa solo lo presenta sin exponer términos del ledger interno.
 */
export function buildAuthoringGapRoundIntro(
  delta: AuthoringGapRoundDelta
): string {
  const presentedCount =
    delta.first.length +
    delta.partial.length +
    delta.new.length +
    delta.requeued.length +
    delta.unlocked.length;
  if (presentedCount === 0) return AUTHORING_ROUND_COPY_FALLBACK;
  if (delta.first.length > 0) {
    return "Para preparar un borrador seguro, necesito aclarar:";
  }

  const continuesPriorTopic =
    delta.partial.length > 0 || delta.requeued.length > 0;
  if (delta.resolved.length > 0) {
    return continuesPriorTopic
      ? "Gracias, incorporé lo que aclaraste. Sobre lo anterior, solo necesito confirmar:"
      : "Gracias, incorporé lo que aclaraste. Solo necesito aclarar lo siguiente:";
  }
  const onlyRequeued =
    delta.requeued.length > 0 &&
    delta.partial.length === 0 &&
    delta.new.length === 0 &&
    delta.unlocked.length === 0;
  if (onlyRequeued) {
    return "Tu última respuesta no me permitió cerrar este punto. Me falta específicamente:";
  }
  return continuesPriorTopic
    ? "Sobre lo anterior, solo necesito confirmar:"
    : "Para continuar, necesito aclarar lo siguiente:";
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    Number.isSafeInteger(value)
    ? value
    : null;
}

export function normalizeAuthoringQuestionNumberingRegistry(
  value?: Partial<AuthoringQuestionNumberingRegistry> | null
): AuthoringQuestionNumberingRegistry {
  const byGapId: Record<string, number> = {};
  const used = new Set<number>();
  for (const [gapId, rawNumber] of Object.entries(value?.by_gap_id ?? {})) {
    const displayNumber = positiveInteger(rawNumber);
    if (!gapId.trim() || displayNumber === null || used.has(displayNumber)) {
      continue;
    }
    byGapId[gapId] = displayNumber;
    used.add(displayNumber);
  }
  const requestedNext = positiveInteger(value?.next_number) ?? 1;
  let nextNumber = Math.max(requestedNext, ...used, 0);
  if (used.has(nextNumber) || nextNumber < requestedNext) nextNumber += 1;
  while (used.has(nextNumber)) nextNumber += 1;
  return { next_number: nextNumber, by_gap_id: byGapId };
}

/**
 * Numera únicamente el batch presentado. Un gap oculto no consume número y
 * un gap parcial o reencolado conserva el número registrado.
 */
export function assignAuthoringQuestionDisplayNumbers<
  T extends { gap_id?: string; display_number?: number },
>(params: {
  registry?: Partial<AuthoringQuestionNumberingRegistry> | null;
  presented: readonly T[];
}): {
  registry: AuthoringQuestionNumberingRegistry;
  presented: Array<AuthoringNumberedQuestion<T>>;
} {
  const registry = normalizeAuthoringQuestionNumberingRegistry(params.registry);
  const byGapId = { ...registry.by_gap_id };
  const used = new Set(Object.values(byGapId));
  let nextNumber = registry.next_number;
  const takeNext = () => {
    while (used.has(nextNumber)) nextNumber += 1;
    const selected = nextNumber;
    used.add(selected);
    nextNumber += 1;
    return selected;
  };

  const presented = params.presented.map((question) => {
    const gapId = question.gap_id?.trim();
    if (!gapId) return { ...question };
    let displayNumber = byGapId[gapId];
    if (displayNumber === undefined) {
      const persisted = positiveInteger(question.display_number);
      if (persisted !== null && !used.has(persisted)) {
        displayNumber = persisted;
        used.add(persisted);
        if (persisted >= nextNumber) nextNumber = persisted + 1;
      } else {
        displayNumber = takeNext();
      }
      byGapId[gapId] = displayNumber;
    }
    return { ...question, gap_id: gapId, display_number: displayNumber };
  });

  while (used.has(nextNumber)) nextNumber += 1;
  return {
    registry: { next_number: nextNumber, by_gap_id: byGapId },
    presented,
  };
}
