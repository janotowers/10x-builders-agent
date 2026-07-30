import type {
  OperationalCaseFlowStep,
  WorkflowGraph,
  WorkflowGraphState,
  WorkflowGraphStepBinding,
  WorkflowGraphTransition,
} from "@agents/types";

/**
 * Flow→graph transformer (Slice 1.2): turns presentation-oriented
 * `operational_flow_jsonb` into the executable `graph_jsonb` contract.
 *
 * The §X.1 divergences are resolved as EXPLICIT transition decisions here
 * (not silent choices) — each is tagged with its finding id:
 *
 * - D1/D2: `property_data_review` is promoted to a first-class state between
 *   documents_received and comparables_in_progress (guards already rank it).
 * - D3: `published` is promoted to a first-class terminal state after
 *   package_ready (completion gate requires the published/completed pair).
 * - D4: awaiting_documents→documents_received keeps the runtime guard
 *   `external_response_exists` for v1 parity; the internal_user branch
 *   conflict is a v2 decision, recorded in §X.
 * - D5: comparables advance encodes `defensible_comparables_sample`
 *   (unique_comparable_count >= 3), not the flow's `usable_count > 0`.
 * - D6: the documented skip documents_received→comparables_in_progress is a
 *   declared transition (extract-property-characteristics prose jumps over
 *   property_data_review; runtime step-order guard allows forward skips).
 */

const PROPERTY_OPTIONING_EXTRA_STATES: Array<{
  key: string;
  after: string;
  label: string;
  kind: WorkflowGraphState["kind"];
}> = [
  {
    key: "property_data_review",
    after: "documents_received",
    label: "Revisión de datos de la propiedad",
    kind: "operational",
  },
  {
    key: "published",
    after: "package_ready",
    label: "Publicado",
    kind: "terminal",
  },
];

function transitionGuardsFor(
  caseType: string,
  from: string,
  to: string
): string[] {
  if (caseType !== "property_optioning") return [];
  if (from === "awaiting_documents" && to === "documents_received") {
    return ["external_response_exists"]; // D4: ported as-is for v1 parity
  }
  if (from === "comparables_in_progress" && to === "price_proposal_pending") {
    return ["defensible_comparables_sample"]; // D5
  }
  if (to === "published") {
    return ["completion_pairing"]; // D3
  }
  return [];
}

function makeTransition(
  caseType: string,
  from: string,
  to: string
): WorkflowGraphTransition {
  return {
    from,
    to,
    guards: transitionGuardsFor(caseType, from, to),
    // v1 keeps proposers permissive: model, decision handlers and runtime all
    // set steps today. Narrowing is an explicit v2 decision after advisory.
    authorized_proposers: ["model", "decision_handler", "runtime"],
    // v1: approval semantics stay with the existing HITL decision handlers;
    // evidence-bound approvals arrive in Phase 3 (Slice 3.3).
    approval_required: null,
  };
}

export function transformFlowToGraph(params: {
  caseType: string;
  flow: OperationalCaseFlowStep[];
}): WorkflowGraph {
  const { caseType, flow } = params;
  if (flow.length === 0) {
    throw new Error(`cannot transform empty flow for case type "${caseType}"`);
  }

  const states: WorkflowGraphState[] = flow.map((step) => ({
    key: step.step_key,
    label: step.step_label,
    kind: "operational",
  }));

  if (caseType === "property_optioning") {
    for (const extra of PROPERTY_OPTIONING_EXTRA_STATES) {
      const anchor = states.findIndex((state) => state.key === extra.after);
      if (anchor === -1) {
        throw new Error(
          `expected anchor state "${extra.after}" missing in property_optioning flow`
        );
      }
      states.splice(anchor + 1, 0, {
        key: extra.key,
        label: extra.label,
        kind: extra.kind,
      });
    }
  } else {
    // Generic flows: the last flow step is the completion state.
    states[states.length - 1] = {
      ...states[states.length - 1],
      kind: "terminal",
    };
  }

  const transitions: WorkflowGraphTransition[] = [];
  for (let i = 0; i < states.length - 1; i += 1) {
    transitions.push(makeTransition(caseType, states[i].key, states[i + 1].key));
  }
  if (caseType === "property_optioning") {
    // D6: documented forward skip over property_data_review.
    transitions.push(
      makeTransition(caseType, "documents_received", "comparables_in_progress")
    );
  }

  const stepBindings: WorkflowGraphStepBinding[] = flow.map((step) => {
    const skill = step.step_skills?.[0]?.skill_slug ?? null;
    const usesBigQuery = (step.step_skills ?? []).some((stepSkill) =>
      (stepSkill.skill_tools ?? []).some(
        (tool) => tool.tool_id === "bigquery_run_query"
      )
    );
    const binding: WorkflowGraphStepBinding = { state: step.step_key, skill };
    if (usesBigQuery) binding.bigquery_context = true;
    return binding;
  });

  const terminalStates = states
    .filter((state) => state.kind === "terminal")
    .map((state) => state.key);

  const graph: WorkflowGraph = {
    states,
    transitions,
    step_bindings: stepBindings,
    work_templates: [],
    postconditions:
      caseType === "property_optioning"
        ? [{ state: "package_ready", checks: ["publication_preflight"] }]
        : [],
    approvals:
      caseType === "property_optioning"
        ? [
            {
              kind: "price",
              evidence_inputs: ["comparables_analysis", "pricing_proposal"],
            },
          ]
        : [],
    impact_dependencies:
      caseType === "property_optioning"
        ? {
            // Methodology-verified hard inputs (§X finding 3): zone, operation,
            // property type, area band; bedrooms/bathrooms/parking are NOT
            // valuation inputs but do drive the listing description.
            valuation: [
              "property.search_zone",
              "property.operation",
              "property.property_type",
              "property.area_construida_m2",
              "property.area_total_m2",
              "comparable_set",
              "methodology",
            ],
            listing_description: [
              "property.bedrooms",
              "property.bathrooms",
              "property.parking_spots",
              "property.neighborhood",
            ],
          }
        : {},
    completion: {
      terminal_states: terminalStates,
      // v1: no persisted evidence kinds exist yet; publication_reconciled
      // becomes required once Phase 3 evidence lands.
      required_evidence: [],
    },
  };

  return graph;
}
