import assert from "node:assert/strict";
import {
  AUTHORING_DISCOVERY_DIMENSIONS,
  authoringDiscoveryOutputSchema,
  buildAuthoringDiscoveryCompactState,
  classifyAuthoringIntentDeterministic,
  createAuthoringGapId,
} from "@agents/workflows";
import {
  duplicateGapContradictionWarnings,
  runAuthoringDiscovery,
  setAuthoringDiscoveryFetchForTests,
} from "./authoring-discovery";
import { mergeConservativeProposalRevision } from "./authoring-discovery-revision";
import { buildAuthoringCapabilityContext } from "./capability-provider-catalog";

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
  gap_candidates: [
    {
      key: "agreement-source",
      summary: "Falta la fuente concreta del último acuerdo.",
      target_dimension: "data_sources",
      question: "¿Dónde está registrado el último acuerdo?",
      severity: "blocking",
      depends_on: [],
      priority: 100,
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

function withoutKey<
  T extends Record<string, unknown>,
  K extends keyof T,
>(value: T, key: K): Omit<T, K> {
  const output: Record<string, unknown> = { ...value };
  delete output[String(key)];
  return output as Omit<T, K>;
}

async function repairOnce(): Promise<void> {
  const prompts: string[] = [];
  const responses = [
    {
      ...validDiscovery,
      provisional_kind: "not_a_kind",
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
  assert.equal(
    result.kind,
    "ok",
    result.kind === "fail_closed" ? result.reason : "expected repaired discovery"
  );
  assert.equal(prompts.length, 2);
  assert.match(
    prompts[0] ?? "",
    /desde Telegram[\s\S]*aprobar por Telegram[\s\S]*enviar\/notificar por Telegram/i
  );
  assert.match(
    prompts[0] ?? "",
    /mece_overlap[\s\S]*never claim overlap[\s\S]*unless the tenant catalog names a concrete candidate/i
  );
  assert.match(
    prompts[0] ?? "",
    /document supplied as source or evidence[\s\S]*Do not infer[\s\S]*email body[\s\S]*outbound attachment/i
  );
  assert.match(prompts[1] ?? "", /Repair a Gu OS Studio/);
  assert.match(prompts[1] ?? "", /response_format json_object/);
  assert.match(prompts[1] ?? "", /top-level JSON object/);
  assert.doesNotMatch(prompts[1] ?? "", /call submit_authoring_discovery/i);
  assert.equal(result.diagnostics.callCount, 2);
  assert.deepEqual(
    result.diagnostics.stages.map((stage) => stage.code),
    ["discovery_schema_invalid", "accepted"]
  );
}

function withConcreteRecipientCandidate(
  candidate: typeof validDiscovery
): typeof validDiscovery & Record<string, unknown> {
  return {
    ...candidate,
    input_requirements: [
      {
        kind: "runtime_input",
        key: "recipient_address",
        label: "Dirección del destinatario",
        required: true,
        scope: "turn",
        resolve_at: "run_start",
        source_hint: "conversation_input",
        retention: "run",
      },
    ],
    outbound_contract: {
      recipient_strategy: {
        kind: "operator_supplied_at_runtime",
        address_type: "other",
        label: "Dirección del destinatario",
        source_ref: {
          type: "input_requirement",
          key: "recipient_address",
        },
        evidence: [{ source: "description", quote: description }],
      },
      approval: { approver: null, scope: [], evidence: [] },
      delivery: { mode: "unknown", evidence: [] },
    },
  };
}

async function reviewsRepairAndSalvageCandidates(): Promise<void> {
  const concrete = withConcreteRecipientCandidate(validDiscovery);
  const repairResponses: unknown[] = [
    { ...concrete, provisional_kind: "not_a_kind" },
    concrete,
  ];
  const repaired = await runAuthoringDiscovery({
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
      async discover() {
        return repairResponses.shift();
      },
    },
    recipientProvenanceModel: {
      async verify() {
        return {
          verdict: "entailed",
          reason: "Fixture de integración.",
          evidence_quote: description,
        };
      },
    },
  });
  assert.equal(repaired.kind, "ok");
  assert.equal(repaired.diagnostics.recipientReviewCallCount, 1);
  assert.equal(repaired.diagnostics.recipientReviews[0]?.sourceStage, "repair");

  const salvageCandidate = withoutKey(concrete, "gap_candidates");
  const salvageResponses: unknown[] = [salvageCandidate, {}];
  const salvaged = await runAuthoringDiscovery({
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
      async discover() {
        return salvageResponses.shift();
      },
    },
    recipientProvenanceModel: {
      async verify() {
        return {
          verdict: "entailed",
          reason: "Fixture de integración.",
          evidence_quote: description,
        };
      },
    },
  });
  assert.equal(salvaged.kind, "ok");
  assert.ok(
    salvaged.diagnostics.stages.some(
      (stage) => stage.stage === "salvage" && stage.code === "accepted_initial"
    )
  );
  assert.equal(salvaged.diagnostics.recipientReviewCallCount, 1);
  assert.equal(
    salvaged.diagnostics.recipientReviews[0]?.sourceStage,
    "salvage"
  );
}

async function downgradesUnsupportedEvidenceWithoutRepair(): Promise<void> {
  let calls = 0;
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
      async discover() {
        calls += 1;
        return {
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
        };
      },
    },
  });
  assert.equal(result.kind, "ok");
  assert.equal(calls, 1);
  assert.equal(
    result.discovery.covered_dimensions[0]?.status,
    "partial",
    "unsupported covered claims must be downgraded"
  );
  assert.deepEqual(result.discovery.covered_dimensions[0]?.evidence, []);
  assert.ok(
    result.qualityWarnings.some(
      (warning) => warning.code === "discovery_evidence_downgraded"
    )
  );
}

async function acceptsNestedJsonStringTransport(): Promise<void> {
  let calls = 0;
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
      async discover() {
        calls += 1;
        return JSON.stringify(JSON.stringify(validDiscovery));
      },
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.kind, "ok");
  assert.deepEqual(result.diagnostics.responseShape, {
    transport: "string",
    parsed: "object",
  });
}

async function derivesConservativeFirstTurnGapsAfterFailedRepair(): Promise<void> {
  const withoutGapCandidates = withoutKey(validDiscovery, "gap_candidates");
  let calls = 0;
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
      async discover() {
        calls += 1;
        return calls === 1 ? withoutGapCandidates : "malformed repair";
      },
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.kind, "ok");
  assert.equal(result.discovery.gap_plan?.counts.blockers, 1);
  assert.deepEqual(result.discovery.clarifying_questions, [
    "¿Dónde está registrado el último acuerdo?",
  ]);
  assert.deepEqual(
    result.diagnostics.stages.map((stage) => [
      stage.stage,
      stage.code,
      stage.responseShape?.parsed,
    ]),
    [
      ["initial", "gap_candidates_missing_or_invalid", "object"],
      ["repair", "gap_candidates_missing_or_invalid", "string"],
      ["salvage", "accepted_initial", "object"],
    ]
  );
}

async function derivesConservativeGapFromUncoveredDimension(): Promise<void> {
  const initial = withoutKey(
    {
      ...validDiscovery,
      covered_dimensions: [
        ...validDiscovery.covered_dimensions,
        {
          key: "data_sources",
          status: "missing",
          summary: "Falta definir la fuente del último acuerdo.",
          evidence: [],
        },
      ],
      clarifying_questions: [],
      clarifying_question_details: [],
    },
    "gap_candidates"
  );
  const repair = withoutKey(initial, "understanding");
  let calls = 0;
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
      async discover() {
        calls += 1;
        return calls === 1 ? initial : repair;
      },
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.kind, "ok");
  assert.deepEqual(result.discovery.clarifying_questions, [
    "¿Dónde encontrará Gu la información que necesita y cómo la recibirá en cada uso?",
  ]);
  assert.equal(
    result.discovery.clarifying_question_details[0]?.target_dimension,
    "data_sources"
  );
  assert.ok(
    (result.discovery.clarifying_question_details[0]?.examples.length ?? 0) > 0,
    "abstract fallback questions include contextual examples"
  );
  assert.ok(
    result.qualityWarnings.some(
      (warning) =>
        warning.code === "gap_candidates_derived_conservatively" &&
        warning.stage === "salvage"
    )
  );
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
  assert.equal(result.discovery.gap_plan?.can_proceed, false);
  assert.equal(result.failureClass, "provider_contract_retryable");
  assert.equal(result.diagnostics.callCount, 2);
  assert.deepEqual(
    result.diagnostics.stages.map((stage) => stage.code),
    [
      "gap_candidates_missing_or_invalid",
      "gap_candidates_missing_or_invalid",
      "gap_candidates_missing_or_invalid",
    ]
  );
  assert.doesNotMatch(JSON.stringify(result.diagnostics), /invalid.*true/i);
}

async function preservesPriorPlanWhenRepairOmitsGapCandidates(): Promise<void> {
  const first = await runAuthoringDiscovery({
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
      async discover() {
        return validDiscovery;
      },
    },
  });
  assert.equal(first.kind, "ok");
  if (first.kind !== "ok") return;

  const compactState = buildAuthoringDiscoveryCompactState({
    discovery: first.discovery,
    priorQuestions: first.discovery.clarifying_questions,
    answerTurnCount: 1,
  });
  const withoutGapCandidates = withoutKey(validDiscovery, "gap_candidates");
  const incompleteRepair = withoutKey(
    withoutGapCandidates,
    "understanding"
  );
  let calls = 0;
  const recovered = await runAuthoringDiscovery({
    description,
    answers: ["Quiero aclarar primero otro aspecto."],
    latestAnswer: "Quiero aclarar primero otro aspecto.",
    priorQuestions: first.discovery.clarifying_questions,
    compactState,
    enforcePriorGapDispositions: true,
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
        return calls === 1 ? "truncated provider response" : incompleteRepair;
      },
    },
  });
  assert.equal(calls, 2, "missing candidates must receive one repair attempt");
  assert.equal(
    recovered.kind,
    "ok",
    recovered.kind === "fail_closed" ? recovered.reason : "recovered"
  );
  if (recovered.kind !== "ok") return;
  assert.deepEqual(recovered.discovery.clarifying_questions, [
    "¿Dónde está registrado el último acuerdo?",
  ]);
  assert.deepEqual(
    recovered.discovery.clarifying_question_details[0]?.examples,
    ["documento Word", "correo", "notas del caso"]
  );
}

function gapCandidate(
  key: string,
  targetDimension: string,
  priority: number,
  overrides: Record<string, unknown> = {}
) {
  return {
    key,
    summary: `Falta ${key}`,
    target_dimension: targetDimension,
    question: `¿Puedes aclarar ${key}?`,
    severity: "blocking",
    depends_on: [],
    priority,
    examples: [],
    ...overrides,
  };
}

async function preservesCompleteExamplesAndAtomicGapIds(): Promise<void> {
  const multiPartExamples = [
    "El asesor es responsable de aprobar",
    "Debe revisar el borrador completo en el chat",
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
      async discover() {
        return {
          ...validDiscovery,
          clarifying_questions: [],
          clarifying_question_details: [],
          gap_candidates: [
            gapCandidate("approval-policy", "human_decisions", 100, {
              question:
                "¿Quién aprueba el envío y qué evidencia debe ver antes de decidir?",
              examples: multiPartExamples,
            }),
            gapCandidate("source", "data_sources", 90, {
              examples: ["documento Word", "texto pegado", "correo previo"],
            }),
          ],
        };
      },
    },
  });
  assert.equal(result.kind, "ok");
  assert.equal(result.discovery.clarifying_question_details.length, 2);
  const approval = result.discovery.clarifying_question_details.find((detail) =>
    /quién aprueba/i.test(detail.question)
  );
  assert.ok(approval?.gap_id);
  assert.deepEqual(approval?.examples, multiPartExamples);
  assert.ok(
    /asesor|responsable/i.test(approval?.examples.join(" ") ?? "") &&
      /borrador|chat/i.test(approval?.examples.join(" ") ?? ""),
    "examples may collectively cover actor and evidence slots"
  );
  assert.ok(
    result.discovery.clarifying_question_details.every(
      (detail) =>
        Boolean(detail.gap_id) &&
        detail.examples.length > 0 &&
        detail.examples.length <= 3
    )
  );
}

async function acceptsIncompleteMultiPartExamplesWithWarning(): Promise<void> {
  let calls = 0;
  const repairWithoutGapCandidates = withoutKey(
    validDiscovery,
    "gap_candidates"
  );
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
      async discover() {
        calls += 1;
        return calls === 1
          ? {
              ...validDiscovery,
              clarifying_questions: [],
              clarifying_question_details: [],
              gap_candidates: [
                gapCandidate(
                  "approval-evidence",
                  "human_decisions",
                  100,
                  {
                    question:
                      "¿Quién aprueba el envío y qué evidencia debe ver antes de decidir?",
                    examples: ["Destinatario, asunto y cuerpo completo"],
                  }
                ),
              ],
            }
          : repairWithoutGapCandidates;
      },
    },
  });
  assert.equal(calls, 1, "example quality warnings must not trigger repair");
  assert.equal(result.kind, "ok");
  assert.deepEqual(
    result.discovery.clarifying_question_details[0]?.examples,
    [
      "Destinatario, asunto y cuerpo completo",
      "el asesor responsable; revisar el documento fuente y el borrador completo",
    ]
  );
  assert.deepEqual(result.discovery.clarifying_questions, [
    "¿Quién aprueba el envío y qué evidencia debe ver antes de decidir?",
  ]);
  assert.deepEqual(result.qualityWarnings, [
    {
      code: "gap_candidate_examples_incomplete_actor_evidence",
      path: "gap_candidates.0.examples",
      stage: "initial",
    },
  ]);
  assert.equal(result.failureClass, null);
  assert.equal(result.diagnostics.callCount, 1);
}

async function salvagesValidCandidatesFromPresentInvalidArray(): Promise<void> {
  let calls = 0;
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
      async discover() {
        calls += 1;
        return {
          ...validDiscovery,
          clarifying_questions: [],
          clarifying_question_details: [],
          gap_candidates: [
            gapCandidate("source", "data_sources", 100),
            {
              key: "broken",
              target_dimension: "actors",
              examples: [],
            },
          ],
        };
      },
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.kind, "ok");
  assert.deepEqual(result.discovery.clarifying_questions, [
    "¿Puedes aclarar source?",
  ]);
  assert.deepEqual(result.qualityWarnings, [
    {
      code: "gap_candidate_invalid_dropped",
      path: "gap_candidates.1",
      stage: "initial",
    },
  ]);
}

async function overridesModelChannelToolInputMixing(): Promise<void> {
  const capabilityContext = buildAuthoringCapabilityContext({
    snapshot: {
      oauthIntegrations: [{ provider: "gmail", status: "active" }],
      accountSecretsByProvider: new Map(),
      telegramLinked: true,
    },
  });
  const result = await runAuthoringDiscovery({
    description,
    routerSignal: routerSignal!,
    catalogs: {
      skills: [],
      tools: ["gmail_send_email", "telegram_send_message_to_contact"],
      integrations: [],
      assets: [],
      workerCapabilities: [],
    },
    capabilityContext,
    model: {
      async discover() {
        return {
          ...validDiscovery,
          readiness: "ready_for_confirmation",
          clarifying_questions: [],
          clarifying_question_details: [],
          gap_candidates: [],
          material_ambiguities: [],
          gaps: [],
          understanding: {
            ...validDiscovery.understanding,
            gaps: [],
            sources: ["Documento Word"],
            decisions: ["Aprobación del asesor"],
            effects: ["Enviar email"],
          },
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
          // Model wrongly mixes surfaces; deterministic overlay must win.
          capability_needs: [
            {
              category_id: "user_email",
              category_label: "Correo de usuario",
              provider_id: "telegram_bot",
              provider_name: "Telegram",
              status: "connected",
              resolution: "assumed_connected",
              capabilities: ["send"],
              connect_href: null,
            },
            {
              category_id: "invented_provider_category",
              category_label: "Categoría inventada",
              provider_id: "invented",
              provider_name: "Inventada",
              status: "connected",
              resolution: "assumed_connected",
              capabilities: ["send"],
              connect_href: null,
            },
          ],
          input_requirements: [
            {
              kind: "tool",
              key: "gmail_send_email",
              label: "Gmail",
            },
            {
              kind: "runtime_input",
              key: "source_document",
              label: "Documento fuente",
              source_hint: "chat_attachment",
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
        };
      },
    },
  });
  assert.equal(result.kind, "ok");
  assert.ok(
    result.discovery.capability_needs.some(
      (need) => need.provider_id === "gmail"
    )
  );
  assert.ok(
    result.discovery.capability_needs.every(
      (need) => need.provider_id !== "telegram_bot"
    ),
    "Telegram invocation must not become an outbound tool"
  );
  assert.ok(
    result.discovery.input_requirements.some(
      (requirement) =>
        requirement.kind === "runtime_input" &&
        requirement.source_hint === "chat_attachment"
    )
  );
  assert.ok(
    result.discovery.input_requirements.every(
      (requirement) =>
        requirement.kind !== "tool" &&
        requirement.kind !== "integration" &&
        !/gmail/i.test(requirement.key)
    ),
    "runtime_input stays separate from tools/providers"
  );
  assert.deepEqual(
    result.discovery.invocation_channels.map((channel) => channel.channel),
    ["web_chat", "telegram"]
  );
  assert.equal(
    result.discovery.invocation_channels.find(
      (channel) => channel.channel === "telegram"
    )?.supports_generic_attachments,
    true,
    "Telegram uses the same generic attachment pipeline as Web Chat"
  );
  assert.match(
    result.discovery.invocation_channels
      .find((channel) => channel.channel === "telegram")
      ?.limitations.join(" ") ?? "",
    /\.xls.*\.xlsx/i,
    "Telegram must disclose the legacy .xls exception"
  );
}

async function enforcesDocumentIntakeMeceContract(): Promise<void> {
  const answer =
    "El acuerdo estará en un documento que subirá el usuario en el chat en cada ejecución.";
  const capabilityContext = buildAuthoringCapabilityContext({
    snapshot: {
      oauthIntegrations: [],
      accountSecretsByProvider: new Map(),
      telegramLinked: false,
    },
  });
  const result = await runAuthoringDiscovery({
    description,
    answers: [answer],
    latestAnswer: answer,
    routerSignal: routerSignal!,
    capabilityContext,
    catalogs: {
      skills: [],
      tools: [],
      integrations: [],
      assets: [],
      workerCapabilities: [],
    },
    model: {
      async discover() {
        return {
          ...validDiscovery,
          covered_dimensions: validDiscovery.covered_dimensions.map(
            (dimension) =>
              dimension.key === "data_sources"
                ? {
                    ...dimension,
                    status: "covered",
                    summary: "Documento aportado por ejecución.",
                    evidence: [
                      {
                        source: "answer",
                        answer_index: 0,
                        quote: answer,
                      },
                    ],
                  }
                : dimension
          ),
          source_strategy: {
            kind: "operator_supplied_at_runtime",
            label: "Documento aportado por ejecución",
            source_ref: {
              type: "input_requirement",
              key: "source_document",
            },
            evidence: [
              {
                source: "answer",
                answer_index: 0,
                quote: answer,
              },
            ],
          },
          data_sources: {
            document_source: {
              formats: ["docx"],
              evidence: [
                {
                  source: "answer",
                  answer_index: 0,
                  quote: answer,
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
                  quote: answer,
                },
              ],
            },
          },
          input_requirements: [
            {
              kind: "case_fact",
              key: "agreement_copy",
              datum_key: "agreement_source_document",
              label: "Copia del acuerdo",
              scope: "case",
            },
            {
              kind: "runtime_input",
              key: "source_document",
              datum_key: "agreement_source_document",
              label: "Documento fuente",
              required: true,
              scope: "turn",
              resolve_at: "run_start",
              source_hint: "chat_attachment",
              retention: "run",
            },
          ],
          invocation_channels: capabilityContext.invocationChannels,
          gap_candidates: [],
          clarifying_questions: [],
          clarifying_question_details: [],
          gaps: [],
        };
      },
    },
  });
  assert.equal(result.kind, "ok");
  const documentInputs = result.discovery.input_requirements.filter(
    (requirement) =>
      requirement.datum_key === "agreement_source_document"
  );
  assert.equal(
    documentInputs.length,
    1,
    "one canonical datum must not become both runtime input and case fact"
  );
  assert.equal(documentInputs[0]?.kind, "runtime_input");
  assert.equal(documentInputs[0]?.source_hint, "chat_attachment");
  assert.equal(
    result.discovery.data_sources.document_intake_route?.input_ref.key,
    documentInputs[0]?.key
  );
  assert.equal(
    result.discovery.data_sources.document_intake_route?.invocation_channel,
    "web_chat"
  );

  const formatOnlyAnswer =
    "El acuerdo estará en un documento que usualmente será Word (DOCX), aunque también podría ser TXT.";
  const missingRoute = await runAuthoringDiscovery({
    description,
    answers: [formatOnlyAnswer],
    latestAnswer: formatOnlyAnswer,
    routerSignal: routerSignal!,
    capabilityContext,
    catalogs: {
      skills: [],
      tools: [],
      integrations: [],
      assets: [],
      workerCapabilities: [],
    },
    model: {
      async discover() {
        return {
          ...validDiscovery,
          covered_dimensions: validDiscovery.covered_dimensions.map(
            (dimension) =>
              dimension.key === "data_sources"
                ? {
                    ...dimension,
                    status: "covered",
                    summary: "Se requiere un documento DOCX o TXT.",
                    evidence: [
                      {
                        source: "answer",
                        answer_index: 0,
                        quote: formatOnlyAnswer,
                      },
                    ],
                  }
                : dimension
          ),
          data_sources: {
            document_source: {
              formats: ["DOCX", "TXT"],
              evidence: [
                {
                  source: "answer",
                  answer_index: 0,
                  quote: formatOnlyAnswer,
                },
              ],
            },
            document_intake_route: null,
          },
          input_requirements: [
            {
              kind: "runtime_input",
              key: "agreement_document",
              datum_key: "agreement_source_document",
              label: "Documento con el último acuerdo",
              scope: "turn",
              resolve_at: "run_start",
              retention: "run",
            },
          ],
          invocation_channels: capabilityContext.invocationChannels,
          gap_candidates: [],
          clarifying_questions: [],
          clarifying_question_details: [],
          gaps: [],
          readiness: "ready_for_confirmation",
        };
      },
    },
  });
  assert.equal(missingRoute.kind, "ok");
  assert.ok(
    missingRoute.discovery.gap_plan?.gaps.some(
      (gap) =>
        gap.key === "data_sources.document_intake_route" &&
        gap.resolution_status !== "resolved"
    ),
    "a document format must not silently stand in for its per-run intake route"
  );
  assert.equal(
    missingRoute.discovery.readiness,
    "needs_clarification",
    "an unresolved document route must block confirmation"
  );
}

async function reconcilesDeterministicQueue(): Promise<void> {
  const initialCandidates = [
    gapCandidate("source", "data_sources", 100),
    gapCandidate("actor", "actors", 90),
    gapCandidate("decision", "human_decisions", 80),
    gapCandidate("success", "acceptance_criteria", 70),
    gapCandidate("criteria", "acceptance_criteria", 60, {
      depends_on: ["source"],
    }),
    gapCandidate("recurrence", "recurrence", 0, {
      severity: "optional",
    }),
  ];
  const first = await runAuthoringDiscovery({
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
      async discover() {
        return {
          ...validDiscovery,
          clarifying_questions: [],
          clarifying_question_details: [],
          gap_candidates: initialCandidates,
        };
      },
    },
  });
  assert.equal(first.kind, "ok");
  assert.equal(first.discovery.clarifying_questions.length, 4);
  assert.equal(first.discovery.gap_plan?.counts.total, 6);
  assert.ok(
    first.discovery.clarifying_question_details.every(
      (detail) => Boolean(detail.gap_id) && Array.isArray(detail.examples)
    )
  );
  const sourceId = createAuthoringGapId({
    key: "source",
    summary: "Falta source",
    target_dimension: "data_sources",
  });
  const criteriaId = createAuthoringGapId({
    key: "criteria",
    summary: "Falta criteria",
    target_dimension: "acceptance_criteria",
  });
  assert.equal(
    first.discovery.gap_plan?.gaps.find((gap) => gap.id === criteriaId)?.state,
    "blocked_dependency"
  );

  const priorQuestions = first.discovery.clarifying_questions;
  const compactState = buildAuthoringDiscoveryCompactState({
    discovery: first.discovery,
    priorQuestions,
    answerTurnCount: 0,
  });
  const answer = "El último acuerdo está en un documento Word.";
  let secondPrompt = "";
  const second = await runAuthoringDiscovery({
    description,
    answers: [answer],
    latestAnswer: answer,
    priorQuestions,
    compactState,
    enforcePriorGapDispositions: true,
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
        secondPrompt = prompt;
        return {
          ...validDiscovery,
          covered_dimensions: [
            {
              key: "data_sources",
              status: "covered",
              summary: "El acuerdo llega en Word.",
              evidence: [
                {
                  source: "answer",
                  answer_index: 0,
                  quote: "documento Word",
                },
              ],
            },
          ],
          clarifying_questions: [],
          clarifying_question_details: [],
          gap_candidates: [],
          source_strategy: {
            kind: "operator_supplied_at_runtime",
            label: "Documento Word aportado en cada uso",
            evidence: [
              {
                source: "answer",
                answer_index: 0,
                quote: "documento Word",
              },
            ],
          },
          prior_gap_dispositions: compactState.gap_plan!.gaps.map((gap) =>
            gap.id === sourceId
              ? {
                  gap_id: gap.id,
                  status: "resolved",
                  evidence: ["documento Word"],
                }
              : {
                  gap_id: gap.id,
                  status: gap.state === "asked" ? "unanswered" : "open",
                  evidence: [],
                }
          ),
        };
      },
    },
  });
  assert.equal(second.kind, "ok");
  assert.match(secondPrompt, /<<<compact_discovery_state>>>/);
  assert.match(secondPrompt, /<<<verbatim_operator_answer_turns>>>/);
  assert.match(secondPrompt, /El último acuerdo está en un documento Word\./);
  assert.match(secondPrompt, /<<<prior_questions_verbatim>>>/);
  assert.match(secondPrompt, /<<<latest_operator_answer>>>/);
  assert.equal(
    second.discovery.gap_plan?.gaps.find((gap) => gap.id === sourceId)?.state,
    "answered"
  );
  assert.equal(
    second.discovery.gap_plan?.gaps.find((gap) => gap.id === sourceId)
      ?.resolution_status,
    "resolved"
  );
  assert.ok(
    !second.discovery.clarifying_questions.includes(
      initialCandidates[0]!.question!
    ),
    "a provider-reemitted gap resolved by answer evidence must not repeat"
  );
  assert.equal(
    second.discovery.gap_plan?.gaps.find((gap) => gap.id === criteriaId)?.state,
    "asked"
  );
  assert.ok(
    second.discovery.gap_plan?.gaps.some(
      (gap) => gap.summary === "Falta recurrence"
    ),
    "an omitted old unasked gap must be retained"
  );
  assert.equal(
    second.discovery.clarifying_questions.length,
    4,
    "asked gaps not answered by evidence must re-enter the bounded queue"
  );
}

async function coercesEmptyClarificationToReadyWhenPlanCanProceed(): Promise<void> {
  const sourceId = createAuthoringGapId({
    key: "source",
    summary: "Falta source",
    target_dimension: "data_sources",
  });
  const compactState = buildAuthoringDiscoveryCompactState({
    discovery: {
      ...validDiscovery,
      readiness: "ready_for_confirmation",
      clarifying_questions: [],
      clarifying_question_details: [],
      gaps: [],
      gap_plan: {
        version: 2,
        gaps: [
          {
            id: sourceId,
            key: "source",
            summary: "Falta source",
            target_dimension: "data_sources",
            question: "¿Fuente?",
            severity: "blocking",
            depends_on: [],
            priority: 100,
            examples: [],
            state: "answered",
            resolution_status: "resolved",
            age: 1,
            evidence: ["documento Word"],
            resolution: "documento Word",
          },
        ],
        counts: {
          total: 1,
          unresolved: 0,
          blockers: 0,
          defaultable: 0,
          optional: 0,
          askable: 0,
        },
        can_proceed: true,
      },
    } as never,
    priorQuestions: ["¿Fuente?"],
    answerTurnCount: 1,
  });
  const result = await runAuthoringDiscovery({
    description,
    answers: ["El acuerdo está en un documento Word."],
    latestAnswer: "El acuerdo está en un documento Word.",
    priorQuestions: ["¿Fuente?"],
    compactState,
    enforcePriorGapDispositions: true,
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
        return {
          ...validDiscovery,
          readiness: "needs_clarification",
          clarifying_questions: [],
          clarifying_question_details: [],
          gap_candidates: [],
          source_strategy: {
            kind: "operator_supplied_at_runtime",
            label: "Documento Word",
            evidence: [
              {
                source: "answer",
                answer_index: 0,
                quote: "documento Word",
              },
            ],
          },
          prior_gap_dispositions: [
            {
              gap_id: sourceId,
              status: "resolved",
              evidence: ["documento Word"],
            },
          ],
          covered_dimensions: AUTHORING_DISCOVERY_DIMENSIONS.map((key) => ({
            key,
            status: key === "data_sources" ? "covered" : "not_applicable",
            summary:
              key === "data_sources"
                ? "Fuente cubierta."
                : "No aplica en este turno.",
            evidence:
              key === "data_sources"
                ? [
                    {
                      source: "answer",
                      answer_index: 0,
                      quote: "documento Word",
                    },
                  ]
                : [],
          })),
        };
      },
    },
  });
  assert.equal(result.kind, "ok", result.kind === "fail_closed" ? result.reason : "");
  assert.equal(result.discovery.readiness, "ready_for_confirmation");
  assert.equal(result.discovery.clarifying_questions.length, 0);
}

async function retriesRetryableTransportWithoutSpendingCompletionSlot(): Promise<void> {
  const priorKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-key";
  let requests = 0;
  setAuthoringDiscoveryFetchForTests(async () => {
    requests += 1;
    if (requests === 1) {
      return new Response("rate limited", {
        status: 429,
        headers: { "Retry-After": "0" },
      });
    }
    return new Response(
      JSON.stringify({
        id: "req-success",
        choices: [
          {
            finish_reason: "stop",
            message: { content: JSON.stringify(validDiscovery) },
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
          total_tokens: 30,
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  });
  try {
    const result = await runAuthoringDiscovery({
      description,
      routerSignal: routerSignal!,
      enforceCompleteDimensions: false,
      catalogs: {
        skills: [],
        tools: [],
        integrations: [],
        assets: [],
        workerCapabilities: [],
      },
    });
    assert.equal(result.kind, "ok");
    assert.equal(requests, 2);
    assert.equal(result.diagnostics.callCount, 1);
    assert.equal(result.diagnostics.transportAttemptCount, 2);
  } finally {
    setAuthoringDiscoveryFetchForTests(null);
    if (priorKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = priorKey;
  }
}

async function doesNotRetryDefinitiveHttpError(): Promise<void> {
  const priorKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-key";
  let requests = 0;
  setAuthoringDiscoveryFetchForTests(async () => {
    requests += 1;
    return new Response("unauthorized", { status: 401 });
  });
  try {
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
    });
    assert.equal(result.kind, "fail_closed");
    assert.equal(requests, 1);
    assert.equal(result.diagnostics.callCount, 1);
    assert.equal(result.diagnostics.transportAttemptCount, 1);
  } finally {
    setAuthoringDiscoveryFetchForTests(null);
    if (priorKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = priorKey;
  }
}

function preservesCanonicalFactsDuringProposalRevision(): void {
  const priorDiscovery = authoringDiscoveryOutputSchema.parse({
    ...validDiscovery,
    covered_dimensions: [
      {
        key: "data_sources",
        status: "covered",
        summary: "Documento aportado por el usuario.",
        evidence: [
          {
            source: "answer",
            answer_index: 0,
            quote: "documento en word (u otro formato, ej. texto)",
          },
        ],
      },
    ],
    material_ambiguities: [],
    gap_candidates: [],
    clarifying_questions: [],
    clarifying_question_details: [],
    gaps: [],
    readiness: "ready_for_confirmation",
    understanding: {
      ...validDiscovery.understanding,
      objective:
        "Preparar y enviar un seguimiento fiel al último acuerdo tras aprobación.",
      sources: ["Documento Word o texto entregado por el usuario."],
      gaps: [],
    },
  });
  const priorCompactState = buildAuthoringDiscoveryCompactState({
    discovery: priorDiscovery,
    priorQuestions: [],
    answerTurnCount: 1,
  });
  const correction =
    "El documento se adjunta en cada ejecución, no es una plantilla permanente.";
  const revised = authoringDiscoveryOutputSchema.parse({
    ...priorDiscovery,
    covered_dimensions: [
      {
        key: "data_sources",
        status: "covered",
        summary: "Adjunto por ejecución.",
        evidence: [
          {
            source: "answer",
            answer_index: 1,
            quote: correction,
          },
        ],
      },
    ],
    input_requirements: [
      {
        kind: "runtime_input",
        key: "source_document",
        label: "Documento fuente de esta ejecución",
        source_hint: "chat_attachment",
      },
    ],
    understanding: {
      ...priorDiscovery.understanding,
      objective: "Redactar y enviar mensajes de seguimiento.",
      sources: [description, correction],
    },
  });
  const merged = mergeConservativeProposalRevision({
    discovery: revised,
    priorCompactState,
    description,
    latestCorrection: correction,
    latestAnswerIndex: 1,
  });
  assert.equal(merged.understanding.objective, priorDiscovery.understanding.objective);
  assert.ok(
    merged.understanding.sources.includes(
      "Documento Word o texto entregado por el usuario."
    )
  );
  assert.ok(merged.understanding.sources.includes(correction));
  assert.ok(
    !merged.understanding.sources.includes(
      "Documento fuente de esta ejecución"
    ),
    "input_requirement labels must not be injected into understanding.sources"
  );
  assert.ok(!merged.understanding.sources.includes(description));
}

async function activatesOutboundKernelFromLaterAnswer(): Promise<void> {
  const first = await runAuthoringDiscovery({
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
      async discover() {
        return validDiscovery;
      },
    },
  });
  assert.equal(first.kind, "ok");
  const compactState = buildAuthoringDiscoveryCompactState({
    discovery: first.discovery,
    priorQuestions: first.discovery.clarifying_questions,
    answerTurnCount: 0,
  });
  const sourceGapId = compactState.gap_plan?.gaps.find(
    (gap) => gap.target_dimension === "data_sources"
  )?.id;
  assert.ok(sourceGapId);
  const answer = `A Gu lo usará el usuario inmobiliario via web chat o Telegram.
El mismo usuario inmobiliario revisará, ajustará (si es necesario) y aprobará el mensaje.
Se deberá activar la capacidad cuando el usuario quiera preparar un mensaje para enviar por email a un propietario de un inmueble que el inmobiliario representa comercialmente o que es posible que represente.`;
  const dimensions = AUTHORING_DISCOVERY_DIMENSIONS.map((key) => {
    if (key === "objective") {
      return {
        key,
        status: "covered",
        summary: "Preparar seguimiento.",
        evidence: [
          {
            source: "description",
            quote: "prepares un seguimiento para un propietario",
          },
        ],
      };
    }
    if (key === "data_sources") {
      return {
        key,
        status: "covered",
        summary: "Gu se usa por chat.",
        evidence: [
          {
            source: "answer",
            answer_index: 0,
            quote: "via web chat o Telegram",
          },
        ],
      };
    }
    if (key === "side_effects") {
      return {
        key,
        status: "covered",
        summary: "Enviar por email.",
        evidence: [
          {
            source: "answer",
            answer_index: 0,
            quote: "enviar por email",
          },
        ],
      };
    }
    if (key === "capabilities") {
      return {
        key,
        status: "partial",
        summary: "Se indicó email y el catálogo tiene una ruta conectada.",
        evidence: [
          {
            source: "answer",
            answer_index: 0,
            quote: "enviar por email",
          },
        ],
      };
    }
    if (key === "actors") {
      return {
        key,
        status: "partial",
        summary: "Se indicó la clase de destinatario, no el contacto exacto.",
        evidence: [
          {
            source: "answer",
            answer_index: 0,
            quote: "a un propietario de un inmueble",
          },
        ],
      };
    }
    if (key === "human_decisions") {
      return {
        key,
        status: "partial",
        summary: "El usuario revisa y aprueba el mensaje.",
        evidence: [
          {
            source: "answer",
            answer_index: 0,
            quote:
              "El mismo usuario inmobiliario revisará, ajustará (si es necesario) y aprobará el mensaje.",
          },
        ],
      };
    }
    return {
      key,
      status: "not_applicable",
      summary: `Estado ${key}.`,
      evidence: [],
    };
  });
  const capabilityContext = buildAuthoringCapabilityContext({
    snapshot: {
      oauthIntegrations: [{ provider: "gmail", status: "active" }],
      accountSecretsByProvider: new Map(),
      telegramLinked: true,
    },
  });
  const secondResponse = {
    ...validDiscovery,
    covered_dimensions: dimensions,
    requested_side_effects: [],
    capability_needs: [
      {
        category_id: "user_email",
        category_label: "Correo de usuario",
        provider_id: null,
        provider_name: null,
        status: "unresolved",
        resolution: "needs_choice",
        capabilities: [],
        connect_href: null,
      },
    ],
    source_strategy: {
      kind: "unknown",
      label: null,
      evidence: [],
    },
    outbound_contract: {
      recipient_strategy: {
        kind: "case_contact_field",
        address_type: "email",
        label: "Email del contacto del caso",
        evidence: [
          {
            source: "answer",
            answer_index: 0,
            quote: "enviar por email",
          },
        ],
      },
      approval: {
        approver: "El usuario inmobiliario",
        scope: ["content"],
        evidence: [
          {
            source: "answer",
            answer_index: 0,
            quote:
              "El mismo usuario inmobiliario revisará, ajustará (si es necesario) y aprobará el mensaje.",
          },
        ],
      },
      delivery: {
        mode: "after_approval",
        evidence: [
          {
            source: "answer",
            answer_index: 0,
            quote: "enviar por email",
          },
        ],
      },
    },
    prior_gap_dispositions: [
      {
        gap_id: sourceGapId,
        status: "resolved",
        evidence: ["via web chat o Telegram"],
      },
    ],
    gap_candidates: [],
    material_ambiguities: [],
    clarifying_questions: [],
    clarifying_question_details: [],
    gaps: [],
    readiness: "ready_for_confirmation",
    understanding: {
      ...validDiscovery.understanding,
      decisions: ["El usuario revisa y aprueba."],
      effects: ["Enviar el mensaje tras aprobación."],
      gaps: [],
    },
  };
  const runSecondTurn = () =>
    runAuthoringDiscovery({
      description,
      answers: [answer],
      latestAnswer: answer,
      priorQuestions: first.discovery.clarifying_questions,
      compactState,
      enforcePriorGapDispositions: true,
      routerSignal: routerSignal!,
      capabilityContext,
      catalogs: {
        skills: [],
        tools: [],
        integrations: [],
        assets: [],
        workerCapabilities: [],
      },
      model: {
        async discover() {
          return secondResponse;
        },
      },
    });
  const result = await runSecondTurn();
  assert.equal(result.kind, "ok");
  assert.equal(
    result.discovery.outbound_contract?.recipient_strategy.kind,
    "unknown",
    "legacy case_contact_field without a real case input must be degraded"
  );
  const replay = await runSecondTurn();
  assert.equal(replay.kind, "ok");
  assert.deepEqual(
    replay.discovery.gap_plan,
    result.discovery.gap_plan,
    "retrying from the same last-valid compact must be idempotent"
  );
  assert.deepEqual(
    replay.discovery.prior_gap_dispositions,
    result.discovery.prior_gap_dispositions
  );
  assert.ok(
    result.discovery.prior_gap_dispositions.every(
      (disposition) => disposition.gap_id === sourceGapId
    ),
    "new outbound gaps must never leak into prior_gap_dispositions"
  );
  const outboundGaps =
    result.discovery.gap_plan?.gaps.filter((gap) =>
      gap.key?.startsWith("external_message.")
    ) ?? [];
  assert.deepEqual(
    outboundGaps.map((gap) => gap.key).sort(),
    [
      "external_message.approval_evidence",
      "external_message.channel_provider",
      "external_message.recipient_resolution",
    ]
  );
  assert.ok(
    result.discovery.requested_side_effects.includes("send_message") &&
      result.discovery.requested_side_effects.includes("human_approval"),
    "validated outbound contract signals must activate the outbound kernel"
  );
  assert.equal(result.discovery.readiness, "needs_clarification");
  const sourceGap = result.discovery.gap_plan?.gaps.find(
    (gap) => gap.id === sourceGapId
  );
  assert.equal(
    sourceGap?.resolution_status,
    "unanswered",
    "invocation channels must not resolve the source of the latest agreement"
  );
  assert.equal(
    outboundGaps.find(
      (gap) => gap.key === "external_message.channel_provider"
    )?.resolution_status,
    "resolved"
  );
  assert.equal(
    outboundGaps.find(
      (gap) => gap.key === "external_message.recipient_resolution"
    )?.resolution_status,
    "unanswered"
  );
  assert.equal(
    outboundGaps.find(
      (gap) => gap.key === "external_message.approval_evidence"
    )?.resolution_status,
    "resolved"
  );
}

/**
 * Regresión del transcript en vivo (Test #1, turno 2): el modelo entendió las
 * respuestas (dimensiones cubiertas con citas literales) pero entregó
 * disposiciones vacías, y regresó dimensiones ya cubiertas con citas
 * fallidas. El sistema no debe re-preguntar lo respondido, ni inflar el plan
 * con gaps de ruido, ni preguntar el modo de entrega que la respuesta ya
 * define.
 */
async function resolvesAnsweredGapsWithoutVerbatimReasking(): Promise<void> {
  const catalogs = {
    skills: [],
    tools: [],
    integrations: [],
    assets: [],
    workerCapabilities: [],
  };
  const activationQuestion =
    "¿En qué situaciones debe usar Gu esta función y en cuáles no?";
  const firstTurnDimensions = AUTHORING_DISCOVERY_DIMENSIONS.map((key) => {
    const coveredByDescription: Record<string, string> = {
      objective: "prepares un seguimiento",
      actors: "para un propietario",
      acceptance_criteria: "resume el último acuerdo",
      durability: "Cada vez que",
      recurrence: "Cada vez que",
    };
    const quote = coveredByDescription[key];
    if (quote) {
      return {
        key,
        status: "covered",
        summary: `Cubierto: ${key}.`,
        evidence: [{ source: "description", quote }],
      };
    }
    if (key === "data_sources") {
      return {
        key,
        status: "missing",
        summary: "No se especifica dónde vive el último acuerdo.",
        evidence: [],
      };
    }
    if (key === "human_decisions") {
      return {
        key,
        status: "missing",
        summary: "Falta definir quién aprueba el envío.",
        evidence: [],
      };
    }
    if (key === "mece_overlap") {
      return {
        key,
        status: "partial",
        summary: "Puede solaparse con otras capacidades.",
        evidence: [],
      };
    }
    return {
      key,
      status: "not_applicable",
      summary: `Estado ${key}.`,
      evidence: [],
    };
  });
  const first = await runAuthoringDiscovery({
    description,
    routerSignal: routerSignal!,
    catalogs,
    model: {
      async discover() {
        return {
          ...validDiscovery,
          covered_dimensions: firstTurnDimensions,
          gap_candidates: [
            {
              key: "activation-scope",
              summary: "Falta delimitar cuándo debe activarse.",
              target_dimension: "mece_overlap",
              question: activationQuestion,
              severity: "blocking",
              depends_on: [],
              priority: 80,
              examples: ["solo propietarios representados"],
            },
          ],
        };
      },
    },
  });
  assert.equal(first.kind, "ok");
  const compactState = buildAuthoringDiscoveryCompactState({
    discovery: first.discovery,
    priorQuestions: first.discovery.clarifying_questions,
    answerTurnCount: 0,
  });
  const priorGaps = compactState.gap_plan?.gaps ?? [];
  assert.equal(priorGaps.length, 3);
  const sourceQuestion = "¿Qué fuente debe usar Gu y cómo estará disponible?";
  const sourceGapId = priorGaps.find(
    (gap) => gap.target_dimension === "data_sources"
  )?.id;
  const approverGapId = priorGaps.find(
    (gap) => gap.target_dimension === "human_decisions"
  )?.id;
  const approverQuestion = priorGaps.find(
    (gap) => gap.id === approverGapId
  )?.question;
  const meceGapId = priorGaps.find(
    (gap) => gap.target_dimension === "mece_overlap"
  )?.id;
  assert.ok(sourceGapId && approverGapId && meceGapId && approverQuestion);
  // La degradación de fuente aplica solo a evidencia solo-canal; una
  // dimensión sin evidencia conserva el resumen del modelo sin texto interno.
  assert.equal(
    priorGaps.find((gap) => gap.id === sourceGapId)?.summary,
    "No se especifica dónde vive el último acuerdo."
  );

  const answer = `Debe utilizar un documento en formato word o en otro formato (ej. txt) que el usuario debe proveer.
El mensaje lo debe revisar, ajustar (si es necesario) y aprobar el mismo usuario (inmobiliario).
Debe activarse cuando el usuario en web chat o Telegram quieran generar el mensaje para el propietario que después debería ser enviado por email.
En cada uso yo le daré a Gu el email del propietario en el chat.`;
  const secondTurnDimensions = AUTHORING_DISCOVERY_DIMENSIONS.map((key) => {
    if (key === "data_sources") {
      return {
        key,
        status: "covered",
        summary: "Documento Word o TXT provisto por el usuario.",
        evidence: [
          {
            source: "answer",
            answer_index: 0,
            quote:
              "Debe utilizar un documento en formato word o en otro formato (ej. txt) que el usuario debe proveer.",
          },
        ],
      };
    }
    if (key === "human_decisions") {
      return {
        key,
        status: "covered",
        summary: "El usuario inmobiliario revisa y aprueba.",
        evidence: [
          {
            source: "answer",
            answer_index: 0,
            quote:
              "El mensaje lo debe revisar, ajustar (si es necesario) y aprobar el mismo usuario (inmobiliario).",
          },
        ],
      };
    }
    if (key === "side_effects") {
      return {
        key,
        status: "partial",
        summary: "Envío por email tras generación.",
        evidence: [
          {
            source: "answer",
            answer_index: 0,
            quote: "después debería ser enviado por email",
          },
        ],
      };
    }
    if (key === "capabilities") {
      return {
        key,
        status: "covered",
        summary: "Revisión y aprobación humanas.",
        evidence: [
          {
            source: "answer",
            answer_index: 0,
            quote: "revisar, ajustar (si es necesario) y aprobar",
          },
        ],
      };
    }
    if (key === "mece_overlap") {
      return {
        key,
        status: "partial",
        summary: "Se activa desde web chat o Telegram.",
        evidence: [
          {
            source: "answer",
            answer_index: 0,
            quote:
              "cuando el usuario en web chat o Telegram quieran generar el mensaje para el propietario",
          },
        ],
      };
    }
    // Regresión típica del modelo: dimensiones ya cubiertas vuelven como
    // partial con citas parafraseadas (inválidas) o sin evidencia.
    return {
      key,
      status: "partial",
      summary: `Estado ${key}.`,
      evidence:
        key === "objective"
          ? [{ source: "description", quote: "una paráfrasis que no existe" }]
          : [],
    };
  });
  const capabilityContext = buildAuthoringCapabilityContext({
    snapshot: {
      oauthIntegrations: [{ provider: "gmail", status: "active" }],
      accountSecretsByProvider: new Map(),
      telegramLinked: true,
    },
  });
  const second = await runAuthoringDiscovery({
    description,
    answers: [answer],
    latestAnswer: answer,
    priorQuestions: first.discovery.clarifying_questions,
    compactState,
    enforcePriorGapDispositions: true,
    routerSignal: routerSignal!,
    capabilityContext,
    catalogs,
    model: {
      async discover() {
        return {
          ...validDiscovery,
          covered_dimensions: secondTurnDimensions,
          requested_side_effects: ["send_message", "human_approval"],
          source_strategy: {
            kind: "operator_supplied_at_runtime",
            label: "Documento Word o TXT aportado por el usuario",
            evidence: [
              {
                source: "answer",
                answer_index: 0,
                quote:
                  "Debe utilizar un documento en formato word o en otro formato (ej. txt) que el usuario debe proveer.",
              },
            ],
          },
          outbound_contract: {
            recipient_strategy: {
              kind: "operator_supplied_at_runtime",
              address_type: "email",
              label: "Email aportado por el usuario en cada conversación",
              evidence: [
                {
                  source: "answer",
                  answer_index: 0,
                  quote:
                    "En cada uso yo le daré a Gu el email del propietario en el chat.",
                },
              ],
            },
            approval: {
              approver: "el mismo usuario (inmobiliario)",
              scope: ["content"],
              evidence: [
                {
                  source: "answer",
                  answer_index: 0,
                  quote:
                    "El mensaje lo debe revisar, ajustar (si es necesario) y aprobar el mismo usuario (inmobiliario).",
                },
              ],
            },
            delivery: {
              mode: "after_approval",
              evidence: [
                {
                  source: "answer",
                  answer_index: 0,
                  quote: "después debería ser enviado por email",
                },
              ],
            },
          },
          gap_candidates: [],
          material_ambiguities: [],
          clarifying_questions: [],
          clarifying_question_details: [],
          gaps: [],
          readiness: "needs_clarification",
          // Patología observada en vivo: el modelo entiende las respuestas
          // pero entrega disposiciones vacías.
          prior_gap_dispositions: priorGaps.map((gap) => ({
            gap_id: gap.id,
            status: "unanswered",
            evidence: [],
          })),
          understanding: {
            ...validDiscovery.understanding,
            gaps: [],
          },
        };
      },
    },
  });
  assert.equal(second.kind, "ok");
  const plan = second.discovery.gap_plan;
  assert.ok(plan);
  const gapById = new Map(plan.gaps.map((gap) => [gap.id, gap]));
  assert.equal(
    gapById.get(sourceGapId)?.resolution_status,
    "resolved",
    "an answered source gap must resolve from covered dimension evidence"
  );
  assert.equal(
    gapById.get(approverGapId)?.resolution_status,
    "resolved",
    "an answered approver gap must resolve from covered dimension evidence"
  );
  const sourceDisposition = second.discovery.prior_gap_dispositions.find(
    (disposition) => disposition.gap_id === sourceGapId
  );
  assert.ok(
    sourceDisposition?.evidence.some((quote) =>
      quote.includes("documento en formato word")
    ),
    "the rescued disposition must carry the verbatim answer evidence"
  );
  assert.ok(
    plan.gaps.every((gap) => !gap.key?.startsWith("evidence:")),
    "quote-validation noise must never create gaps"
  );
  const noisyDimensions = new Set([
    "objective",
    "actors",
    "acceptance_criteria",
    "durability",
    "recurrence",
  ]);
  assert.ok(
    plan.gaps.every(
      (gap) =>
        gap.key?.startsWith("external_message.") ||
        !noisyDimensions.has(gap.target_dimension)
    ),
    "dimensions covered in the compact state must not regress into new gaps"
  );
  assert.equal(
    second.discovery.covered_dimensions.find(
      (dimension) => dimension.key === "objective"
    )?.status,
    "covered",
    "compact-state coverage survives a turn with failed quotes"
  );
  const deliveryGap = plan.gaps.find(
    (gap) => gap.key === "external_message.delivery_mode"
  );
  assert.equal(
    deliveryGap?.resolution_status,
    "resolved",
    "aprobar en la respuesta define la entrega tras aprobación"
  );
  const questions = second.discovery.clarifying_questions;
  assert.ok(
    !questions.includes(sourceQuestion),
    "an answered question must never be re-asked verbatim"
  );
  assert.ok(
    !questions.includes(approverQuestion!),
    "an answered question must never be re-asked verbatim"
  );
  assert.ok(
    plan.gaps.every(
      (gap) =>
        gap.key !== "external_message.recipient_resolution" ||
        gap.resolution_status === "resolved" ||
        gap.resolution_status === "superseded"
    ),
    "a verified runtime recipient strategy must close its canonical gap"
  );
  assert.ok(
    questions.length <= 2,
    `expected a small follow-up batch, got: ${JSON.stringify(questions)}`
  );
  const recipientSourceRef =
    second.discovery.outbound_contract?.recipient_strategy.source_ref;
  assert.equal(recipientSourceRef?.type, "input_requirement");
  assert.ok(
    second.discovery.input_requirements.some(
      (requirement) =>
        requirement.key === recipientSourceRef?.key &&
        requirement.kind === "runtime_input"
    ),
    "operator-supplied recipient must produce a linked runtime input"
  );
}

async function enforcesPriorDispositionContractStrictly(): Promise<void> {
  const catalogs = {
    skills: [],
    tools: [],
    integrations: [],
    assets: [],
    workerCapabilities: [],
  };
  const first = await runAuthoringDiscovery({
    description,
    routerSignal: routerSignal!,
    catalogs,
    model: { async discover() { return validDiscovery; } },
  });
  assert.equal(first.kind, "ok");
  const compactState = buildAuthoringDiscoveryCompactState({
    discovery: first.discovery,
    priorQuestions: first.discovery.clarifying_questions,
    answerTurnCount: 0,
  });
  const sourceGap = compactState.gap_plan?.gaps.find(
    (gap) => gap.target_dimension === "data_sources"
  );
  assert.ok(sourceGap);
  const answer = "El último acuerdo está en un documento Word.";
  const sourceCovered = [
    ...validDiscovery.covered_dimensions,
    {
      key: "data_sources",
      status: "covered",
      summary: "El acuerdo está en Word.",
      evidence: [
        {
          source: "answer",
          answer_index: 0,
          quote: "documento Word",
        },
      ],
    },
  ];
  const sourceStrategy = {
    kind: "operator_supplied_at_runtime" as const,
    label: "Documento Word",
    evidence: [
      {
        source: "answer" as const,
        answer_index: 0,
        quote: "documento Word",
      },
    ],
  };
  const orphanResponse = {
    ...validDiscovery,
    covered_dimensions: sourceCovered,
    source_strategy: sourceStrategy,
    gap_candidates: [],
    prior_gap_dispositions: [
      {
        gap_id: sourceGap.id,
        status: "resolved",
        evidence: ["documento Word"],
      },
      {
        gap_id: "gap_zzzzzzzz",
        status: "open",
        evidence: [],
      },
    ],
  };
  const orphan = await runAuthoringDiscovery({
    description,
    answers: [answer],
    latestAnswer: answer,
    priorQuestions: first.discovery.clarifying_questions,
    compactState,
    enforcePriorGapDispositions: true,
    routerSignal: routerSignal!,
    catalogs,
    model: { async discover() { return orphanResponse; } },
  });
  assert.equal(orphan.kind, "fail_closed");
  assert.equal(orphan.failureClass, "provider_contract_retryable");
  assert.ok(
    orphan.evidenceFailures.some((failure) =>
      failure.includes("gap_zzzzzzzz")
    )
  );

  const fabricatedEvidence = await runAuthoringDiscovery({
    description,
    answers: [answer],
    latestAnswer: answer,
    priorQuestions: first.discovery.clarifying_questions,
    compactState,
    enforcePriorGapDispositions: true,
    routerSignal: routerSignal!,
    catalogs,
    model: {
      async discover() {
        return {
          ...validDiscovery,
          covered_dimensions: sourceCovered,
          source_strategy: sourceStrategy,
          gap_candidates: [],
          prior_gap_dispositions: [
            {
              gap_id: sourceGap.id,
              status: "resolved",
              evidence: ["un CRM que nunca fue mencionado"],
            },
          ],
        };
      },
    },
  });
  assert.equal(fabricatedEvidence.kind, "ok");
  const fabricatedGap = fabricatedEvidence.discovery.gap_plan?.gaps.find(
    (gap) => gap.id === sourceGap.id
  );
  // La cita fabricada se descarta, pero la dimensión cubierta con evidencia
  // literal válida resuelve el gap: el usuario ya respondió y no se le
  // re-pregunta. Ningún texto no-verbatim sobrevive como evidencia.
  assert.equal(
    fabricatedGap?.resolution_status,
    "resolved",
    "valid dimension evidence must rescue the gap despite a fabricated disposition quote"
  );
  const fabricatedDisposition =
    fabricatedEvidence.discovery.prior_gap_dispositions.find(
      (disposition) => disposition.gap_id === sourceGap.id
    );
  assert.deepEqual(
    fabricatedDisposition?.evidence,
    ["documento Word"],
    "fabricated quotes never survive as accepted evidence"
  );

  const toneQuestion = "¿Qué tono exacto debe usar el mensaje?";
  const toneFirst = await runAuthoringDiscovery({
    description,
    routerSignal: routerSignal!,
    catalogs,
    model: {
      async discover() {
        return {
          ...validDiscovery,
          covered_dimensions: [
            ...validDiscovery.covered_dimensions,
            {
              key: "acceptance_criteria",
              status: "missing",
              summary: "Falta el tono.",
              evidence: [],
            },
          ],
          gap_candidates: [
            {
              key: "message-tone",
              summary: "Falta el tono exacto.",
              target_dimension: "acceptance_criteria",
              question: toneQuestion,
              severity: "blocking",
              depends_on: [],
              priority: 90,
              examples: ["cordial y profesional"],
            },
          ],
        };
      },
    },
  });
  assert.equal(toneFirst.kind, "ok");
  const toneCompact = buildAuthoringDiscoveryCompactState({
    discovery: toneFirst.discovery,
    priorQuestions: toneFirst.discovery.clarifying_questions,
    answerTurnCount: 0,
  });
  const toneGap = toneCompact.gap_plan?.gaps.find(
    (gap) => gap.key === "message-tone"
  );
  assert.ok(toneGap);
  const repeatedResidual = await runAuthoringDiscovery({
    description,
    answers: ["Debe ser cordial y profesional."],
    latestAnswer: "Debe ser cordial y profesional.",
    priorQuestions: toneFirst.discovery.clarifying_questions,
    compactState: toneCompact,
    enforcePriorGapDispositions: true,
    routerSignal: routerSignal!,
    catalogs,
    model: {
      async discover() {
        return {
          ...validDiscovery,
          covered_dimensions: [
            ...validDiscovery.covered_dimensions,
            {
              key: "acceptance_criteria",
              status: "partial",
              summary: "Se indicó el tono.",
              evidence: [
                {
                  source: "answer",
                  answer_index: 0,
                  quote: "cordial y profesional",
                },
              ],
            },
          ],
          gap_candidates: [],
          prior_gap_dispositions: [
            {
              gap_id: toneGap.id,
              status: "partial",
              evidence: ["cordial y profesional"],
              residual: toneQuestion,
            },
          ],
        };
      },
    },
  });
  assert.equal(repeatedResidual.kind, "ok");
  assert.equal(
    repeatedResidual.discovery.gap_plan?.gaps.find(
      (gap) => gap.id === toneGap.id
    )?.resolution_status,
    "unanswered",
    "a partial disposition that repeats the prior residual is unanswered"
  );
}

async function injectsScheduleHintWithoutModelCandidate(): Promise<void> {
  const scheduleDescription = "Ejecuta este seguimiento todos los días.";
  const result = await runAuthoringDiscovery({
    description: scheduleDescription,
    routerSignal: {
      kind: "schedule",
      confidence: "high",
      reasons: ["Recurrencia explícita"],
      clarifying_questions: [],
      requested_side_effects: ["schedule_recurrence"],
    },
    catalogs: {
      skills: [],
      tools: [],
      integrations: [],
      assets: [],
      workerCapabilities: [],
    },
    model: {
      async discover() {
        return {
          ...validDiscovery,
          provisional_kind: "schedule",
          final_kind: "schedule",
          skill_subtype: null,
          covered_dimensions: AUTHORING_DISCOVERY_DIMENSIONS.map((key) => ({
            key,
            status: key === "recurrence" ? "missing" : "not_applicable",
            summary:
              key === "recurrence"
                ? "Faltan timezone, misfire y política de fallo."
                : `Estado ${key}.`,
            evidence: [],
          })),
          requested_side_effects: ["schedule_recurrence"],
          gap_candidates: [],
          clarifying_questions: [],
          clarifying_question_details: [],
          gaps: [],
          readiness: "ready_for_confirmation",
          understanding: {
            ...validDiscovery.understanding,
            objective: "Ejecutar seguimiento diariamente.",
            gaps: [],
          },
        };
      },
    },
  });
  assert.equal(result.kind, "ok");
  assert.ok(
    result.discovery.gap_plan?.gaps.some(
      (gap) =>
        gap.key === "schedule.recurrence_policy" &&
        gap.severity === "blocking"
    )
  );
  assert.match(
    result.discovery.clarifying_questions[0] ?? "",
    /zona horaria/i
  );
}

/**
 * Regresión del transcript en vivo (Test #1, turno 3): la pregunta 5 pedía el
 * origen del email del destinatario y el operador respondió con una frase
 * condicional ("se lo tendrá que pedir Gu al usuario antes del envío si no lo
 * tuviese"). El modelo emite operator_supplied_at_runtime con esa cita; el
 * sistema debe conservar la estrategia (sin degradarla a unknown), generar el
 * runtime input de respaldo, resolver el gap prior estructuralmente aunque el
 * modelo lo haya marcado unanswered, y no re-preguntar.
 */
async function resolvesRecipientGapFromConditionalAnswer(): Promise<void> {
  const recipientQuestion =
    "¿Cómo recibirá Gu el email o contacto del destinatario cada vez que se use esta función?";
  const firstResponse = {
    ...validDiscovery,
    gap_candidates: [
      ...validDiscovery.gap_candidates,
      {
        key: "external_message.recipient_resolution",
        summary: "Falta el origen del email del destinatario.",
        target_dimension: "actors",
        question: recipientQuestion,
        severity: "blocking",
        depends_on: [],
        priority: 90,
        examples: ["el usuario lo escribe en el chat"],
      },
    ],
  };
  const first = await runAuthoringDiscovery({
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
      async discover() {
        return firstResponse;
      },
    },
  });
  assert.equal(first.kind, "ok");
  const compactState = buildAuthoringDiscoveryCompactState({
    discovery: first.discovery,
    priorQuestions: first.discovery.clarifying_questions,
    answerTurnCount: 0,
  });
  const recipientGapId = compactState.gap_plan?.gaps.find(
    (gap) => gap.key === "external_message.recipient_resolution"
  )?.id;
  const agreementGapId = compactState.gap_plan?.gaps.find(
    (gap) => gap.key === "agreement-source"
  )?.id;
  assert.ok(recipientGapId);
  assert.ok(agreementGapId);
  const answer = `Ah, el email del propietario se lo tendrá que pedir Gu al usuario antes del envío si no lo tuviese.
Cuando el usuario aprueba el texto, al mismo tiempo está aprobando el envío.
El acuerdo estará en un documento que subirá el usuario en el chat.`;
  const conditionalQuote =
    "el email del propietario se lo tendrá que pedir Gu al usuario antes del envío si no lo tuviese";
  const approvalQuote =
    "Cuando el usuario aprueba el texto, al mismo tiempo está aprobando el envío";
  const documentQuote =
    "El acuerdo estará en un documento que subirá el usuario en el chat";
  const dimensions = AUTHORING_DISCOVERY_DIMENSIONS.map((key) => {
    const coveredByAnswer: Record<string, string> = {
      data_sources: documentQuote,
      actors: conditionalQuote,
      human_decisions: approvalQuote,
      side_effects: approvalQuote,
      capabilities: approvalQuote,
    };
    if (key === "objective") {
      return {
        key,
        status: "covered",
        summary: "Preparar seguimiento.",
        evidence: [
          {
            source: "description",
            quote: "prepares un seguimiento para un propietario",
          },
        ],
      };
    }
    const quote = coveredByAnswer[key];
    if (quote) {
      return {
        key,
        status: "covered",
        summary: `Cubierto: ${key}.`,
        evidence: [{ source: "answer", answer_index: 0, quote }],
      };
    }
    return {
      key,
      status: "not_applicable",
      summary: `Estado ${key}.`,
      evidence: [],
    };
  });
  const capabilityContext = buildAuthoringCapabilityContext({
    snapshot: {
      oauthIntegrations: [{ provider: "gmail", status: "active" }],
      accountSecretsByProvider: new Map(),
      telegramLinked: true,
    },
  });
  const secondResponse = {
    ...validDiscovery,
    covered_dimensions: dimensions,
    requested_side_effects: ["send_message", "human_approval"],
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
    source_strategy: {
      kind: "operator_supplied_at_runtime",
      label: "Documento subido por el usuario en el chat",
      evidence: [
        { source: "answer", answer_index: 0, quote: documentQuote },
      ],
    },
    outbound_contract: {
      recipient_strategy: {
        kind: "operator_supplied_at_runtime",
        address_type: "email",
        label: "Email del propietario",
        source_ref: null,
        evidence: [
          { source: "answer", answer_index: 0, quote: conditionalQuote },
        ],
      },
      approval: {
        approver: "El usuario inmobiliario",
        scope: ["content"],
        evidence: [
          { source: "answer", answer_index: 0, quote: approvalQuote },
        ],
      },
      delivery: {
        mode: "after_approval",
        evidence: [
          { source: "answer", answer_index: 0, quote: approvalQuote },
        ],
      },
    },
    prior_gap_dispositions: [
      {
        gap_id: agreementGapId,
        status: "resolved",
        evidence: [documentQuote],
      },
      // Modelo conservador: no cierra el gap; el respaldo estructural del
      // contrato concreto debe resolverlo sin re-preguntar.
      {
        gap_id: recipientGapId,
        status: "unanswered",
        evidence: [],
      },
    ],
    gap_candidates: [],
    material_ambiguities: [],
    clarifying_questions: [],
    clarifying_question_details: [],
    gaps: [],
    readiness: "ready_for_confirmation",
    understanding: {
      ...validDiscovery.understanding,
      decisions: ["El usuario aprueba texto y envío a la vez."],
      effects: ["Enviar el mensaje tras aprobación."],
      gaps: [],
    },
  };
  const unknownRecipientResponse = {
    ...secondResponse,
    outbound_contract: {
      ...secondResponse.outbound_contract,
      recipient_strategy: {
        ...secondResponse.outbound_contract.recipient_strategy,
        kind: "unknown",
        address_type: null,
        source_ref: null,
        evidence: [],
      },
    },
  };
  const result = await runAuthoringDiscovery({
    description,
    answers: [answer],
    latestAnswer: answer,
    priorQuestions: first.discovery.clarifying_questions,
    compactState,
    enforcePriorGapDispositions: true,
    routerSignal: routerSignal!,
    capabilityContext,
    catalogs: {
      skills: [],
      tools: [],
      integrations: [],
      assets: [],
      workerCapabilities: [],
    },
    model: {
      async discover() {
        return unknownRecipientResponse;
      },
    },
    recipientProvenanceModel: {
      async verify() {
        return {
          verdict: "entailed",
          reason: "La evidencia implica provisión en tiempo de ejecución.",
          strategy: {
            kind: "operator_supplied_at_runtime",
            address_type: "email",
            label: "Email del propietario",
            source_ref: {
              type: "input_requirement",
              key: "recipient_address",
            },
            evidence_quote: conditionalQuote,
          },
        };
      },
    },
  });
  assert.equal(result.kind, "ok");
  assert.equal(
    result.discovery.outbound_contract?.recipient_strategy.kind,
    "operator_supplied_at_runtime",
    "a conditional answer must not degrade the concrete recipient strategy"
  );
  const sourceRef =
    result.discovery.outbound_contract?.recipient_strategy.source_ref;
  assert.equal(sourceRef?.type, "input_requirement");
  assert.ok(
    result.discovery.input_requirements.some(
      (requirement) =>
        requirement.key === sourceRef?.key &&
        (requirement.kind === "runtime_input" ||
          requirement.kind === "human_input")
    ),
    "the recipient strategy must be backed by a linked runtime input"
  );
  const recipientGap = result.discovery.gap_plan?.gaps.find(
    (gap) => gap.id === recipientGapId
  );
  assert.equal(
    recipientGap?.resolution_status,
    "resolved",
    "verified structural backing must resolve the recipient gap even when the model leaves it unanswered"
  );
  assert.equal(result.discovery.recipient_provenance_review?.verdict, "entailed");
  assert.equal(result.diagnostics.recipientReviewCallCount, 1);

  const verifiedCompact = buildAuthoringDiscoveryCompactState({
    discovery: result.discovery,
    priorQuestions: first.discovery.clarifying_questions,
    answerTurnCount: 1,
  });
  let unchangedVerifierCalls = 0;
  const unchanged = await runAuthoringDiscovery({
    description,
    answers: [answer],
    latestAnswer: answer,
    priorQuestions: first.discovery.clarifying_questions,
    compactState: verifiedCompact,
    enforcePriorGapDispositions: true,
    routerSignal: routerSignal!,
    capabilityContext,
    catalogs: {
      skills: [],
      tools: [],
      integrations: [],
      assets: [],
      workerCapabilities: [],
    },
    model: {
      async discover() {
        return secondResponse;
      },
    },
    recipientProvenanceModel: {
      async verify() {
        unchangedVerifierCalls += 1;
        return {
          verdict: "entailed",
          reason: "No debería invocarse para la misma huella.",
          evidence_quote: conditionalQuote,
        };
      },
    },
  });
  assert.equal(unchanged.kind, "ok");
  assert.equal(unchangedVerifierCalls, 0);
  assert.equal(unchanged.diagnostics.recipientReviewCallCount, 0);

  let changedVerifierCalls = 0;
  const changed = await runAuthoringDiscovery({
    description,
    answers: [answer],
    latestAnswer: answer,
    priorQuestions: first.discovery.clarifying_questions,
    compactState: verifiedCompact,
    enforcePriorGapDispositions: true,
    routerSignal: routerSignal!,
    capabilityContext,
    catalogs: {
      skills: [],
      tools: [],
      integrations: [],
      assets: [],
      workerCapabilities: [],
    },
    model: {
      async discover() {
        return {
          ...secondResponse,
          outbound_contract: {
            ...secondResponse.outbound_contract,
            recipient_strategy: {
              ...secondResponse.outbound_contract.recipient_strategy,
              address_type: "phone",
            },
          },
        };
      },
    },
    recipientProvenanceModel: {
      async verify() {
        changedVerifierCalls += 1;
        return {
          verdict: "entailed",
          reason: "La huella cambió y requiere nueva revisión.",
          evidence_quote: conditionalQuote,
        };
      },
    },
  });
  assert.equal(changed.kind, "ok");
  assert.equal(changedVerifierCalls, 1);
  assert.equal(changed.diagnostics.recipientReviewCallCount, 1);

  const rejected = await runAuthoringDiscovery({
    description,
    answers: [answer],
    latestAnswer: answer,
    priorQuestions: first.discovery.clarifying_questions,
    compactState,
    enforcePriorGapDispositions: true,
    routerSignal: routerSignal!,
    capabilityContext,
    catalogs: {
      skills: [],
      tools: [],
      integrations: [],
      assets: [],
      workerCapabilities: [],
    },
    model: {
      async discover() {
        return secondResponse;
      },
    },
    recipientProvenanceModel: {
      async verify() {
        return {
          verdict: "insufficient",
          reason: "La evidencia no implica procedencia.",
          evidence_quote: null,
        };
      },
    },
  });
  assert.equal(rejected.kind, "ok");
  assert.equal(
    rejected.discovery.outbound_contract?.recipient_strategy.kind,
    "unknown"
  );
  assert.equal(rejected.discovery.recipient_provenance_review, undefined);
  assert.ok(
    rejected.discovery.gap_plan?.gaps.some(
      (gap) =>
        gap.id === recipientGapId &&
        gap.resolution_status !== "resolved" &&
        gap.resolution_status !== "superseded"
    ),
    "insufficient provenance must preserve the canonical recipient gap"
  );
  assert.equal(rejected.diagnostics.recipientReviewCallCount, 1);
}

/**
 * Contradicción "duplicado resuelto, original vivo": un gap nuevo resuelto en
 * el mismo turno mientras el gap previo con la misma key sigue abierto
 * genera un warning observacional, nunca un bloqueo.
 */
function flagsDuplicateGapContradiction(): void {
  const priorGap = {
    id: "gap_aaaaaaa1",
    key: "external_message.recipient_resolution",
    target_dimension: "actors",
    resolution_status: "unanswered",
  };
  const duplicateGap = {
    id: "gap_bbbbbbb2",
    key: "external_message.recipient_resolution",
    target_dimension: "actors",
    resolution_status: "resolved",
  };
  const compactState = {
    gap_plan: { gaps: [priorGap] },
  } as unknown as Parameters<
    typeof duplicateGapContradictionWarnings
  >[0]["compactState"];
  const warnings = duplicateGapContradictionWarnings({
    compactState,
    discovery: {
      gap_plan: { gaps: [priorGap, duplicateGap] },
    } as unknown as Parameters<
      typeof duplicateGapContradictionWarnings
    >[0]["discovery"],
  });
  assert.deepEqual(warnings, [
    {
      code: "duplicate_gap_unresolved_prior",
      path: "gap_plan.gaps.gap_bbbbbbb2",
    },
  ]);
  const noWarnings = duplicateGapContradictionWarnings({
    compactState,
    discovery: {
      gap_plan: {
        gaps: [
          { ...priorGap, resolution_status: "resolved" },
          duplicateGap,
        ],
      },
    } as unknown as Parameters<
      typeof duplicateGapContradictionWarnings
    >[0]["discovery"],
  });
  assert.deepEqual(
    noWarnings,
    [],
    "a resolved prior gap must not flag its key"
  );
  const unrelatedActorGap = {
    ...duplicateGap,
    id: "gap_ccccccc3",
    key: "actors.approval_delegate",
  };
  assert.deepEqual(
    duplicateGapContradictionWarnings({
      compactState,
      discovery: {
        gap_plan: { gaps: [priorGap, unrelatedActorGap] },
      } as unknown as Parameters<
        typeof duplicateGapContradictionWarnings
      >[0]["discovery"],
    }),
    [],
    "different claims in the same dimension must remain independent"
  );
}

async function reconcilesReformulatedClaimsSemantically(): Promise<void> {
  const first = await runAuthoringDiscovery({
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
      async discover() {
        return {
          ...validDiscovery,
          gap_candidates: [
            {
              key: "history-source",
              claim_identity: "data_sources.history_origin",
              summary: "Falta saber dónde se consulta el historial.",
              target_dimension: "data_sources",
              question: "¿Dónde consultará Gu el historial?",
              severity: "blocking",
              depends_on: [],
              priority: 100,
              examples: [],
            },
          ],
        };
      },
    },
  });
  assert.equal(first.kind, "ok");
  const compact = buildAuthoringDiscoveryCompactState({
    discovery: first.discovery,
    priorQuestions: first.discovery.clarifying_questions,
    answerTurnCount: 0,
  });
  const prior = compact.gap_plan?.gaps.find(
    (gap) => gap.claim_identity === "data_sources.history_origin"
  );
  assert.ok(prior);
  let reconcilerCalls = 0;
  const second = await runAuthoringDiscovery({
    description,
    answers: ["Aún no lo sé."],
    latestAnswer: "Aún no lo sé.",
    compactState: compact,
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
        return {
          ...validDiscovery,
          gap_candidates: [
            {
              key: "where-history-lives",
              claim_identity: "candidate.history_location",
              summary: "No se conoce la ubicación del historial.",
              target_dimension: "data_sources",
              question: "¿En qué sistema vive el historial?",
              severity: "blocking",
              depends_on: [],
              priority: 100,
              examples: [],
            },
            {
              key: "document-route",
              claim_identity: "data_sources.document_intake_route",
              summary: "Falta definir cómo llega el documento por ejecución.",
              target_dimension: "data_sources",
              question: "¿Cómo entregará la persona el documento?",
              severity: "blocking",
              depends_on: [],
              priority: 90,
              examples: [],
            },
          ],
          prior_gap_dispositions: [
            {
              gap_id: prior.id,
              status: "unanswered",
              evidence: [],
            },
          ],
        };
      },
    },
    gapClaimReconcilerModel: {
      async reconcile() {
        reconcilerCalls += 1;
        return reconcilerCalls === 1
          ? {
              verdict: "same_claim",
              prior_gap_id: prior.id,
              reason: "Es la misma afirmación faltante reformulada.",
            }
          : {
              verdict: "distinct",
              prior_gap_id: null,
              reason: "La ruta de entrada se responde independientemente.",
            };
      },
    },
  });
  assert.equal(second.kind, "ok");
  assert.equal(reconcilerCalls, 2);
  const unresolved = second.discovery.gap_plan?.gaps ?? [];
  assert.equal(
    unresolved.filter(
      (gap) => gap.claim_identity === "data_sources.history_origin"
    ).length,
    1,
    "a reformulated claim must retain one canonical gap"
  );
  assert.ok(
    unresolved.some(
      (gap) =>
        gap.claim_identity === "data_sources.document_intake_route" &&
        gap.id !== prior.id
    ),
    "a genuinely distinct same-dimension claim must remain independent"
  );
}

async function main(): Promise<void> {
  await repairOnce();
  await reviewsRepairAndSalvageCandidates();
  await downgradesUnsupportedEvidenceWithoutRepair();
  await acceptsNestedJsonStringTransport();
  await derivesConservativeFirstTurnGapsAfterFailedRepair();
  await derivesConservativeGapFromUncoveredDimension();
  await blocksAfterFailedRepair();
  await preservesPriorPlanWhenRepairOmitsGapCandidates();
  await preservesCompleteExamplesAndAtomicGapIds();
  await acceptsIncompleteMultiPartExamplesWithWarning();
  await salvagesValidCandidatesFromPresentInvalidArray();
  await overridesModelChannelToolInputMixing();
  await enforcesDocumentIntakeMeceContract();
  await reconcilesDeterministicQueue();
  await coercesEmptyClarificationToReadyWhenPlanCanProceed();
  await retriesRetryableTransportWithoutSpendingCompletionSlot();
  await doesNotRetryDefinitiveHttpError();
  preservesCanonicalFactsDuringProposalRevision();
  await activatesOutboundKernelFromLaterAnswer();
  await resolvesRecipientGapFromConditionalAnswer();
  flagsDuplicateGapContradiction();
  await reconcilesReformulatedClaimsSemantically();
  await resolvesAnsweredGapsWithoutVerbatimReasking();
  await enforcesPriorDispositionContractStrictly();
  await injectsScheduleHintWithoutModelCandidate();
  console.log("authoring-discovery.selftest: all checks passed");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
