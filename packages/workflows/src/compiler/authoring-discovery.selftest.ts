import assert from "node:assert/strict";
import {
  answerBodyFromClarification,
  authoringDiscoveryOutputSchema,
  clipAuthoringText,
  filterCoveredClarifyingQuestionDetails,
  filterNovelClarifyingQuestions,
  isGenericAuthoringSlug,
  parseAuthoringDiscoveryOutput,
  sanitizeAuthoringDiscoveryRaw,
  splitAuthoringText,
  validateAuthoringDiscoveryEvidence,
} from "./authoring-discovery";
import { planAuthoringGaps } from "./authoring-gap-planner";

const description =
  "Cada vez que prepares un seguimiento para un propietario, resume el último acuerdo.";
const answers = [
  "El historial y el último acuerdo se consultan en BigQuery por el identificador del propietario.",
];

const discovery = authoringDiscoveryOutputSchema.parse({
  provisional_kind: "reusable_skill",
  final_kind: "reusable_skill",
  skill_subtype: "simple",
  confidence: "high",
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
    {
      key: "data_sources",
      status: "covered",
      summary: "BigQuery contiene el historial.",
      evidence: [
        {
          source: "answer",
          answer_index: 0,
          quote: "se consultan en BigQuery",
        },
      ],
    },
  ],
  material_ambiguities: [],
  clarifying_questions: [],
  assumptions: [],
  gaps: [],
  requested_side_effects: [],
  readiness: "ready_for_confirmation",
  suggested_title: "Seguimiento a propietarios",
  suggested_slug: "owner_followup_message",
  understanding: {
    objective: "Preparar un seguimiento basado en el último acuerdo.",
    sources: ["BigQuery"],
    actors: ["Operador", "Propietario"],
    decisions: [],
    effects: ["Preparar, no enviar"],
    capabilities: ["Consulta de historial"],
    acceptance_criteria: ["No inventar compromisos ni fechas"],
    assumptions: [],
    gaps: [],
  },
});
assert.deepEqual(discovery.input_requirements, []);
assert.deepEqual(discovery.invocation_channels, []);
assert.equal(discovery.gap_plan, undefined);

const discoveryWithPlan = authoringDiscoveryOutputSchema.parse({
  ...discovery,
  gaps: ["stale flat gap"],
  understanding: { ...discovery.understanding, gaps: ["stale flat gap"] },
  gap_plan: planAuthoringGaps([
    {
      key: "source",
      summary: "Falta fuente concreta",
      target_dimension: "data_sources",
      question: "¿Cuál es la fuente?",
      severity: "blocking",
    },
  ]),
});
assert.deepEqual(discoveryWithPlan.gaps, ["Falta fuente concreta"]);
assert.deepEqual(discoveryWithPlan.understanding.gaps, [
  "Falta fuente concreta",
]);

const semanticDiscovery = authoringDiscoveryOutputSchema.parse({
  ...discovery,
  input_requirements: [
    {
      kind: "runtime_input",
      key: "source_document",
      label: "Documento fuente",
      scope: "task_run",
      resolve_at: "run_start",
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
});
assert.equal(semanticDiscovery.input_requirements[0]?.kind, "runtime_input");
assert.equal(
  semanticDiscovery.input_requirements[0]?.source_hint,
  "chat_attachment"
);
assert.equal(semanticDiscovery.invocation_channels[0]?.channel, "web_chat");

const documentRouteDiscovery = authoringDiscoveryOutputSchema.parse({
  ...discovery,
  source_strategy: {
    kind: "operator_supplied_at_runtime",
    label: "Documento aportado para esta ejecución",
    source_ref: {
      type: "input_requirement",
      key: "source_document",
    },
    evidence: [
      {
        source: "answer",
        answer_index: 0,
        quote: "se consultan en BigQuery",
      },
    ],
  },
  data_sources: {
    document_source: {
      formats: [],
      evidence: [
        {
          source: "answer",
          answer_index: 0,
          quote: "se consultan en BigQuery",
        },
      ],
    },
    document_intake_route: {
      input_ref: {
        type: "input_requirement",
        key: "source_document",
      },
      invocation_channel: "web_chat",
      evidence: [
        {
          source: "answer",
          answer_index: 0,
          quote: "se consultan en BigQuery",
        },
      ],
    },
  },
  input_requirements: [
    {
      kind: "runtime_input",
      key: "source_document",
      datum_key: "agreement_source_document",
      label: "Documento fuente",
      scope: "turn",
      resolve_at: "run_start",
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
});
assert.equal(
  documentRouteDiscovery.data_sources.document_intake_route?.input_ref.key,
  "source_document"
);
assert.equal(
  authoringDiscoveryOutputSchema.safeParse({
    ...documentRouteDiscovery,
    invocation_channels: [
      {
        ...documentRouteDiscovery.invocation_channels[0],
        supports_generic_attachments: false,
      },
    ],
  }).success,
  false,
  "document intake requires an attachment-capable invocation channel"
);
assert.equal(
  authoringDiscoveryOutputSchema.parse({
    ...discovery,
    source_strategy: {
      kind: "unknown",
      label: "DOCX",
      source_ref: null,
      evidence: [],
    },
  }).data_sources.document_intake_route,
  null,
  "a document format alone must not imply an upload route"
);

assert.deepEqual(
  validateAuthoringDiscoveryEvidence({ discovery, description, answers }),
  []
);

const invalid = {
  ...discovery,
  covered_dimensions: discovery.covered_dimensions.map((dimension) =>
    dimension.key === "data_sources"
      ? {
          ...dimension,
          evidence: [
            {
              source: "answer" as const,
              answer_index: 0,
              quote: "Salesforce",
            },
          ],
        }
      : dimension
  ),
};
assert.ok(
  validateAuthoringDiscoveryEvidence({
    discovery: invalid,
    description,
    answers,
  }).some((failure) => failure.includes("data_sources"))
);

assert.equal(
  authoringDiscoveryOutputSchema.safeParse({
    ...discovery,
    readiness: "needs_clarification",
    clarifying_questions: [],
  }).success,
  false
);

assert.equal(
  authoringDiscoveryOutputSchema.safeParse({
    ...discovery,
    skill_subtype: undefined,
  }).success,
  false
);

assert.equal(
  answerBodyFromClarification("¿Fuente? → Está en un documento Word"),
  "Está en un documento Word"
);
assert.equal(isGenericAuthoringSlug("case_workflow"), true);
assert.equal(isGenericAuthoringSlug("owner_followup_message"), false);
assert.deepEqual(
  filterNovelClarifyingQuestions({
    questions: [
      "¿Qué resultado debe quedar listo y cómo sabremos que es correcto?",
      "¿De qué sistema o información debe obtener Gu los datos necesarios?",
      "¿Quién participa o debe tomar decisiones antes de enviar, guardar o publicar algo?",
    ],
    priorQuestions: [
      "¿Qué resultado debe quedar listo y cómo sabremos que es correcto?",
      "¿De qué sistema o información debe obtener Gu los datos necesarios?",
    ],
    priorAnswers: [
      "¿Quién participa o debe tomar decisiones antes de enviar, guardar o publicar algo? → el asesor inmobiliario",
    ],
  }),
  []
);
assert.deepEqual(
  filterNovelClarifyingQuestions({
    questions: ["¿Quién aprueba el envío del borrador?"],
    priorQuestions: [
      "¿Qué resultado debe quedar listo y cómo sabremos que es correcto?",
    ],
  }),
  ["¿Quién aprueba el envío del borrador?"]
);

assert.equal(
  authoringDiscoveryOutputSchema.safeParse({
    ...discovery,
    readiness: "needs_clarification",
    clarifying_questions: [
      "¿Fuente del acuerdo?",
      "¿Quién aprueba?",
      "¿Canal de envío?",
      "¿Qué hace correcto el borrador?",
    ],
  }).success,
  true
);
assert.equal(
  authoringDiscoveryOutputSchema.safeParse({
    ...discovery,
    readiness: "needs_clarification",
    clarifying_questions: ["q1", "q2", "q3", "q4", "q5"],
  }).success,
  false
);

const longGap = "x".repeat(700);
assert.equal(
  authoringDiscoveryOutputSchema.safeParse({
    ...discovery,
    gaps: [longGap],
    understanding: { ...discovery.understanding, gaps: [longGap] },
  }).success,
  false
);
const sanitized = sanitizeAuthoringDiscoveryRaw({
  ...discovery,
  gaps: [longGap],
  understanding: { ...discovery.understanding, gaps: [longGap] },
});
const recovered = parseAuthoringDiscoveryOutput(sanitized);
assert.ok(recovered);
assert.equal(recovered?.gaps.length, 2);
assert.equal(recovered?.gaps.join(""), longGap);
assert.ok(recovered?.gaps.every((gap) => gap.length <= 500));
const numericEvidenceIndex = parseAuthoringDiscoveryOutput(
  sanitizeAuthoringDiscoveryRaw({
    ...discovery,
    covered_dimensions: [
      {
        key: "data_sources",
        status: "covered",
        summary: "Documento aportado.",
        evidence: [
          {
            source: "answer",
            answer_index: "0",
            quote: "documento Word",
          },
        ],
      },
    ],
  })
);
assert.equal(
  numericEvidenceIndex?.covered_dimensions[0]?.evidence[0]?.answer_index,
  0
);
const prose =
  `${"Primera idea importante. ".repeat(18)}` +
  `${"Segunda idea relacionada y completa. ".repeat(18)}`;
const proseChunks = splitAuthoringText(prose, 500);
assert.ok(proseChunks.length > 1);
assert.ok(proseChunks.every((chunk) => chunk.length <= 500));
assert.equal(
  proseChunks.join(" ").replace(/\s+/g, " ").trim(),
  prose.replace(/\s+/g, " ").trim()
);
assert.equal(clipAuthoringText("abc", 10), "abc");
assert.equal(clipAuthoringText("abcdefghij", 5).endsWith("…"), true);

assert.deepEqual(
  filterCoveredClarifyingQuestionDetails({
    details: [
      {
        question: "¿De qué fuente sale el acuerdo?",
        target_dimension: "data_sources",
        gap: "Falta fuente.",
        examples: ["Word"],
      },
      {
        question: "¿Cómo sabremos que el resultado es correcto?",
        target_dimension: "acceptance_criteria",
        gap: "Falta criterio de éxito.",
        examples: ["email enviado"],
      },
    ],
    dimensions: [
      {
        key: "data_sources",
        status: "covered",
        summary: "Documento Word.",
        evidence: [],
      },
      {
        key: "acceptance_criteria",
        status: "partial",
        summary: "Falta cerrar el criterio.",
        evidence: [],
      },
    ],
  }).map((detail) => detail.target_dimension),
  ["acceptance_criteria"]
);

const providerStringified = parseAuthoringDiscoveryOutput({
  ...discovery,
  rationale: JSON.stringify(["Razón compacta"]),
  material_ambiguities: "[]",
  clarifying_questions: JSON.stringify(["¿Cuál es la fuente concreta?"]),
  clarifying_question_details: JSON.stringify([
    {
      question: "¿Cuál es la fuente concreta ?",
      target_dimension: "data_sources",
      gap: "Falta la fuente.",
      examples: JSON.stringify(["Word", "correo"]),
    },
  ]),
  assumptions: "[]",
  gaps: JSON.stringify(["Falta la fuente concreta."]),
  requested_side_effects: "[]",
  readiness: "needs_clarification",
});
assert.ok(providerStringified);
assert.deepEqual(providerStringified?.rationale, ["Razón compacta"]);
assert.equal(
  providerStringified?.clarifying_question_details[0]?.question,
  "¿Cuál es la fuente concreta?"
);
assert.deepEqual(
  providerStringified?.clarifying_question_details[0]?.examples,
  ["Word", "correo"]
);

console.log("authoring-discovery.selftest: all checks passed");
