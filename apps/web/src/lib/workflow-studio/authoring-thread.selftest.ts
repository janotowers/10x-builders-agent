import assert from "node:assert/strict";
import { planAuthoringGaps } from "@agents/workflows";
import {
  authoringHumanStatus,
  formatAuthoringTechnicalProgress,
  hydrateAuthoringThread,
  workFormLabelFromKind,
} from "./authoring-thread";

const checkpointPlan = planAuthoringGaps([
  {
    key: "recipient",
    summary: "Falta el destinatario",
    target_dimension: "actors",
    question: "¿Quién recibe el resultado?",
    severity: "blocking",
  },
  {
    key: "timezone",
    summary: "Falta la zona horaria",
    target_dimension: "recurrence",
    question: "¿Qué zona horaria usamos?",
    severity: "defaultable",
    safe_default: "America/Mexico_City",
  },
]);

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
      gap_plan: checkpointPlan,
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
    {
      role: "proposal_correction",
      content: "El Word se adjunta en cada ejecución.",
    },
    {
      role: "understanding_summary",
      content: {
        objective: "Preparar seguimiento",
        sources: ["Documento Word"],
        actors: ["Asesor"],
        decisions: ["Autoriza el envío"],
        effects: ["Enviar email"],
        capabilities: ["Gmail"],
        acceptance_criteria: [],
        assumptions: [],
        gaps: [],
      },
      capability_needs: [
        {
          category_id: "user_email",
          category_label: "Correo de usuario",
          provider_id: "gmail",
          provider_name: "Gmail / Google Workspace",
          status: "connected",
          resolution: "assumed_connected",
          capabilities: ["send"],
          connect_href: null,
        },
      ],
      input_requirements: [
        {
          kind: "runtime_input",
          key: "source_document",
          label: "Documento fuente",
          source_hint: "chat_attachment",
        },
      ],
      invocation_channels: [
        {
          channel: "web_chat",
          label: "Web Chat",
          availability: "available",
          supports_text: true,
          supports_generic_attachments: true,
          limitations: [],
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
assert.equal(
  thread[3] && thread[3].role === "gu"
    ? thread[3].pendingBlockers?.length
    : 0,
  1
);
assert.equal(
  thread[3] && thread[3].role === "gu"
    ? thread[3].pendingBlockers?.[0]?.summary
    : "",
  "Falta el destinatario"
);
assert.equal(
  thread[3] && thread[3].role === "gu" ? thread[3].safeDefaults?.[0]?.value : "",
  "America/Mexico_City"
);
assert.equal(
  thread[3] && thread[3].role === "gu" ? thread[3].text : "",
  "Queda 1 decisión necesaria."
);
assert.doesNotMatch(
  thread[3] && thread[3].role === "gu" ? thread[3].text : "",
  /preparo la propuesta/i
);
assert.equal(thread[4]?.role, "user");
assert.equal(
  thread[4] && thread[4].role === "user" ? thread[4].kind : "",
  "correction"
);
assert.equal(
  thread[5] && thread[5].role === "gu"
    ? thread[5].inputRequirements?.[0]?.source_hint
    : null,
  "chat_attachment"
);
assert.equal(
  thread[5] && thread[5].role === "gu"
    ? thread[5].invocationChannels?.[0]?.channel
    : null,
  "web_chat"
);
assert.equal(
  formatAuthoringTechnicalProgress({
    message: "Propuesta actualizada.",
    stage: "review_ready",
  }),
  "Propuesta actualizada. · review_ready"
);
assert.equal(
  authoringHumanStatus({
    phase: "proposal",
    pendingAction: "revise_proposal",
  }),
  "Gu está aplicando tu ajuste a la propuesta…"
);
assert.equal(
  authoringHumanStatus({ phase: "proposal" }),
  "La propuesta está lista para revisar, ajustar o confirmar."
);
assert.equal(workFormLabelFromKind("reusable_skill"), "Skill reusable");
assert.equal(workFormLabelFromKind("clarify"), null);

console.log("authoring-thread.selftest: all checks passed");
