import assert from "node:assert/strict";
import {
  buildAuthoringGapPlan,
  planAuthoringGaps,
  type AuthoringGap,
  type AuthoringGapPlan,
} from "./authoring-gap-planner";
import {
  AUTHORING_ROUND_COPY_FALLBACK,
  assignAuthoringQuestionDisplayNumbers,
  buildAuthoringGapRoundIntro,
  classifyAuthoringGapRound,
  type AuthoringGapRoundDelta,
  type AuthoringGapRoundDeltaKind,
} from "./authoring-gap-round-ux";

function gaps(...keys: string[]): AuthoringGapPlan {
  return planAuthoringGaps(
    keys.map((key) => ({
      key,
      summary: `Falta ${key}`,
      target_dimension: "objective",
      question: `¿Cuál es ${key}?`,
      severity: "blocking" as const,
    }))
  );
}

function withGap(
  plan: AuthoringGapPlan,
  key: string,
  patch: Partial<AuthoringGap>
): AuthoringGapPlan {
  return buildAuthoringGapPlan(
    plan.gaps.map((gap) =>
      gap.summary === `Falta ${key}` ? { ...gap, ...patch } : gap
    )
  );
}

const opening = gaps("fuente", "destinatario", "criterio");
const openingPresented = opening.gaps.slice(0, 2).map((gap) => gap.id);
const first = classifyAuthoringGapRound({
  currentPlan: opening,
  presentedGapIds: openingPresented,
});
assert.equal(first.first.length, 2);
assert.equal(first.remaining.length, 1);
assert.equal(
  buildAuthoringGapRoundIntro(first),
  "Para preparar un borrador seguro, necesito aclarar:"
);

let previous = gaps(
  "resuelto",
  "parcial",
  "reencolado",
  "desbloqueado",
  "restante"
);
previous = withGap(previous, "resuelto", { state: "asked" });
previous = withGap(previous, "parcial", { state: "asked" });
previous = withGap(previous, "reencolado", { state: "asked" });
const unlockedId = previous.gaps.find(
  (gap) => gap.summary === "Falta desbloqueado"
)!.id;
previous = {
  ...previous,
  gaps: previous.gaps.map((gap) =>
    gap.id === unlockedId ? { ...gap, state: "blocked_dependency" } : gap
  ),
};

let current = buildAuthoringGapPlan([
  ...previous.gaps.map((gap) => {
    if (gap.summary === "Falta resuelto") {
      return {
        ...gap,
        state: "answered" as const,
        resolution_status: "resolved" as const,
        resolution: "respondido",
      };
    }
    if (gap.summary === "Falta parcial") {
      return {
        ...gap,
        state: "asked" as const,
        resolution_status: "partial" as const,
        residual: "Falta precisar la parte exacta",
        question: "¿Qué parte exacta sigue faltando?",
      };
    }
    if (gap.summary === "Falta reencolado") {
      return { ...gap, state: "asked" as const };
    }
    if (gap.summary === "Falta desbloqueado") {
      return { ...gap, state: "asked" as const };
    }
    return gap;
  }),
  ...gaps("nuevo").gaps,
]);
const presented = current.gaps
  .filter((gap) =>
    [
      "Falta parcial",
      "Falta reencolado",
      "Falta desbloqueado",
      "Falta nuevo",
    ].includes(gap.summary)
  )
  .map((gap) => gap.id);
const priorPresented = previous.gaps
  .filter((gap) =>
    ["Falta resuelto", "Falta parcial", "Falta reencolado"].includes(
      gap.summary
    )
  )
  .map((gap) => gap.id);
const mixed = classifyAuthoringGapRound({
  previousPlan: previous,
  currentPlan: current,
  presentedGapIds: presented,
  previouslyPresentedGapIds: priorPresented,
});
assert.deepEqual(
  {
    resolved: mixed.resolved.map((item) => item.summary),
    partial: mixed.partial.map((item) => item.summary),
    requeued: mixed.requeued.map((item) => item.summary),
    unlocked: mixed.unlocked.map((item) => item.summary),
    new: mixed.new.map((item) => item.summary),
    remaining: mixed.remaining.map((item) => item.summary),
  },
  {
    resolved: ["Falta resuelto"],
    partial: ["Falta parcial"],
    requeued: ["Falta reencolado"],
    unlocked: ["Falta desbloqueado"],
    new: ["Falta nuevo"],
    remaining: ["Falta restante"],
  }
);
const mixedCopy = buildAuthoringGapRoundIntro(mixed);
assert.equal(
  mixedCopy,
  "Gracias, incorporé lo que aclaraste. Sobre lo anterior, solo necesito confirmar:"
);
assert.doesNotMatch(
  mixedCopy,
  /\bcerré|punto|precisar|retomar|desbloqueado|siguiente ronda\b/i,
  "el copy visible no expone el ledger interno"
);

const empty = classifyAuthoringGapRound({
  previousPlan: current,
  currentPlan: current,
  presentedGapIds: [],
});
assert.equal(buildAuthoringGapRoundIntro(empty), AUTHORING_ROUND_COPY_FALLBACK);

const copyDelta = (
  kind: AuthoringGapRoundDeltaKind,
  summary: string
): AuthoringGapRoundDelta => ({
  first: [],
  resolved: [],
  partial: [],
  new: [],
  requeued: [],
  unlocked: [],
  remaining: [],
  [kind]: [
    {
      kind,
      gap_id: `gap_${kind}`,
      summary,
      current_state: "asked",
    },
  ],
});
const copyTruthTable: Array<[AuthoringGapRoundDelta, string]> = [
  [
    copyDelta("partial", "Falta el canal"),
    "Sobre lo anterior, solo necesito confirmar:",
  ],
  [
    copyDelta("requeued", "Falta el formato"),
    "Tu última respuesta no me permitió cerrar este punto. Me falta específicamente:",
  ],
  [
    copyDelta("unlocked", "Falta el criterio"),
    "Para continuar, necesito aclarar lo siguiente:",
  ],
  [
    copyDelta("new", "Falta el tono"),
    "Para continuar, necesito aclarar lo siguiente:",
  ],
];
for (const [delta, expected] of copyTruthTable) {
  assert.equal(buildAuthoringGapRoundIntro(delta), expected);
}
const resolvedAndNew = copyDelta("new", "Falta el tono");
resolvedAndNew.resolved = copyDelta(
  "resolved",
  "Falta el destinatario"
).resolved;
assert.equal(
  buildAuthoringGapRoundIntro(resolvedAndNew),
  "Gracias, incorporé lo que aclaraste. Solo necesito aclarar lo siguiente:"
);
// Los resúmenes internos nunca se filtran al copy visible.
const longText =
  "¿En qué casos debe activarse esta capacidad y en cuáles debe ceder a otra existente del catálogo?";
const longSummary = copyDelta("new", "Falta el tono");
longSummary.resolved = copyDelta("resolved", longText).resolved;
const longCopy = buildAuthoringGapRoundIntro(longSummary);
assert.doesNotMatch(longCopy, /ceder a otra|…/u);

const firstNumbers = assignAuthoringQuestionDisplayNumbers({
  presented: [
    { gap_id: "gap_a", question: "A" },
    { gap_id: "gap_b", question: "B" },
  ],
});
assert.deepEqual(
  firstNumbers.presented.map((item) => item.display_number),
  [1, 2]
);
const hiddenGapWasNotNumbered = assignAuthoringQuestionDisplayNumbers({
  registry: firstNumbers.registry,
  presented: [{ gap_id: "gap_hidden", question: "H" }],
});
assert.equal(hiddenGapWasNotNumbered.presented[0]?.display_number, 3);
const reused = assignAuthoringQuestionDisplayNumbers({
  registry: hiddenGapWasNotNumbered.registry,
  presented: [
    { gap_id: "gap_b", question: "B, más precisa" },
    { gap_id: "gap_a", question: "A, reencolada" },
  ],
});
assert.deepEqual(
  reused.presented.map((item) => item.display_number),
  [2, 1]
);
assert.equal(reused.registry.next_number, 4);

const persistedNonContiguous = assignAuthoringQuestionDisplayNumbers({
  registry: {
    next_number: 8,
    by_gap_id: { gap_old: 2, gap_other: 7 },
  },
  presented: [
    { gap_id: "gap_other", question: "Siete" },
    { gap_id: "gap_new", question: "Ocho" },
  ],
});
assert.deepEqual(
  persistedNonContiguous.presented.map((item) => item.display_number),
  [7, 8]
);

console.log("authoring-gap-round-ux.selftest: all checks passed");
