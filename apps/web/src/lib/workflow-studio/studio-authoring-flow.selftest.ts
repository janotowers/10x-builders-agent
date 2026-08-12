import assert from "node:assert/strict";
import {
  authoringDiscoveryOutputSchema,
  planAuthoringGaps,
  resolveAuthoringConversationTurn,
} from "@agents/workflows";
import {
  applyAuthoringRoundIntro,
  hydrateAuthoringThread,
} from "./authoring-thread";

const dimensions = [
  "objective",
  "data_sources",
  "actors",
  "human_decisions",
  "side_effects",
  "capabilities",
  "acceptance_criteria",
  "durability",
  "recurrence",
  "mece_overlap",
] as const;

const openPlan = planAuthoringGaps([
  {
    key: "external_message.recipient_resolution",
    summary: "Falta saber cómo recibirá Gu el email.",
    target_dimension: "actors",
    question:
      "¿Cómo recibirá Gu el email del propietario cada vez que se use esta función?",
    severity: "blocking",
  },
]);

const discovery = authoringDiscoveryOutputSchema.parse({
  provisional_kind: "reusable_skill",
  final_kind: "reusable_skill",
  skill_subtype: "simple",
  confidence: "high",
  rationale: ["Procedimiento reusable."],
  covered_dimensions: dimensions.map((key) => ({
    key,
    status: key === "actors" ? "partial" : "not_applicable",
    summary: key === "actors" ? "Falta la estrategia de contacto." : "No aplica.",
    evidence: [],
  })),
  material_ambiguities: ["Falta la estrategia de contacto."],
  clarifying_questions: [
    "¿Cómo recibirá Gu el email del propietario cada vez que se use esta función?",
  ],
  clarifying_question_details: [
    {
      question:
        "¿Cómo recibirá Gu el email del propietario cada vez que se use esta función?",
      target_dimension: "actors",
      gap: "Falta la estrategia de contacto.",
      gap_id: openPlan.gaps[0]!.id,
      display_number: 4,
      examples: ["el usuario lo escribe en el chat"],
    },
  ],
  gap_plan: openPlan,
  assumptions: [],
  gaps: [],
  prior_gap_dispositions: [],
  requested_side_effects: ["send_message", "human_approval"],
  capability_needs: [],
  input_requirements: [],
  invocation_channels: [],
  readiness: "needs_clarification",
  understanding: {
    objective: "Preparar y enviar un seguimiento a un propietario.",
    sources: ["Documento aportado en cada conversación."],
    actors: ["Usuario inmobiliario", "propietario"],
    decisions: ["El usuario revisa y aprueba el mensaje."],
    effects: ["Enviar un email después de la aprobación."],
    capabilities: ["Preparar el mensaje y solicitar aprobación."],
    acceptance_criteria: ["Datos fieles al documento."],
    assumptions: [],
    gaps: [],
  },
});

const thirdAnswer = resolveAuthoringConversationTurn({
  discovery,
  answerTurnCount: 3,
});
assert.equal(
  thirdAnswer.phase,
  "discovering",
  "turn 3 continues while a blocking question remains"
);

const checkpointMessage = "Ya puedo preparar una propuesta. ¿Quieres afinarla?";
const checkpointConversation = applyAuthoringRoundIntro({
  phase: "checkpoint",
  conversation: { human_message: checkpointMessage },
  roundIntro: "Gracias, incorporé lo que aclaraste.",
});
assert.equal(checkpointConversation.human_message, checkpointMessage);

const question = (number: number, gapId: string, text: string) => ({
  role: "discovery_question",
  human_message: number === 1 ? "Necesito aclarar:" : "Solo necesito confirmar:",
  questions: [text],
  question_details: [
    {
      question: text,
      target_dimension: "actors",
      gap: text,
      gap_id: gapId,
      display_number: number,
      examples: number === 1 ? ["un documento Word"] : [],
    },
  ],
});

const thread = hydrateAuthoringThread({
  description: "Redactar un seguimiento para un propietario.",
  messages: [
    question(1, "gap_00000001", "¿Dónde encontrará Gu la información?"),
    { role: "user_answer", content: "En un documento Word." },
    question(2, "gap_00000002", "¿Quién revisa el mensaje?"),
    { role: "user_answer", content: "El usuario inmobiliario." },
    question(3, "gap_00000003", "¿Cuándo debe usarse esta función?"),
    { role: "user_answer", content: "Para seguimientos a propietarios." },
    question(
      4,
      openPlan.gaps[0]!.id,
      "¿Cómo recibirá Gu el email del propietario?"
    ),
    {
      role: "user_answer",
      content:
        "Ya te había comentado que el usuario le dará a Gu el email en la conversación.",
    },
    {
      role: "discovery_checkpoint",
      human_message: checkpointConversation.human_message,
      content: discovery.understanding,
      questions: [],
      gap_plan: planAuthoringGaps([]),
      capability_needs: [
        {
          category_id: "user_email",
          category_label: "Correo",
          provider_id: "gmail",
          provider_name: "Gmail / Google Workspace",
          status: "connected",
          resolution: "assumed_connected",
          capabilities: ["send"],
          connect_href: null,
        },
      ],
      invocation_channels: [
        {
          channel: "telegram",
          label: "Telegram",
          availability: "available",
          supports_text: true,
          supports_generic_attachments: true,
          limitations: [],
        },
      ],
    },
  ],
});

assert.deepEqual(
  thread
    .filter((message) => message.role === "gu" && message.kind === "questions")
    .flatMap((message) =>
      message.role === "gu"
        ? (message.questionPresentations ?? []).map(
            (presentation) => presentation.displayNumber
          )
        : []
    ),
  [1, 2, 3, 4],
  "question numbers continue across the complete transcript"
);
const checkpoint = thread.at(-1);
assert.equal(
  checkpoint?.role === "gu" ? checkpoint.text : "",
  checkpointMessage
);
assert.equal(
  checkpoint?.role === "gu"
    ? checkpoint.invocationChannels?.[0]?.channel
    : null,
  "telegram"
);

console.log("studio-authoring-flow.selftest: all checks passed");
