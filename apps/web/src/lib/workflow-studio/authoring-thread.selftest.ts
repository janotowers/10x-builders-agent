import assert from "node:assert/strict";
import {
  hydrateAuthoringThread,
  workFormLabelFromKind,
} from "./authoring-thread";

const thread = hydrateAuthoringThread({
  description: "Cada vez que prepares un seguimiento para un propietario…",
  messages: [
    {
      role: "discovery_question",
      questions: ["¿De qué fuente sale el acuerdo?", "¿Quién aprueba?"],
      question_details: [
        {
          question: "¿De qué fuente sale el acuerdo?",
          target_dimension: "data_sources",
          gap: "Falta la fuente concreta.",
          examples: ["documento Word", "correo", "notas del caso"],
        },
        {
          question: "¿Quién aprueba?",
          target_dimension: "human_decisions",
          gap: "Falta la autoridad de aprobación.",
          examples: [],
        },
      ],
    },
    {
      role: "user_answer",
      content:
        "¿De qué fuente sale el acuerdo? → De un documento Word que entrega el asesor",
    },
    {
      role: "discovery_checkpoint",
      questions: ["¿El resultado es solo borrador?"],
      content: {
        objective: "Preparar seguimiento",
        sources: ["Documento Word"],
        actors: ["Asesor"],
        decisions: [],
        effects: [],
        capabilities: [],
        acceptance_criteria: [],
        assumptions: [],
        gaps: ["Canal de envío"],
      },
      capability_needs: [
        {
          category_id: "user_email",
          category_label: "Correo de usuario",
          provider_id: "gmail",
          provider_name: "Gmail / Google Workspace",
          status: "connected",
          resolution: "assumed_connected",
          capabilities: ["send", "attach_files"],
          connect_href: null,
        },
      ],
    },
  ],
});

assert.equal(thread[0]?.role, "user");
assert.equal(thread[1]?.role, "gu");
assert.equal(thread[1] && "questions" in thread[1] ? thread[1].questions?.length : 0, 2);
assert.equal(
  thread[1] && thread[1].role === "gu"
    ? thread[1].questionDetails?.[0]?.examples.length
    : 0,
  3
);
assert.equal(thread[2]?.role, "user");
assert.equal(
  thread[2] && thread[2].role === "user" ? thread[2].text : "",
  "De un documento Word que entrega el asesor"
);
assert.equal(thread[3]?.role, "gu");
assert.equal(
  thread[3] && thread[3].role === "gu" ? thread[3].kind : "",
  "checkpoint"
);
assert.equal(
  thread[3] && thread[3].role === "gu"
    ? thread[3].capabilityNeeds?.[0]?.provider_id
    : null,
  "gmail"
);
assert.equal(workFormLabelFromKind("reusable_skill"), "Skill reusable");
assert.equal(workFormLabelFromKind("clarify"), null);

console.log("authoring-thread.selftest: all checks passed");
