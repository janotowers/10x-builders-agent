import assert from "node:assert/strict";
import { classifyAuthoringIntentDeterministic } from "@agents/workflows";
import { runAuthoringDiscovery } from "./authoring-discovery";

const description =
  "Cada vez que prepares un seguimiento para un propietario, resume el último acuerdo.";
const routerSignal = classifyAuthoringIntentDeterministic(description);
if (!routerSignal) throw new Error("router signal required");

const validDiscovery = {
  provisional_kind: "reusable_skill",
  final_kind: "reusable_skill",
  skill_subtype: "simple",
  confidence: "medium",
  rationale: ["Es un procedimiento reusable."],
  covered_dimensions: [
    {
      key: "objective",
      status: "covered",
      summary: "Preparar seguimiento.",
      evidence: [
        {
          source: "description",
          quote: "prepares un seguimiento para un propietario",
        },
      ],
    },
  ],
  material_ambiguities: ["Falta la fuente del último acuerdo."],
  clarifying_questions: ["¿Dónde está registrado el último acuerdo?"],
  clarifying_question_details: [
    {
      question: "¿Dónde está registrado el último acuerdo?",
      target_dimension: "data_sources",
      gap: "Falta la fuente concreta del último acuerdo.",
      examples: ["documento Word", "correo", "notas del caso"],
    },
  ],
  assumptions: [],
  gaps: ["Falta la fuente del último acuerdo."],
  requested_side_effects: [],
  readiness: "needs_clarification",
  suggested_title: "Seguimiento a propietarios",
  suggested_slug: "owner_followup_message",
  understanding: {
    objective: "Preparar un seguimiento basado en el último acuerdo.",
    sources: [],
    actors: ["Propietario"],
    decisions: [],
    effects: [],
    capabilities: [],
    acceptance_criteria: [],
    assumptions: [],
    gaps: ["Falta la fuente del último acuerdo."],
  },
};

async function repairOnce(): Promise<void> {
  const prompts: string[] = [];
  const responses = [
    {
      ...validDiscovery,
      covered_dimensions: [
        {
          key: "objective",
          status: "covered",
          summary: "Preparar seguimiento.",
          evidence: [
            {
              source: "description",
              quote: "texto que no existe",
            },
          ],
        },
      ],
    },
    validDiscovery,
  ];
  const result = await runAuthoringDiscovery({
    description,
    routerSignal: routerSignal!,
    catalogs: {
      skills: [],
      tools: [],
      integrations: [],
      assets: [],
      workerCapabilities: [],
    },
    model: {
      async discover(prompt) {
        prompts.push(prompt);
        return responses.shift();
      },
    },
  });
  assert.equal(result.kind, "ok");
  assert.equal(prompts.length, 2);
  assert.match(prompts[1] ?? "", /Repair a Gu OS Studio/);
}

async function blocksAfterFailedRepair(): Promise<void> {
  let calls = 0;
  const answer =
    "Está en un documento Word. El usuario revisa y aprueba; después Gu envía el email.";
  const result = await runAuthoringDiscovery({
    description,
    answers: [answer],
    latestAnswer: answer,
    routerSignal: routerSignal!,
    catalogs: {
      skills: [],
      tools: [],
      integrations: [],
      assets: [],
      workerCapabilities: [],
    },
    model: {
      async discover() {
        calls += 1;
        return { invalid: true };
      },
    },
  });
  assert.equal(result.kind, "fail_closed");
  assert.equal(calls, 2);
  assert.equal(result.discovery.readiness, "blocked_reformulate");
  assert.deepEqual(result.discovery.understanding.sources, []);
  assert.deepEqual(result.discovery.understanding.actors, []);
  assert.deepEqual(result.discovery.understanding.effects, []);
  assert.equal(result.discovery.clarifying_questions.length, 0);
}

async function main(): Promise<void> {
  await repairOnce();
  await blocksAfterFailedRepair();
  console.log("authoring-discovery.selftest: all checks passed");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
