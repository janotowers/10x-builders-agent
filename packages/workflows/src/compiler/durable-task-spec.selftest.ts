import assert from "node:assert/strict";
import {
  durableTaskSpecSchema,
  durableTaskTemplatesToWorkItems,
} from "./durable-task-spec";

const spec = durableTaskSpecSchema.parse({
  spec_version: 1,
  title: "Reporte de inventario",
  objective: "Analizar inventario y entregar un reporte.",
  acceptance_criteria: ["Incluye las 300 propiedades solicitadas."],
  input_requirements: [
    {
      kind: "runtime_input",
      key: "inventory_scope",
      label: "Alcance del inventario",
      required: true,
    },
  ],
  work_templates: [
    {
      work_type: "analyze_inventory",
      required_capability: "durable_task_execution",
      objective: "Analizar el inventario.",
      exit_criteria: ["El análisis está completo."],
    },
  ],
  result_contract: {
    required_keys: ["outputs"],
    description: "Reporte consolidado.",
  },
  retention_policy: { result_days: 365, input_days: 90 },
});

const templates = durableTaskTemplatesToWorkItems(spec);
assert.equal(templates.length, 1);
assert.equal(templates[0].required_capability, "durable_task_execution");
assert.deepEqual(templates[0].output_contract.required_keys, [
  "response_summary",
]);
assert.equal(
  templates[0].verification_contract.human_review_required,
  true
);
assert.deepEqual(templates[0].input_contract.input_requirements, [
  {
    kind: "runtime_input",
    key: "inventory_scope",
    label: "Alcance del inventario",
    required: true,
  },
]);

assert.throws(() =>
  durableTaskSpecSchema.parse({
    ...spec,
    work_templates: [],
  })
);

console.log("durable-task-spec.selftest: ok");
