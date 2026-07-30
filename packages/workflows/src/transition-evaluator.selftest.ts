import assert from "node:assert/strict";
import type { OperationalCaseFlowStep } from "@agents/types";
import { evaluateTransition } from "./transition-evaluator";
import { transformFlowToGraph } from "./transform-flow";

const flow: OperationalCaseFlowStep[] = [
  { step_key: "intake", step_label: "Intake" },
  { step_key: "awaiting_documents", step_label: "Docs" },
  { step_key: "documents_received", step_label: "Recibidos" },
  { step_key: "comparables_in_progress", step_label: "Comparables" },
  { step_key: "price_proposal_pending", step_label: "Precio" },
  { step_key: "contract_pending", step_label: "Contrato" },
  { step_key: "photos_requested", step_label: "Fotos" },
  { step_key: "package_ready", step_label: "Paquete" },
];

const graph = transformFlowToGraph({ caseType: "property_optioning", flow });
const caseType = "property_optioning";

function evaluate(params: {
  currentStep: string | null;
  status?: string | null;
  toStep?: string | null;
  toStatus?: string | null;
  contextPatchKeys?: string[];
  recentEventTypes?: string[];
  context?: Record<string, unknown>;
}) {
  return evaluateTransition({
    graph,
    caseType,
    caseState: {
      currentStep: params.currentStep,
      status: params.status ?? "active",
    },
    proposal: {
      toStep: params.toStep,
      toStatus: params.toStatus,
      proposer: "model",
      contextPatchKeys: params.contextPatchKeys,
    },
    facts: {
      context: params.context ?? {},
      recentEventTypes: params.recentEventTypes ?? [],
    },
  });
}

// 1. Full declared-transition matrix: every declared transition is legal from
// its `from` when its guards are satisfied.
const satisfyingFacts = {
  recentEventTypes: ["external_response"],
  context: {
    comparables_analysis: { data_quality: { unique_comparable_count: 3 } },
  },
};
for (const transition of graph.transitions) {
  const verdict = evaluate({
    currentStep: transition.from,
    toStep: transition.to,
    toStatus: transition.to === "published" ? "completed" : undefined,
    ...satisfyingFacts,
  });
  assert.equal(
    verdict.verdict,
    "legal",
    `declared ${transition.from}→${transition.to} must be legal: ${JSON.stringify(verdict)}`
  );
}

// 2. A sample of undeclared transitions is illegal.
const undeclaredSamples: Array<[string, string]> = [
  ["intake", "package_ready"],
  ["awaiting_documents", "price_proposal_pending"],
  ["contract_pending", "package_ready_x"],
];
for (const [from, to] of undeclaredSamples) {
  const verdict = evaluate({ currentStep: from, toStep: to });
  assert.equal(verdict.verdict, "illegal", `${from}→${to} must be illegal`);
  assert.equal(verdict.reason, "undeclared_transition");
}

// 3. Regression: declared order is enforced by the global guard even before
// transition lookup (guards fixture: package_ready→intake).
const regression = evaluate({ currentStep: "package_ready", toStep: "intake" });
assert.equal(regression.verdict, "illegal");
assert.ok(
  regression.guardResults.some(
    (g) => g.guard === "step_order_no_regression" && !g.pass
  ),
  "regression must fail the step-order guard"
);

// 4. awaiting_documents→documents_received without external_response fails.
const noResponse = evaluate({
  currentStep: "awaiting_documents",
  toStep: "documents_received",
  recentEventTypes: [],
});
assert.equal(noResponse.verdict, "illegal");
assert.ok(
  noResponse.guardResults.some(
    (g) =>
      g.guard === "external_response_exists" &&
      !g.pass &&
      g.reason === "awaiting_documents_requires_external_response"
  )
);

// 5. ...and passes with the event present.
assert.equal(
  evaluate({
    currentStep: "awaiting_documents",
    toStep: "documents_received",
    recentEventTypes: ["external_response"],
  }).verdict,
  "legal"
);

// 6. Comparables advance: 2 unique comparables insufficient, 3 sufficient.
const insufficient = evaluate({
  currentStep: "comparables_in_progress",
  toStep: "price_proposal_pending",
  context: {
    comparables_analysis: { data_quality: { unique_comparable_count: 2 } },
  },
});
assert.equal(insufficient.verdict, "illegal");
assert.ok(
  insufficient.guardResults.some(
    (g) => g.guard === "defensible_comparables_sample" && !g.pass
  )
);
assert.equal(
  evaluate({
    currentStep: "comparables_in_progress",
    toStep: "price_proposal_pending",
    context: {
      comparables_analysis: { data_quality: { unique_comparable_count: 3 } },
    },
  }).verdict,
  "legal"
);

// 7. Protected publication keys fail on any proposal carrying them.
const protectedPatch = evaluate({
  currentStep: "package_ready",
  contextPatchKeys: ["published", "note"],
});
assert.equal(protectedPatch.verdict, "illegal");
assert.ok(
  protectedPatch.guardResults.some(
    (g) => g.guard === "publication_keys_protected" && !g.pass
  )
);
// Benign patch keys pass.
assert.equal(
  evaluate({ currentStep: "package_ready", contextPatchKeys: ["note"] }).verdict,
  "legal"
);

// 8. Completion pairing: published without completed (and vice versa) fails.
const unpaired = evaluate({
  currentStep: "package_ready",
  toStep: "published",
  toStatus: undefined,
});
assert.equal(unpaired.verdict, "illegal");
assert.ok(
  unpaired.guardResults.some((g) => g.guard === "completion_pairing" && !g.pass)
);
const completedOnly = evaluate({
  currentStep: "photos_requested",
  toStatus: "completed",
});
assert.equal(completedOnly.verdict, "illegal");
// The atomic pair is legal.
assert.equal(
  evaluate({
    currentStep: "package_ready",
    toStep: "published",
    toStatus: "completed",
  }).verdict,
  "legal"
);

// 9. Status-only updates (no step change) are legal.
assert.equal(
  evaluate({ currentStep: "contract_pending", toStatus: "waiting_internal" })
    .verdict,
  "legal"
);

// 10. Unstepped case: entering the initial state is legal; skipping is not.
assert.equal(evaluate({ currentStep: null, toStep: "intake" }).verdict, "legal");
assert.equal(
  evaluate({ currentStep: null, toStep: "package_ready" }).verdict,
  "illegal"
);

// 11. Unknown guard in a graph is surfaced as unknown_guard.
const graphWithUnknownGuard = {
  ...graph,
  transitions: graph.transitions.map((t) =>
    t.from === "intake" ? { ...t, guards: ["not_a_real_guard"] } : t
  ),
};
const unknown = evaluateTransition({
  graph: graphWithUnknownGuard,
  caseType,
  caseState: { currentStep: "intake", status: "active" },
  proposal: { toStep: "awaiting_documents", proposer: "model" },
});
assert.equal(unknown.verdict, "illegal");
assert.equal(unknown.reason, "unknown_guard");

console.log("transition-evaluator.selftest: OK");
