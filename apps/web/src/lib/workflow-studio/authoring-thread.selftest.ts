import assert from "node:assert/strict";
import { planAuthoringGaps } from "@agents/workflows";
import {
  applyAuthoringRoundIntro,
  authoringClarificationRoundIncrement,
  authoringFailureOutcome,
  authoringHumanStatus,
  deriveStructuredExternalEffects,
  formatAuthoringTechnicalProgress,
  hydrateAuthoringThread,
  requiresFinalSendConfirmation,
  resolveActiveSlugConflict,
  reusableSkillConflictFromExisting,
  readStoredAuthoringRouterResult,
  RETRYABLE_DISCOVERY_COPY,
  selectAuthoringRetryCompactState,
  shouldShowAuthoringStatusBar,
  shouldAppendAuthoringInputMessage,
  shouldAutoScrollAuthoringThread,
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
    ? thread[3].invocationChannels?.[0]?.channel
    : null,
  "telegram"
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
assert.equal(
  applyAuthoringRoundIntro({
    phase: "checkpoint",
    conversation: { human_message: "Mensaje propio del checkpoint." },
    roundIntro: "Gracias, incorporé lo que aclaraste.",
  }).human_message,
  "Mensaje propio del checkpoint.",
  "el copy de ronda no sobrescribe el checkpoint"
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
  formatAuthoringTechnicalProgress({
    message: "Esperando tu respuesta.",
    stage: "done",
  }),
  "Esperando tu respuesta. · esperando_entrada"
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
assert.equal(
  shouldShowAuthoringStatusBar({
    inConversation: true,
    status: "Esperando confirmación humana.",
    phase: "proposal",
    pending: false,
    retryableFailure: false,
  }),
  false,
  "la propuesta idle no muestra una franja redundante entre hilo y revisión"
);
assert.equal(
  shouldShowAuthoringStatusBar({
    inConversation: true,
    status: "Gu está creando el borrador…",
    phase: "proposal",
    pending: true,
    retryableFailure: false,
  }),
  true,
  "la propuesta conserva feedback mientras hay una acción en curso"
);
assert.equal(
  authoringHumanStatus({
    phase: "blocked",
    pendingAction: "retry_discovery",
    failureClass: "provider_contract_retryable",
  }),
  "Gu está reintentando el análisis…"
);
assert.equal(
  authoringHumanStatus({
    phase: "blocked",
    failureClass: "internal_error",
  }),
  RETRYABLE_DISCOVERY_COPY
);
assert.deepEqual(authoringFailureOutcome("provider_contract_retryable"), {
  retryable: true,
  awaiting: "retry_discovery",
  humanCopy: RETRYABLE_DISCOVERY_COPY,
  hideHumanBlockers: true,
});
assert.deepEqual(authoringFailureOutcome("material_validation_failed"), {
  retryable: false,
  awaiting: "reformulate",
  humanCopy: null,
  hideHumanBlockers: false,
});

const retryableResume = hydrateAuthoringThread({
  description: "Preparar seguimiento",
  failureClass: "provider_contract_retryable",
  messages: [
    {
      role: "discovery_checkpoint",
      gap_plan: checkpointPlan,
      questions: ["¿Quién recibe el resultado?"],
      content: {
        objective: "Preparar seguimiento",
        sources: [],
        actors: [],
        decisions: [],
        effects: [],
        capabilities: [],
        acceptance_criteria: [],
        assumptions: [],
        gaps: ["Falta el destinatario"],
      },
    },
  ],
});
assert.equal(
  retryableResume[1]?.role === "gu"
    ? retryableResume[1].pendingBlockers?.length
    : -1,
  0
);
assert.doesNotMatch(
  retryableResume[1]?.role === "gu" ? retryableResume[1].text : "",
  /Queda 1 decisión/
);

const materialResume = hydrateAuthoringThread({
  description: "Preparar seguimiento",
  failureClass: "material_validation_failed",
  messages: [
    {
      role: "discovery_checkpoint",
      gap_plan: checkpointPlan,
      questions: ["¿Quién recibe el resultado?"],
      content: {
        objective: "Preparar seguimiento",
        sources: [],
        actors: [],
        decisions: [],
        effects: [],
        capabilities: [],
        acceptance_criteria: [],
        assumptions: [],
        gaps: ["Falta el destinatario"],
      },
    },
  ],
});
assert.equal(
  materialResume[1]?.role === "gu"
    ? materialResume[1].pendingBlockers?.length
    : -1,
  1
);
assert.match(
  materialResume[1]?.role === "gu" ? materialResume[1].text : "",
  /Queda 1 decisión/
);
assert.equal(shouldAppendAuthoringInputMessage("retry_discovery"), false);
assert.equal(shouldAppendAuthoringInputMessage("answer"), true);
assert.equal(
  authoringClarificationRoundIncrement({
    action: "retry_discovery",
    answerCount: 1,
  }),
  0
);
assert.equal(
  authoringClarificationRoundIncrement({ action: "answer", answerCount: 1 }),
  1
);
const currentCompact = { proposed_kind: "reusable_skill" } as never;
const lastValidCompact = { proposed_kind: "durable_task" } as never;
assert.equal(
  selectAuthoringRetryCompactState({
    lastValidCompact,
    currentCompact,
    failureClass: "provider_contract_retryable",
  }),
  lastValidCompact
);
assert.equal(
  selectAuthoringRetryCompactState({
    lastValidCompact: null,
    currentCompact,
    failureClass: "provider_contract_retryable",
  }),
  null,
  "a retryable failed compact must never become the next retry baseline"
);
assert.equal(
  selectAuthoringRetryCompactState({
    lastValidCompact: null,
    currentCompact,
    failureClass: null,
  }),
  currentCompact
);
assert.equal(workFormLabelFromKind("reusable_skill"), "Skill reusable");
assert.equal(workFormLabelFromKind("clarify"), null);
assert.deepEqual(
  readStoredAuthoringRouterResult({
    router: {
      kind: "reusable_skill",
      skill_subtype: "simple",
      confidence: "high",
      reasons: ["Procedimiento reusable."],
      clarifying_questions: [],
      requested_side_effects: [],
      modelId: "openai/gpt-5.4-mini",
      source: "model",
    },
  }),
  {
    kind: "reusable_skill",
    skill_subtype: "simple",
    confidence: "high",
    reasons: ["Procedimiento reusable."],
    clarifying_questions: [],
    requested_side_effects: [],
    modelId: "openai/gpt-5.4-mini",
    source: "model",
  }
);
assert.equal(readStoredAuthoringRouterResult({ router: { nope: true } }), null);

const persistedRoundUx = hydrateAuthoringThread({
  description: "Preparar un mensaje",
  messages: [
    {
      role: "discovery_question",
      human_message: "Primero necesito confirmar dos puntos:",
      questions: ["¿Cuál es la fuente?", "¿Quién recibe el mensaje?"],
      question_details: [
        {
          question: "¿Cuál es la fuente?",
          target_dimension: "data_sources",
          gap: "Falta la fuente",
          gap_id: "gap_aaaaaaaa",
          examples: [],
          display_number: 2,
        },
        {
          question: "¿Quién recibe el mensaje?",
          target_dimension: "actors",
          gap: "Falta el destinatario",
          gap_id: "gap_bbbbbbbb",
          examples: [],
          display_number: 7,
        },
      ],
    },
    {
      role: "discovery_question",
      human_message: "Gracias. Necesito precisar la fuente:",
      questions: ["¿En qué carpeta está la fuente?", "¿Qué tono usamos?"],
      question_details: [
        {
          question: "¿En qué carpeta está la fuente?",
          target_dimension: "data_sources",
          gap: "Falta ubicar la fuente",
          gap_id: "gap_aaaaaaaa",
          examples: [],
          display_number: 2,
        },
        {
          question: "¿Qué tono usamos?",
          target_dimension: "acceptance_criteria",
          gap: "Falta el tono",
          gap_id: "gap_cccccccc",
          examples: [],
          display_number: 9,
        },
      ],
    },
  ],
});
assert.equal(
  persistedRoundUx[1]?.role === "gu" ? persistedRoundUx[1].text : "",
  "Primero necesito confirmar dos puntos:"
);
assert.deepEqual(
  persistedRoundUx[1]?.role === "gu"
    ? persistedRoundUx[1].questionPresentations?.map(
        (question) => question.displayNumber
      )
    : [],
  [2, 7]
);
assert.deepEqual(
  persistedRoundUx[2]?.role === "gu"
    ? persistedRoundUx[2].questionPresentations?.map(
        (question) => question.displayNumber
      )
    : [],
  [2, 9]
);

const legacyRoundUx = hydrateAuthoringThread({
  description: "Preparar un mensaje",
  messages: [
    {
      role: "discovery_question",
      questions: ["¿Cuál es la fuente?", "¿Quién recibe el mensaje?"],
    },
    {
      role: "discovery_question",
      questions: ["¿Quién recibe el mensaje?", "¿Qué tono usamos?"],
    },
  ],
});
assert.equal(
  legacyRoundUx[1]?.role === "gu" ? legacyRoundUx[1].text : "",
  "Para preparar un borrador seguro, necesito aclarar:"
);
assert.deepEqual(
  legacyRoundUx[1]?.role === "gu"
    ? legacyRoundUx[1].questionPresentations?.map(
        (question) => question.displayNumber
      )
    : [],
  [1, 2]
);
assert.deepEqual(
  legacyRoundUx[2]?.role === "gu"
    ? legacyRoundUx[2].questionPresentations?.map(
        (question) => question.displayNumber
      )
    : [],
  [2, 3]
);

const conflict = {
  slug: "owner-followup-message",
  status: "draft",
  version: 1,
  updatedAt: "2026-08-07T22:29:06.458Z",
};
assert.equal(
  resolveActiveSlugConflict({
    slugConflict: conflict,
    effectiveSlug: "owner_followup_message",
  })?.slug,
  conflict.slug
);
assert.equal(
  resolveActiveSlugConflict({
    slugConflict: conflict,
    effectiveSlug: "another_skill",
  }),
  null
);
assert.equal(
  reusableSkillConflictFromExisting({
    finalKind: "reusable_skill",
    normalizedSlug: conflict.slug,
    currentSessionId: "session-new",
    existing: {
      studioAuthoringSessionId: "session-old",
      status: conflict.status,
      version: conflict.version,
      updatedAt: conflict.updatedAt,
    },
  })?.slug,
  conflict.slug
);
assert.equal(
  reusableSkillConflictFromExisting({
    finalKind: "reusable_skill",
    normalizedSlug: conflict.slug,
    currentSessionId: "session-same",
    existing: {
      studioAuthoringSessionId: "session-same",
      status: conflict.status,
      version: conflict.version,
      updatedAt: conflict.updatedAt,
    },
  }),
  null
);

assert.equal(
  requiresFinalSendConfirmation({
    outboundContract: {
      delivery: { mode: "after_approval", evidence: [] },
    },
  }),
  true
);
assert.equal(
  requiresFinalSendConfirmation({
    capabilityNeeds: [
      {
        category_id: "user_email",
        category_label: "Correo",
        provider_id: "gmail",
        provider_name: "Gmail",
        status: "connected",
        resolution: "assumed_connected",
        capabilities: ["send"],
        connect_href: null,
      },
    ],
  }),
  true
);
assert.equal(requiresFinalSendConfirmation({}), false);

const structuredEffects = deriveStructuredExternalEffects({
  requestedSideEffects: ["send_message", "human_approval"],
  outboundContract: {
    delivery: { mode: "after_approval", evidence: [] },
  },
  capabilityNeeds: [
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
});
assert.equal(structuredEffects.length, 1);
assert.match(structuredEffects[0]?.copy ?? "", /después de tu aprobación/i);
assert.doesNotMatch(structuredEffects[0]?.copy ?? "", /borrador/i);
assert.deepEqual(
  deriveStructuredExternalEffects({ requestedSideEffects: [] }),
  []
);

assert.equal(
  shouldAutoScrollAuthoringThread(1, [
    { role: "user" },
    { role: "gu" },
  ]),
  true
);
assert.equal(
  shouldAutoScrollAuthoringThread(1, [
    { role: "user" },
    { role: "user" },
  ]),
  false
);
assert.equal(
  shouldAutoScrollAuthoringThread(2, [
    { role: "user" },
    { role: "gu" },
  ]),
  false
);

console.log("authoring-thread.selftest: all checks passed");
