/**
 * Selftest de la capa web del compilador (Slice 4.2-4): clasificación de la
 * salida del modelo (clarification / draft / error, fail-closed) y contrato
 * del prompt (catálogos inyectados, preservación verbatim).
 *
 * Run: npm run test:workflow-compiler --workspace @agents/web
 */

import assert from "node:assert/strict";
import {
  buildCompilerPrompt,
  classifyCompilerOutput,
  compileWorkflowDescription,
  type CompileDescriptionInput,
} from "./compile-definition";

let passed = 0;
function ok(name: string, fn: () => void | Promise<void>): Promise<void> | void {
  const result = fn();
  if (result instanceof Promise) {
    return result.then(() => {
      passed += 1;
      console.log(`  ✓ ${name}`);
    });
  }
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function baseInput(): CompileDescriptionInput {
  return {
    description: "Cuando llegue una propiedad, valuar y publicar con aprobación.",
    caseType: "property_optioning",
    availableGuards: ["step_order_no_regression", "external_response_exists"],
    availableSkills: ["document-analysis"],
    availableCapabilities: ["extraction_consolidation"],
    availableTools: ["read_document"],
  };
}

function validGraph() {
  return {
    states: [
      { key: "intake", kind: "operational" },
      { key: "done", kind: "terminal" },
    ],
    transitions: [
      {
        from: "intake",
        to: "done",
        guards: [],
        authorized_proposers: ["runtime"],
        approval_required: null,
      },
    ],
    step_bindings: [],
    work_templates: [],
    postconditions: [],
    approvals: [],
    impact_dependencies: {},
    completion: { terminal_states: ["done"], required_evidence: [] },
  };
}

function validBusinessSpec() {
  return {
    spec_version: 1,
    title: "Optioning",
    description_nl: "Cuando llegue una propiedad, valuar y publicar con aprobación.",
    objective: "Publicar propiedades valuadas",
    actors: ["asesor"],
    happy_path: ["Recibir", "Valuar", "Publicar"],
    outcomes: ["Propiedad publicada"],
  };
}

function validImplementationSpec() {
  return {
    spec_version: 1,
    summary: "Dos estados",
    states: [
      { key: "intake", kind: "operational" },
      { key: "done", kind: "terminal" },
    ],
  };
}

async function main() {
  console.log("compile-definition.selftest");

  ok("prompt: inyecta catálogos y descripción verbatim", () => {
    const prompt = buildCompilerPrompt(baseInput());
    assert.ok(prompt.includes('"step_order_no_regression"'));
    assert.ok(prompt.includes('"document-analysis"'));
    assert.ok(prompt.includes('"extraction_consolidation"'));
    assert.ok(prompt.includes("Cuando llegue una propiedad"));
    assert.ok(prompt.includes("NEVER embed credentials"));
  });

  ok("prompt: incluye respuestas de rondas de aclaración previas", () => {
    const prompt = buildCompilerPrompt({
      ...baseInput(),
      clarificationAnswers: ["Aprueba el propietario"],
    });
    assert.ok(prompt.includes("Aprueba el propietario"));
  });

  ok("classify: preguntas ⇒ clarification", () => {
    const result = classifyCompilerOutput({
      clarifying_questions: ["¿Quién aprueba el precio?"],
    });
    assert.equal(result.kind, "clarification");
    if (result.kind === "clarification") {
      assert.equal(result.questions.length, 1);
    }
  });

  ok("classify: tres artefactos válidos ⇒ draft", () => {
    const result = classifyCompilerOutput({
      clarifying_questions: [],
      business_spec: validBusinessSpec(),
      implementation_spec: validImplementationSpec(),
      graph: validGraph(),
    });
    assert.equal(result.kind, "draft");
  });

  ok("classify: artefactos incompletos ⇒ error (fail-closed)", () => {
    const result = classifyCompilerOutput({
      clarifying_questions: [],
      business_spec: validBusinessSpec(),
      // sin implementation_spec ni graph
    });
    assert.equal(result.kind, "error");
  });

  ok("classify: salida no conforme al contrato ⇒ error", () => {
    const result = classifyCompilerOutput({ foo: "bar", clarifying_questions: "no" });
    assert.equal(result.kind, "error");
  });

  await ok("compile: modelo inyectado que lanza ⇒ error, jamás draft", async () => {
    const result = await compileWorkflowDescription(baseInput(), {
      compile: async () => {
        throw new Error("boom");
      },
    });
    assert.equal(result.kind, "error");
  });

  await ok("compile: descripción vacía ⇒ error sin invocar el modelo", async () => {
    let invoked = false;
    const result = await compileWorkflowDescription(
      { ...baseInput(), description: "  " },
      {
        compile: async () => {
          invoked = true;
          return {};
        },
      }
    );
    assert.equal(result.kind, "error");
    assert.equal(invoked, false);
  });

  console.log(`\ncompile-definition.selftest: ${passed} checks passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
