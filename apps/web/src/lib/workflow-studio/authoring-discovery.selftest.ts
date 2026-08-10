import assert from "node:assert/strict";
import {
  buildAuthoringDiscoveryCompactState,
  classifyAuthoringIntentDeterministic,
  createAuthoringGapId,
} from "@agents/workflows";
import { runAuthoringDiscovery } from "./authoring-discovery";
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
}

async function derivesConservativeFirstTurnGapsAfterFailedRepair(): Promise<void> {
  const { gap_candidates: _omitted, ...withoutGapCandidates } = validDiscovery;
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
  const { gap_candidates: _omitted, ...withoutGapCandidates } = validDiscovery;
  const { understanding: _missingUnderstanding, ...incompleteRepair } =
    withoutGapCandidates;
  let calls = 0;
  const recovered = await runAuthoringDiscovery({
    description,
    answers: ["Quiero aclarar primero otro aspecto."],
    latestAnswer: "Quiero aclarar primero otro aspecto.",
    priorQuestions: first.discovery.clarifying_questions,
    compactState,
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
    "El asesor aprueba al ver el borrador en el chat",
    "El propietario aprueba por correo con el documento adjunto",
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
    approval?.examples.every(
      (example) =>
        /aprueba|aprob/i.test(example) &&
        /borrador|documento|correo|evidencia|chat/i.test(example)
    ),
    "multi-part approval examples must cover actor and evidence slots"
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

async function repairsIncompleteMultiPartExamples(): Promise<void> {
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
            gapCandidate("approval-evidence", "human_decisions", 100, {
              question:
                "¿Quién aprueba el envío y qué evidencia debe ver antes de decidir?",
              examples:
                calls === 1
                  ? ["Destinatario, asunto y cuerpo completo"]
                  : ["El asesor aprueba después de revisar el borrador completo"],
            }),
          ],
        };
      },
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.kind, "ok");
  assert.deepEqual(
    result.discovery.clarifying_question_details[0]?.examples,
    ["El asesor aprueba después de revisar el borrador completo"]
  );
}

async function overridesModelChannelToolInputMixing(): Promise<void> {
  const capabilityContext = buildAuthoringCapabilityContext({
    values: [
      description,
      "El usuario inicia desde Telegram. El acuerdo está en un Word adjunto en cada ejecución.",
      "Si se aprueba, Gu envía un email al propietario.",
    ],
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
              category_id: "messaging",
              category_label: "Mensajería",
              provider_id: "telegram_bot",
              provider_name: "Telegram",
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
              key: "wrong",
              label: "Wrong",
              source_hint: "account_assets",
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
  const second = await runAuthoringDiscovery({
    description,
    answers: [answer],
    latestAnswer: answer,
    priorQuestions,
    compactState,
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
          gap_candidates: initialCandidates.filter(
            (candidate) =>
              candidate.key !== "source" && candidate.key !== "recurrence"
          ),
        };
      },
    },
  });
  assert.equal(second.kind, "ok");
  assert.equal(
    second.discovery.gap_plan?.gaps.find((gap) => gap.id === sourceId)?.state,
    "resolved_by_evidence"
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

async function main(): Promise<void> {
  await repairOnce();
  await acceptsNestedJsonStringTransport();
  await derivesConservativeFirstTurnGapsAfterFailedRepair();
  await blocksAfterFailedRepair();
  await preservesPriorPlanWhenRepairOmitsGapCandidates();
  await preservesCompleteExamplesAndAtomicGapIds();
  await repairsIncompleteMultiPartExamples();
  await overridesModelChannelToolInputMixing();
  await reconcilesDeterministicQueue();
  console.log("authoring-discovery.selftest: all checks passed");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
