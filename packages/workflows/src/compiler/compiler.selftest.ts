/**
 * Selftest del compilador (Slices 4.2-1/4.2-2/4.2-3).
 *
 * Run: npm run test:compiler --workspace @agents/workflows
 */

import assert from "node:assert/strict";
import type { WorkflowGraph } from "@agents/types";
import {
  businessSpecSchema,
  compilerOutputSchema,
  implementationSpecSchema,
  isClarificationRound,
  specIsPresent,
} from "./spec-schemas";
import { resolveCapabilityMap, type CapabilityCatalogs } from "./capability-map";
import { runDefinitionValidationGates } from "./validation-gates";
import { buildSyntheticHappyPathScenario, runSimulationGate } from "./simulation";

let passed = 0;
function ok(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// ─── Fixture: grafo mínimo bien formado ─────────────────────────────────────

function fixtureGraph(): WorkflowGraph {
  return {
    states: [
      { key: "intake", kind: "operational", label: "Intake" },
      { key: "awaiting_documents", kind: "operational", label: "Documentos" },
      { key: "analysis", kind: "operational", label: "Análisis" },
      { key: "done", kind: "terminal", label: "Cerrado" },
    ],
    transitions: [
      {
        from: "intake",
        to: "awaiting_documents",
        guards: ["step_order_no_regression"],
        authorized_proposers: ["model", "runtime"],
        approval_required: null,
      },
      {
        from: "awaiting_documents",
        to: "analysis",
        guards: ["external_response_exists"],
        authorized_proposers: ["model", "runtime"],
        approval_required: null,
      },
      {
        from: "analysis",
        to: "done",
        guards: ["step_order_no_regression"],
        authorized_proposers: ["model", "decision_handler", "runtime"],
        approval_required: null,
      },
    ],
    step_bindings: [
      {
        state: "analysis",
        skill: "document-analysis",
        required_assets: [
          {
            asset_key: "commission_contract_template",
            label: "Plantilla de contrato de comisión",
          },
          {
            asset_key: "listing_photo_watermark",
            label: "Marca de agua para fotos",
            required: false,
          },
        ],
      },
    ],
    work_templates: [
      {
        on_enter_state: "analysis",
        work_type: "consolidate_extraction",
        required_capability: "extraction_consolidation",
      },
    ],
    postconditions: [],
    approvals: [],
    impact_dependencies: {},
    completion: { terminal_states: ["done"], required_evidence: [] },
  };
}

function fullCatalogs(): CapabilityCatalogs {
  return {
    skillSlugs: ["document-analysis"],
    toolIds: ["read_document", "send_email"],
    toolIntegrationById: new Map([
      ["read_document", undefined],
      ["send_email", "gmail"],
    ]),
    skillAllowedTools: new Map([["document-analysis", ["read_document", "send_email"]]]),
    workerCapabilities: ["extraction_consolidation"],
    knownGuards: [
      "step_order_no_regression",
      "external_response_exists",
      "defensible_comparables_sample",
    ],
    tenantConfiguredAssetKeys: ["commission_contract_template"],
    connectedIntegrations: ["gmail"],
  };
}

function fixtureBusinessSpec() {
  return {
    spec_version: 1,
    title: "Análisis documental",
    description_nl: "Cuando llegue un caso, pedir documentos y analizarlos.",
    objective: "Analizar documentos del cliente",
    actors: ["asesor", "cliente"],
    happy_path: ["Recibir caso", "Pedir documentos", "Analizar", "Cerrar"],
    outcomes: ["Documentos analizados"],
  };
}

function fixtureImplementationSpec() {
  return {
    spec_version: 1,
    summary: "4 estados con consolidación de extracción",
    states: [
      { key: "intake", kind: "operational" as const },
      { key: "done", kind: "terminal" as const },
    ],
    skills: ["document-analysis"],
  };
}

console.log("compiler.selftest");

// ─── Spec schemas ───────────────────────────────────────────────────────────

ok("business spec válido parsea y aplica defaults", () => {
  const parsed = businessSpecSchema.parse(fixtureBusinessSpec());
  assert.deepEqual(parsed.decisions, []);
  assert.deepEqual(parsed.unimplementable_notes, []);
});

ok("business spec sin objective falla el schema", () => {
  const { objective: _omitted, ...invalid } = fixtureBusinessSpec();
  assert.equal(businessSpecSchema.safeParse(invalid).success, false);
});

ok("implementation spec válido parsea", () => {
  const parsed = implementationSpecSchema.parse(fixtureImplementationSpec());
  assert.deepEqual(parsed.tools, []);
});

ok("salida del compilador: ronda de aclaración detectada", () => {
  const output = compilerOutputSchema.parse({
    clarifying_questions: ["¿Quién aprueba el precio?"],
  });
  assert.equal(isClarificationRound(output), true);
});

ok("specIsPresent: {} cuenta como ausente (definiciones pre-compiler)", () => {
  assert.equal(specIsPresent({}), false);
  assert.equal(specIsPresent(fixtureBusinessSpec()), true);
  assert.equal(specIsPresent(null), false);
});

// ─── Capability map ─────────────────────────────────────────────────────────

ok("capability map: todo resuelto ⇒ ok, sin gaps bloqueantes", () => {
  const map = resolveCapabilityMap(fixtureGraph(), fullCatalogs());
  assert.equal(map.ok, true);
  assert.equal(map.blockingGaps.length, 0);
  const kinds = new Set(map.entries.map((e) => e.kind));
  assert.ok(kinds.has("skill"));
  assert.ok(kinds.has("tool"));
  assert.ok(kinds.has("worker_capability"));
  assert.ok(kinds.has("guard"));
  assert.ok(kinds.has("account_asset"));
  assert.ok(kinds.has("integration"));
});

ok("capability map: asset opcional (required:false) no genera requirement", () => {
  const map = resolveCapabilityMap(fixtureGraph(), fullCatalogs());
  assert.equal(
    map.entries.some((e) => e.key === "listing_photo_watermark"),
    false
  );
});

ok("capability map: asset faltante ⇒ gap NO bloqueante con wording de cliente", () => {
  const catalogs = { ...fullCatalogs(), tenantConfiguredAssetKeys: [] };
  const map = resolveCapabilityMap(fixtureGraph(), catalogs);
  assert.equal(map.ok, true); // backlog, no bloquea
  const gap = map.gaps.find((g) => g.kind === "account_asset");
  assert.ok(gap);
  assert.equal(gap.blocking, false);
  assert.equal(gap.linkHint, "assets_panel");
  assert.ok(gap.customerMessage.includes("plantilla de contrato de comisión"));
  assert.ok(!gap.customerMessage.includes("asset")); // sin jerga interna
});

ok("capability map: integración desconectada ⇒ gap NO bloqueante", () => {
  const catalogs = { ...fullCatalogs(), connectedIntegrations: [] };
  const map = resolveCapabilityMap(fixtureGraph(), catalogs);
  assert.equal(map.ok, true);
  const gap = map.gaps.find((g) => g.kind === "integration" && g.key === "gmail");
  assert.ok(gap);
  assert.equal(gap.linkHint, "integrations_panel");
});

ok("capability map: skill/guard/capacidad inexistentes ⇒ gaps bloqueantes", () => {
  const catalogs: CapabilityCatalogs = {
    ...fullCatalogs(),
    skillSlugs: [],
    workerCapabilities: [],
    knownGuards: ["step_order_no_regression"],
  };
  const map = resolveCapabilityMap(fixtureGraph(), catalogs);
  assert.equal(map.ok, false);
  const blockingKinds = new Set(map.blockingGaps.map((g) => g.kind));
  assert.ok(blockingKinds.has("skill"));
  assert.ok(blockingKinds.has("worker_capability"));
  assert.ok(blockingKinds.has("guard"));
});

// ─── Gates de validación ────────────────────────────────────────────────────

ok("gates: grafo y specs válidos ⇒ todos pasan", () => {
  const result = runDefinitionValidationGates({
    graphValue: fixtureGraph(),
    businessSpecValue: fixtureBusinessSpec(),
    implementationSpecValue: fixtureImplementationSpec(),
    catalogs: fullCatalogs(),
  });
  assert.equal(result.ok, true, JSON.stringify(result.gates, null, 2));
  const names = result.gates.map((g) => g.gate).sort();
  assert.deepEqual(names, [
    "acyclicity",
    "capability_resolution",
    "credential_shape",
    "fidelity",
    "graph_schema",
    "permission_validation",
    "reachability",
    "spec_schema",
  ]);
});

ok("gates: ciclo ⇒ falla acyclicity", () => {
  const graph = fixtureGraph();
  graph.transitions.push({
    from: "analysis",
    to: "intake",
    guards: [],
    authorized_proposers: ["runtime"],
    approval_required: null,
  });
  const result = runDefinitionValidationGates({
    graphValue: graph,
    catalogs: fullCatalogs(),
  });
  const gate = result.gates.find((g) => g.gate === "acyclicity");
  assert.equal(gate?.result, "fail");
  assert.equal(result.ok, false);
});

ok("gates: estado inalcanzable ⇒ falla reachability", () => {
  const graph = fixtureGraph();
  graph.states.push({ key: "orphan", kind: "terminal" });
  const result = runDefinitionValidationGates({
    graphValue: graph,
    catalogs: fullCatalogs(),
  });
  const gate = result.gates.find((g) => g.gate === "reachability");
  assert.equal(gate?.result, "fail");
});

ok("gates: gap bloqueante ⇒ falla capability_resolution; backlog viaja en detail", () => {
  const graph = fixtureGraph();
  graph.step_bindings[0].skill = "skill-inexistente";
  const catalogs = { ...fullCatalogs(), tenantConfiguredAssetKeys: [] };
  const result = runDefinitionValidationGates({ graphValue: graph, catalogs });
  const gate = result.gates.find((g) => g.gate === "capability_resolution");
  assert.equal(gate?.result, "fail");
  const backlog = gate?.detail.backlog_gaps as Array<{ kind: string }>;
  assert.ok(backlog.some((g) => g.kind === "account_asset"));
});

ok("gates: skill con tool fuera de catálogo ⇒ falla permission_validation", () => {
  const catalogs: CapabilityCatalogs = {
    ...fullCatalogs(),
    skillAllowedTools: new Map([["document-analysis", ["tool_fantasma"]]]),
  };
  const result = runDefinitionValidationGates({
    graphValue: fixtureGraph(),
    catalogs,
  });
  const gate = result.gates.find((g) => g.gate === "permission_validation");
  assert.equal(gate?.result, "fail");
});

ok("gates: credencial embebida ⇒ falla credential_shape", () => {
  const graph = fixtureGraph() as unknown as Record<string, unknown>;
  graph.impact_dependencies = { api_key: [] }; // clave sin valor string: pasa
  const withValue = {
    ...fixtureGraph(),
    step_bindings: [
      {
        state: "analysis",
        skill: null,
        required_assets: [
          {
            asset_key: "x",
            label: "X",
            description: "usar api_key sk-abcdefghijklmnop1234 para el portal",
          },
        ],
      },
    ],
  };
  const result = runDefinitionValidationGates({
    graphValue: withValue,
    catalogs: fullCatalogs(),
  });
  const gate = result.gates.find((g) => g.gate === "credential_shape");
  assert.equal(gate?.result, "fail");
});

ok("gates: spec inválido presente ⇒ falla spec_schema; {} no falla", () => {
  const bad = runDefinitionValidationGates({
    graphValue: fixtureGraph(),
    businessSpecValue: { title: "sin lo demás" },
    catalogs: fullCatalogs(),
  });
  assert.equal(bad.gates.find((g) => g.gate === "spec_schema")?.result, "fail");

  const empty = runDefinitionValidationGates({
    graphValue: fixtureGraph(),
    businessSpecValue: {},
    implementationSpecValue: {},
    catalogs: fullCatalogs(),
  });
  assert.equal(empty.gates.find((g) => g.gate === "spec_schema")?.result, "pass");
});

// ─── Simulación ─────────────────────────────────────────────────────────────

ok("simulación: camino feliz sintético satisface guards de historia", () => {
  const scenario = buildSyntheticHappyPathScenario(fixtureGraph());
  assert.ok(scenario);
  // La transición awaiting_documents→analysis exige external_response.
  assert.ok(scenario.events.some((e) => e.event_type === "external_response"));
  assert.equal(scenario.finalStep, "done");

  const { gate, outcomes } = runSimulationGate({
    graph: fixtureGraph(),
    caseType: "test_case",
  });
  assert.equal(gate.result, "pass", JSON.stringify(outcomes, null, 2));
  assert.equal(outcomes[0].ok, true);
});

ok("simulación: escenario que no llega al terminal esperado ⇒ falla", () => {
  const { gate } = runSimulationGate({
    graph: fixtureGraph(),
    caseType: "test_case",
    scenarios: [
      {
        key: "truncado",
        label: "Se queda a medias",
        events: [
          {
            event_type: "case_updated",
            actor: "system",
            payload_jsonb: {
              from: { current_step: "intake" },
              to: { current_step: "awaiting_documents" },
            },
          },
        ],
        finalStep: "done",
        initialStep: "intake",
      },
    ],
  });
  assert.equal(gate.result, "fail");
});

ok("simulación: transición ilegal (guard insatisfecho) ⇒ divergencia y fail", () => {
  const { gate, outcomes } = runSimulationGate({
    graph: fixtureGraph(),
    caseType: "test_case",
    scenarios: [
      {
        key: "sin_respuesta_externa",
        label: "Avanza sin external_response",
        events: [
          {
            event_type: "case_updated",
            actor: "system",
            payload_jsonb: {
              from: { current_step: "awaiting_documents" },
              to: { current_step: "analysis" },
            },
          },
        ],
        finalStep: "analysis",
        initialStep: "awaiting_documents",
      },
    ],
  });
  assert.equal(gate.result, "fail");
  assert.ok(
    outcomes[0].divergences.some((d) =>
      d.failedGuards.includes("external_response_exists")
    )
  );
});

ok("simulación: grafo sin ruta a terminal ⇒ fail explícito", () => {
  const graph = fixtureGraph();
  graph.transitions = graph.transitions.filter((t) => t.to !== "done");
  const { gate } = runSimulationGate({ graph, caseType: "test_case" });
  assert.equal(gate.result, "fail");
});

ok("simulación: prefiere terminal de éxito sobre descarte más corto", () => {
  const graph = fixtureGraph();
  graph.states.push({ key: "seguimiento_descartado", kind: "terminal" });
  graph.completion.terminal_states.push("seguimiento_descartado");
  // Rama corta de cancelación desde intake
  graph.transitions.push({
    from: "intake",
    to: "seguimiento_descartado",
    guards: [],
    authorized_proposers: ["model", "decision_handler", "runtime"],
    approval_required: null,
  });
  const scenario = buildSyntheticHappyPathScenario(graph);
  assert.ok(scenario);
  assert.equal(scenario.finalStep, "done");
});

ok("simulación: usa proposer autorizado cuando falta runtime", () => {
  const graph = fixtureGraph();
  for (const transition of graph.transitions) {
    transition.authorized_proposers = ["model"];
  }
  const { gate, outcomes } = runSimulationGate({
    graph,
    caseType: "test_case",
  });
  assert.equal(gate.result, "pass", JSON.stringify(outcomes, null, 2));
});

console.log(`\ncompiler.selftest: ${passed} checks passed`);
