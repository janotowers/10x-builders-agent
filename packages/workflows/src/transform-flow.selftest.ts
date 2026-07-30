import assert from "node:assert/strict";
import type { OperationalCaseFlowStep } from "@agents/types";
import { validateWorkflowGraph } from "./graph-schema";
import { registerBuiltinGuards } from "./guards/builtins";
import { registeredGuardNames } from "./guards/registry";
import { computeDefinitionHash } from "./hash";
import { transformFlowToGraph } from "./transform-flow";

registerBuiltinGuards();

// Realistic fixture: the 8 property_optioning flow steps (00025 seed + patches).
const propertyOptioningFlow: OperationalCaseFlowStep[] = [
  { step_key: "intake", step_label: "Completar registro del caso", step_tools: [] },
  {
    step_key: "awaiting_documents",
    step_label: "Reunir documentos",
    step_skills: [{ skill_slug: "request-property-documents" }],
  },
  {
    step_key: "documents_received",
    step_label: "Procesar documentos",
    step_skills: [{ skill_slug: "extract-property-characteristics" }],
  },
  {
    step_key: "comparables_in_progress",
    step_label: "Analizar comparables",
    step_skills: [
      {
        skill_slug: "perform-comparable-analysis",
        skill_tools: [{ tool_id: "bigquery_run_query" }],
      },
    ],
  },
  {
    step_key: "price_proposal_pending",
    step_label: "Proponer precio",
    step_skills: [{ skill_slug: "prepare-listing-price" }],
  },
  {
    step_key: "contract_pending",
    step_label: "Preparar contrato",
    step_skills: [{ skill_slug: "prepare-commission-contract" }],
  },
  {
    step_key: "photos_requested",
    step_label: "Coordinar fotos",
    step_skills: [{ skill_slug: "request-property-photos" }],
  },
  {
    step_key: "package_ready",
    step_label: "Gestionar publicación",
    step_skills: [{ skill_slug: "publish-listing-package" }],
  },
];

const graph = transformFlowToGraph({
  caseType: "property_optioning",
  flow: propertyOptioningFlow,
});

// 1. D1/D2/D3: promoted states present, in guard-rank order (10 states).
assert.deepEqual(
  graph.states.map((s) => s.key),
  [
    "intake",
    "awaiting_documents",
    "documents_received",
    "property_data_review",
    "comparables_in_progress",
    "price_proposal_pending",
    "contract_pending",
    "photos_requested",
    "package_ready",
    "published",
  ],
  "state order must match PROPERTY_OPTIONING_STEP_ORDER"
);

// 2. published is terminal.
assert.equal(graph.states.find((s) => s.key === "published")?.kind, "terminal");
assert.deepEqual(graph.completion.terminal_states, ["published"]);

// 3. Structural gates: schema-valid, acyclic, reachable, guards registered.
const validation = validateWorkflowGraph(graph, {
  knownGuards: registeredGuardNames(),
});
assert.equal(
  validation.ok,
  true,
  `graph must pass validation gates: ${JSON.stringify(validation.issues)}`
);

// 4. D4: awaiting_documents→documents_received keeps external_response guard.
const docTransition = graph.transitions.find(
  (t) => t.from === "awaiting_documents" && t.to === "documents_received"
);
assert.deepEqual(docTransition?.guards, ["external_response_exists"]);

// 5. D5: comparables advance uses the defensible-sample guard.
const comparablesTransition = graph.transitions.find(
  (t) => t.from === "comparables_in_progress" && t.to === "price_proposal_pending"
);
assert.deepEqual(comparablesTransition?.guards, ["defensible_comparables_sample"]);

// 6. D6: documented skip over property_data_review is declared.
assert.ok(
  graph.transitions.some(
    (t) => t.from === "documents_received" && t.to === "comparables_in_progress"
  ),
  "documents_received→comparables_in_progress skip must be declared"
);

// 7. Publishing requires the completion pairing guard.
const publishTransition = graph.transitions.find((t) => t.to === "published");
assert.deepEqual(publishTransition?.guards, ["completion_pairing"]);

// 8. Step bindings: skill per step; bigquery flagged for comparables.
const comparablesBinding = graph.step_bindings.find(
  (b) => b.state === "comparables_in_progress"
);
assert.equal(comparablesBinding?.skill, "perform-comparable-analysis");
assert.equal(comparablesBinding?.bigquery_context, true);
assert.equal(
  graph.step_bindings.find((b) => b.state === "intake")?.skill,
  null
);

// 9. Hash stability: same flow → same hash; different flow → different hash.
const again = transformFlowToGraph({
  caseType: "property_optioning",
  flow: propertyOptioningFlow,
});
assert.equal(computeDefinitionHash(graph), computeDefinitionHash(again));
const mutated = transformFlowToGraph({
  caseType: "property_optioning",
  flow: propertyOptioningFlow.slice(0, 7).concat([
    { ...propertyOptioningFlow[7], step_label: "Otro label" },
  ]),
});
assert.notEqual(computeDefinitionHash(graph), computeDefinitionHash(mutated));

// 10. Generic flows: linear chain, last step terminal, no PO-only extras.
const genericGraph = transformFlowToGraph({
  caseType: "lead_follow_up",
  flow: [
    { step_key: "capture", step_label: "Capturar lead" },
    { step_key: "follow_up", step_label: "Dar seguimiento" },
    { step_key: "closed", step_label: "Cerrado" },
  ],
});
assert.deepEqual(
  genericGraph.states.map((s) => s.key),
  ["capture", "follow_up", "closed"]
);
assert.equal(genericGraph.states[2].kind, "terminal");
assert.equal(genericGraph.transitions.length, 2);
assert.deepEqual(genericGraph.postconditions, []);
const genericValidation = validateWorkflowGraph(genericGraph, {
  knownGuards: registeredGuardNames(),
});
assert.equal(genericValidation.ok, true);

// 11. Empty flow rejected.
assert.throws(() =>
  transformFlowToGraph({ caseType: "property_optioning", flow: [] })
);

console.log("transform-flow.selftest: OK");
