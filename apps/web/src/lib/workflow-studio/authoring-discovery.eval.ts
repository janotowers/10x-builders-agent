/**
 * Eval live de discovery. Carga apps/web/.env.local con Node >=20.
 *
 * Run:
 *   npx tsx src/lib/workflow-studio/authoring-discovery.eval.ts
 *   npx tsx src/lib/workflow-studio/authoring-discovery.eval.ts --conversation
 *   npx tsx src/lib/workflow-studio/authoring-discovery.eval.ts --conversation --runs=5
 *   npx tsx src/lib/workflow-studio/authoring-discovery.eval.ts --recipient-provenance-only
 *   npx tsx src/lib/workflow-studio/authoring-discovery.eval.ts --conversation --runs=5 --concurrency=5
 *   npx tsx src/lib/workflow-studio/authoring-discovery.eval.ts --battery-runs=3
 *   npx tsx src/lib/workflow-studio/authoring-discovery.eval.ts --conversation --benchmark-id=mini-candidate --discovery-model=openai/gpt-5.4-mini --escalation-model=anthropic/claude-opus-5
 *   npx tsx src/lib/workflow-studio/authoring-discovery.eval.ts --limit=2
 *   npx tsx src/lib/workflow-studio/authoring-discovery.eval.ts --start=4 --limit=1
 *
 * Defaults (plan §9): owner conversation N=5, full battery N=3.
 * Model-backed; skipped when OPENROUTER_API_KEY is absent.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  getGlobalSkillRegistry,
  TOOL_CATALOG,
} from "@agents/agent";
import {
  AUTHORING_BATTERY_FIXTURES,
  buildAuthoringDiscoveryCompactState,
  classifyAuthoringIntentDeterministic,
  proceedAuthoringDiscoveryToProposal,
  resolveAuthoringConversationTurn,
  AUTHORING_SOFT_CHECKPOINT_TURN,
  type AuthoringDiscoveryOutput,
} from "@agents/workflows";
import {
  loadWebEnvLocal,
  withCliAiUsageMetering,
} from "../ai-usage/cli-metering";
import { runAuthoringDiscovery } from "./authoring-discovery";
import { buildAuthoringCapabilityContext } from "./capability-provider-catalog";
import { reviewRecipientProvenance } from "./recipient-provenance-verifier";

const OWNER_DESCRIPTION =
  "Cada vez que prepares un mensaje de seguimiento para un propietario, resume el último acuerdo, usa un tono cordial y profesional y termina proponiendo una siguiente acción concreta. Nunca inventes compromisos, fechas ni información de la propiedad.";

const OWNER_ANSWER_1 = `Esta en un documento word usualmente aunque podría tener también otro formato, como texto por ejemplo.
Gu debe entregar un borrador en texto y también en archivo para que el usuario lo revise y pueda ajustarlo. Si lo aprueba, Gu debe enviarlo por email al propietario y confirmar el envío.
Este procedimiento solo es para propietarios de inmuebles que representamos o vamos a representar comercialmente. Actualmente los propietarios no se tienen en el sistema/cuenta.`;

const OWNER_ANSWER_2 =
  "El resultado correcto es un email enviado al propietario con un mensaje atractivo, un llamado a la acción concreto, datos fieles al documento y confirmación del envío.";

const OWNER_ANSWER_3 =
  "Ya te había comentado que el usuario inmobiliario le dará a Gu el email del propietario en la conversación cada vez que use esta función.";

// Transcript exacto de la corrida manual que provocó el bucle de la pregunta 5:
// la frase condicional ("si no lo tuviese") sigue resolviendo el origen del
// email — el usuario lo aporta en cada uso — y no debe degradarse a unknown.
const OWNER_CONDITIONAL_RECIPIENT_ANSWER = `Ah, el email del propietario se lo tendrá que pedir Gu al usuario antes del envío si no lo tuviese.
Cuando el usuario aprueba el texto, al mismo tiempo está aprobando el envío.`;

const OWNER_TEST_1_PARTIAL_ANSWER = `A Gu lo usará el usuario inmobiliario via web chat o Telegram.
El mismo usuario inmobiliario revisará, ajustará (si es necesario) y aprobará el mensaje.
Se deberá activar la capacidad cuando el usuario quiera preparar un mensaje para enviar por email a un propietario de un inmueble que el inmobiliario representa comercialmente o que es posible que represente.`;

// Transcript exacto de la prueba manual post-ajustes: resuelve las cuatro
// preguntas visibles, pero deliberadamente no dice de dónde sale el email.
const OWNER_MANUAL_ROUND_1_ANSWER = `El acuerdo y cualquier otro historial lo podrá encontrar en un documento en formato Word (.docx) u otro formato (ej. txt) que el usuario inmobiliario deberá subir en el chat.
La información de la propiedad debería venir en el mismo documento donde está el acuerdo.
El usuario deberá recibir la propuesta de mensaje para revisarla, hacer cambios o ajustes si es necesario, y entonces aprobarla. Una vez aprobada debería enviarse por email.
Esta función debería utilizarse solamente cuando se quiere hacer un seguimiento al propietario de un inmueble que el usuario inmobiliario representa para su comercialización o que está en conversaciones para poder comercializar.`;

type DiscoveryOk = Extract<
  Awaited<ReturnType<typeof runAuthoringDiscovery>>,
  { kind: "ok" }
>;

interface OwnerConversationTrace {
  first: DiscoveryOk["discovery"];
  second: DiscoveryOk["discovery"];
  third: DiscoveryOk["discovery"];
  fourth: DiscoveryOk["discovery"];
  finalKind: string;
  skillSubtype: string | undefined;
  questionBand: number[];
  blockerCounts: number[];
  planTotals: number[];
  completionCounts: number[];
  transportAttemptCounts: number[];
  resultModelIds: string[];
}

function parsePositiveInt(flag: string, fallback: number): number {
  const eq = process.argv.find((arg) => arg.startsWith(`${flag}=`));
  if (eq) {
    const value = Number(eq.split("=")[1]);
    if (Number.isFinite(value) && value >= 1) return Math.floor(value);
  }
  const index = process.argv.indexOf(flag);
  if (index >= 0) {
    const value = Number(process.argv[index + 1]);
    if (Number.isFinite(value) && value >= 1) return Math.floor(value);
  }
  return fallback;
}

function parseStringFlag(flag: string): string | null {
  const eq = process.argv.find((arg) => arg.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1).trim() || null;
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1]?.trim() || null : null;
}

/**
 * Provider contract breaks are the failure this harness is meant to measure, so
 * the message must carry the safe diagnostics needed to tell a truncated
 * payload apart from a real material-validation failure.
 */
function describeDiscoveryFailure(
  label: string,
  result: Extract<
    Awaited<ReturnType<typeof runAuthoringDiscovery>>,
    { kind: "fail_closed" }
  >
): string {
  return [
    `${label}: ${result.reason}`,
    `failureClass=${result.failureClass}`,
    `diagnostics=${JSON.stringify(result.diagnostics)}`,
    `qualityWarnings=${JSON.stringify(result.qualityWarnings)}`,
  ].join(" | ");
}

function assertGapContract(
  label: string,
  discovery: AuthoringDiscoveryOutput,
  catalogCandidates: readonly string[]
): void {
  assert.ok(discovery.gap_plan, `${label}: deterministic gap plan required`);
  assert.ok(
    discovery.clarifying_question_details.every(
      (detail) => Boolean(detail.gap_id) && Array.isArray(detail.examples)
    ),
    `${label}: every selected question needs gap_id and complete examples array`
  );
  assert.ok(
    discovery.clarifying_questions.length <= 4,
    `${label}: deterministic queue is bounded to four`
  );
  const overlap = discovery.covered_dimensions.find(
    (dimension) => dimension.key === "mece_overlap"
  );
  if (!overlap) return;
  const normalizedSummary = overlap.summary.toLocaleLowerCase();
  const namesConcreteCandidate = catalogCandidates.some((candidate) =>
    normalizedSummary.includes(candidate.toLocaleLowerCase())
  );
  if (!namesConcreteCandidate) {
    assert.doesNotMatch(
      overlap.summary,
      /(?:se solapa|duplica|ya existe).*(?:capacidad|flujo|skill)/i,
      `${label}: vague overlap must not imply an unnamed existing artifact`
    );
  }
}

function assertCompleteExamples(
  label: string,
  discovery: AuthoringDiscoveryOutput
): void {
  for (const detail of discovery.clarifying_question_details) {
    assert.ok(
      Array.isArray(detail.examples),
      `${label}: examples array required for ${detail.gap_id ?? detail.question}`
    );
    assert.ok(
      detail.examples.length <= 3,
      `${label}: at most 3 examples for ${detail.gap_id ?? detail.question}`
    );
    // Only treat as multi-part when the question itself joins actor + evidence slots.
    const multiPart =
      /\b(?:quién|quien)\b[\s\S]{0,100}\b(?:y|e)\b[\s\S]{0,100}\b(?:evidencia|qu[eé]\s+ve|documento|borrador)\b/i.test(
        detail.question
      ) ||
      /\bevidencia\b[\s\S]{0,100}\b(?:y|e)\b[\s\S]{0,100}\b(?:quién|quien|aprueba|decide)\b/i.test(
        detail.question
      );
    if (multiPart) {
      assert.ok(
        detail.examples.length >= 1,
        `${label}: multi-part question needs complete examples`
      );
      assert.ok(
        /aprob|decide|asesor|propietario|usuario/i.test(
          detail.examples.join("\n")
        ) &&
          /borrador|documento|correo|evidencia|chat|archivo|email/i.test(
            detail.examples.join("\n")
          ),
        `${label}: multi-part examples must cover actor + evidence slots`
      );
    }
  }
}

function assertSurfaceSeparation(
  label: string,
  discovery: AuthoringDiscoveryOutput
): void {
  assert.ok(
    discovery.input_requirements.every(
      (requirement) =>
        requirement.kind !== "tool" && requirement.kind !== "integration"
    ),
    `${label}: tools/integrations must not appear as input_requirements`
  );
  assert.ok(
    discovery.input_requirements.every(
      (requirement) =>
        !/gmail/i.test(requirement.key) && !/gmail/i.test(requirement.label)
    ),
    `${label}: Gmail belongs in capability_needs, not runtime inputs`
  );
  const telegramChannel = discovery.invocation_channels.find(
    (channel) => channel.channel === "telegram"
  );
  if (telegramChannel) {
    assert.equal(
      telegramChannel.supports_generic_attachments,
      true,
      `${label}: Telegram must expose the shared generic attachment pipeline`
    );
    assert.match(
      telegramChannel.limitations.join(" "),
      /\.xls.*\.xlsx/i,
      `${label}: Telegram must disclose the legacy .xls exception`
    );
  }
  const assumptionBlob = [
    ...discovery.assumptions,
    ...discovery.understanding.assumptions,
    ...(telegramChannel?.limitations ?? []),
  ].join("\n");
  if (/\bxls\b/i.test(assumptionBlob) || /\b\.xls\b/i.test(assumptionBlob)) {
    assert.match(
      assumptionBlob,
      /no\s+(?:(?:se|est[aá]n)\s+)?(?:soport|acept|promet|habilit|dispon)|rechaz|unsafe/i,
      `${label}: if .xls is mentioned, assumptions must disclose rejection`
    );
  }
}

function assertOwnerTurnSurfaces(
  label: string,
  discovery: AuthoringDiscoveryOutput
): void {
  assertSurfaceSeparation(label, discovery);
  if (discovery.readiness === "ready_for_confirmation" || discovery.input_requirements.length > 0) {
    assert.ok(
      discovery.input_requirements.some(
        (requirement) =>
          requirement.kind === "runtime_input" &&
          requirement.source_hint === "chat_attachment"
      ),
      `${label}: owner source DOCX/TXT must be runtime_input chat_attachment`
    );
  }
}

function assertCleanOwnerProposalSurfaces(
  label: string,
  discovery: AuthoringDiscoveryOutput
): void {
  const approvalQuotes =
    discovery.outbound_contract?.approval.evidence.map((item) =>
      item.quote.trim()
    ) ?? [];
  for (const source of discovery.understanding.sources) {
    assert.ok(
      approvalQuotes.every((quote) => !quote || source.trim() !== quote),
      `${label}: approval evidence must not be copied into understanding.sources`
    );
  }

  const requirementKeys = discovery.input_requirements.map(
    (requirement) => requirement.key
  );
  assert.equal(
    new Set(requirementKeys).size,
    requirementKeys.length,
    `${label}: one business datum must not be duplicated across input kinds`
  );
  assert.ok(
    discovery.input_requirements.filter(
      (requirement) =>
        requirement.kind === "runtime_input" &&
        requirement.source_hint === "chat_attachment"
    ).length <= 1,
    `${label}: the source document must be one chat-attachment input`
  );

  const recipientInputKey =
    discovery.outbound_contract?.recipient_strategy.source_ref?.type ===
    "input_requirement"
      ? discovery.outbound_contract.recipient_strategy.source_ref.key
      : null;
  assert.ok(
    discovery.input_requirements
      .filter((requirement) => requirement.kind === "human_input")
      .every((requirement) => requirement.key === recipientInputKey),
    `${label}: human approval is a flow decision, not a run input`
  );

  const sendsAfterApproval =
    discovery.requested_side_effects.includes("send_message") &&
    discovery.outbound_contract?.delivery.mode === "after_approval";
  if (sendsAfterApproval) {
    assert.ok(
      discovery.requested_side_effects.includes("human_approval"),
      `${label}: after-approval delivery requires human_approval`
    );
  }
}

async function runOwnerConversation(params: {
  skills: string[];
  tools: string[];
}): Promise<OwnerConversationTrace> {
  const signal = classifyAuthoringIntentDeterministic(OWNER_DESCRIPTION);
  assert.ok(signal);
  const catalogs = {
    skills: params.skills,
    tools: params.tools,
    integrations: [],
    assets: [],
    workerCapabilities: [],
  };
  const capabilityContext = buildAuthoringCapabilityContext({
    snapshot: {
      oauthIntegrations: [{ provider: "gmail", status: "active" }],
      accountSecretsByProvider: new Map(),
      telegramLinked: true,
    },
  });

  const first = await runAuthoringDiscovery({
    description: OWNER_DESCRIPTION,
    routerSignal: signal,
    catalogs,
    capabilityContext,
  });
  assert.equal(
    first.kind,
    "ok",
    first.kind === "fail_closed"
      ? describeDiscoveryFailure("first turn", first)
      : "first turn"
  );
  assert.equal(first.discovery.readiness, "needs_clarification");
  assertGapContract("owner first turn", first.discovery, [
    ...params.skills,
    ...params.tools,
  ]);
  assertCompleteExamples("owner first turn", first.discovery);
  assert.ok(first.discovery.clarifying_question_details.length > 0);
  assert.ok(
    first.discovery.clarifying_questions.length <= 4,
    "gap planner batches at most 4 independent questions"
  );
  assert.ok(
    (first.discovery.gap_plan?.counts.total ?? 0) >=
      first.discovery.clarifying_questions.length,
    "unasked gaps must remain in the plan beyond the visible batch"
  );
  assert.ok(
    first.discovery.clarifying_question_details.some(
      (detail) => detail.examples.length > 0
    ),
    "at least one abstract question should include contextual examples"
  );
  assertOwnerTurnSurfaces("owner first turn", first.discovery);

  const questions1 = first.discovery.clarifying_questions;
  const compact1 = buildAuthoringDiscoveryCompactState({
    discovery: first.discovery,
    priorQuestions: questions1,
    answerTurnCount: 0,
  });
  const partialBranch = await runAuthoringDiscovery({
    description: OWNER_DESCRIPTION,
    answers: [OWNER_TEST_1_PARTIAL_ANSWER],
    latestAnswer: OWNER_TEST_1_PARTIAL_ANSWER,
    priorQuestions: questions1,
    compactState: compact1,
    routerSignal: signal,
    catalogs,
    capabilityContext,
  });
  assert.equal(
    partialBranch.kind,
    "ok",
    partialBranch.kind === "fail_closed"
      ? describeDiscoveryFailure("test #1 partial answer", partialBranch)
      : "test #1 partial answer"
  );
  assert.notEqual(
    partialBranch.discovery.readiness,
    "ready_for_confirmation",
    "Test #1 must not confirm while source and exact recipient remain open"
  );
  const firstPlanIds = new Set(
    (first.discovery.gap_plan?.gaps ?? []).map((gap) => gap.id)
  );
  assert.ok(
    partialBranch.discovery.prior_gap_dispositions.every((disposition) =>
      firstPlanIds.has(disposition.gap_id)
    ),
    "Test #1: new outbound gaps must not leak into prior dispositions"
  );
  assert.ok(
    partialBranch.discovery.gap_plan?.gaps.some(
      (gap) =>
        gap.key === "external_message.recipient_resolution" &&
        gap.resolution_status !== "resolved"
    ),
    "Test #1: an owner class must not resolve the exact recipient"
  );
  const partialApproval = partialBranch.discovery.outbound_contract?.approval;
  assert.ok(
    (partialApproval?.approver &&
      partialApproval.scope.length > 0 &&
      partialApproval.evidence.length > 0) ||
      partialBranch.discovery.gap_plan?.gaps.some(
        (gap) => gap.key === "external_message.approval_evidence"
      ),
    `Test #1: approval evidence must be represented by the outbound kernel: ${JSON.stringify(
      {
        requested_side_effects: partialBranch.discovery.requested_side_effects,
        capability_needs: partialBranch.discovery.capability_needs,
        outbound_contract: partialBranch.discovery.outbound_contract,
        gaps: partialBranch.discovery.gap_plan?.gaps.map((gap) => ({
          key: gap.key,
          target_dimension: gap.target_dimension,
          status: gap.resolution_status,
        })),
      }
    )}`
  );

  const answeredBranch = await runAuthoringDiscovery({
    description: OWNER_DESCRIPTION,
    answers: [OWNER_MANUAL_ROUND_1_ANSWER],
    latestAnswer: OWNER_MANUAL_ROUND_1_ANSWER,
    priorQuestions: questions1,
    compactState: compact1,
    routerSignal: signal,
    catalogs,
    capabilityContext,
  });
  assert.equal(
    answeredBranch.kind,
    "ok",
    answeredBranch.kind === "fail_closed"
      ? describeDiscoveryFailure("test #1 answered turn", answeredBranch)
      : "test #1 answered turn"
  );
  const answeredPlan = answeredBranch.discovery.gap_plan;
  assert.ok(answeredPlan, "test #1 answered turn: plan required");
  const answeredDimensions = new Set(["data_sources", "human_decisions"]);
  for (const gap of answeredPlan.gaps) {
    // Los gates kernel (external_message.*) tienen semántica más estrecha que
    // su dimensión y pueden permanecer abiertos legítimamente.
    if (gap.key?.startsWith("external_message.")) continue;
    if (
      firstPlanIds.has(gap.id) &&
      answeredDimensions.has(gap.target_dimension)
    ) {
      assert.ok(
        gap.resolution_status === "resolved" ||
          gap.resolution_status === "superseded",
        `test #1 answered turn: gap ${gap.id} (${gap.target_dimension}) must resolve; got ${gap.resolution_status}`
      );
    }
  }
  const answeredDelivery = answeredPlan.gaps.find(
    (gap) => gap.key === "external_message.delivery_mode"
  );
  if (answeredDelivery) {
    assert.equal(
      answeredDelivery.resolution_status,
      "resolved",
      "test #1 answered turn: aprobar + enviar por email define la entrega tras aprobación"
    );
  }
  const answeredChannel = answeredPlan.gaps.find(
    (gap) => gap.key === "external_message.channel_provider"
  );
  if (answeredChannel) {
    assert.equal(
      answeredChannel.resolution_status,
      "resolved",
      "manual transcript: structured user_email must resolve through connected Gmail"
    );
  }
  assert.ok(
    answeredBranch.discovery.clarifying_questions.every(
      (question) =>
        !/conexión principal no está disponible|cuenta o herramienta debe salir/i.test(
          question
        )
    ),
    "manual transcript: connected Gmail must not produce a route/fallback question"
  );
  assert.ok(
    answeredPlan.gaps.every((gap) => !gap.key?.startsWith("evidence:")),
    "test #1 answered turn: quote noise must never create gaps"
  );
  const firstPlanTotal = first.discovery.gap_plan?.counts.total ?? 0;
  assert.ok(
    answeredPlan.counts.total <= firstPlanTotal + 5,
    `test #1 answered turn: plan bloat (${answeredPlan.counts.total} gaps from ${firstPlanTotal})`
  );
  const firstQuestionSet = new Set(
    first.discovery.clarifying_question_details
      .filter((detail) =>
        answeredDimensions.has(detail.target_dimension ?? "")
      )
      .map((detail) => detail.question.trim().toLocaleLowerCase())
  );
  for (const question of answeredBranch.discovery.clarifying_questions) {
    assert.ok(
      !firstQuestionSet.has(question.trim().toLocaleLowerCase()),
      `test #1 answered turn: answered question re-asked verbatim: ${question}`
    );
  }
  assert.ok(
    answeredBranch.discovery.outbound_contract?.recipient_strategy.kind ===
      undefined ||
      answeredBranch.discovery.outbound_contract.recipient_strategy.kind ===
        "unknown",
    `manual transcript: sending by email must not invent a recipient source: ${JSON.stringify(
      answeredBranch.discovery.outbound_contract?.recipient_strategy
    )}`
  );
  assert.notEqual(
    answeredBranch.discovery.readiness,
    "ready_for_confirmation",
    "manual transcript: recipient source remains a blocker"
  );
  assert.equal(
    answeredBranch.discovery.gap_plan?.gaps.filter(
      (gap) =>
        gap.key === "external_message.recipient_resolution" &&
        gap.resolution_status !== "resolved" &&
        gap.resolution_status !== "superseded"
    ).length,
    1,
    "manual transcript: exactly one recipient-resolution gap remains"
  );
  assert.ok(
    !answeredBranch.discovery.outbound_contract?.approval.scope.includes(
      "recipient"
    ),
    "manual transcript: reviewing the result supports content, not recipient"
  );

  const answeredQuestions = answeredBranch.discovery.clarifying_questions;
  const answeredCompact = buildAuthoringDiscoveryCompactState({
    discovery: answeredBranch.discovery,
    priorQuestions: [...questions1, ...answeredQuestions],
    answerTurnCount: 1,
  });
  const recipientFollowup = await runAuthoringDiscovery({
    description: OWNER_DESCRIPTION,
    answers: [OWNER_MANUAL_ROUND_1_ANSWER, OWNER_ANSWER_3],
    latestAnswer: OWNER_ANSWER_3,
    priorQuestions: [...questions1, ...answeredQuestions],
    compactState: answeredCompact,
    routerSignal: signal,
    catalogs,
    capabilityContext,
  });
  assert.equal(
    recipientFollowup.kind,
    "ok",
    recipientFollowup.kind === "fail_closed"
      ? describeDiscoveryFailure("manual recipient follow-up", recipientFollowup)
      : "manual recipient follow-up"
  );
  assert.equal(
    recipientFollowup.discovery.outbound_contract?.recipient_strategy.kind,
    "operator_supplied_at_runtime"
  );
  const recipientSourceRef =
    recipientFollowup.discovery.outbound_contract?.recipient_strategy.source_ref;
  assert.equal(recipientSourceRef?.type, "input_requirement");
  assert.ok(
    recipientFollowup.discovery.input_requirements.some(
      (requirement) =>
        requirement.key === recipientSourceRef?.key &&
        (requirement.kind === "runtime_input" ||
          requirement.kind === "human_input") &&
        (requirement.scope === "turn" || requirement.scope === "task_run")
    ),
    "operator-supplied recipient creates a linked per-use input"
  );
  assert.ok(
    recipientFollowup.discovery.gap_plan?.gaps.every(
      (gap) =>
        gap.key !== "external_message.recipient_resolution" ||
        gap.resolution_status === "resolved" ||
        gap.resolution_status === "superseded"
    ),
    "manual recipient follow-up resolves the blocker without re-asking"
  );
  assertCleanOwnerProposalSurfaces(
    "manual recipient follow-up",
    recipientFollowup.discovery
  );

  const conditionalRecipientFollowup = await runAuthoringDiscovery({
    description: OWNER_DESCRIPTION,
    answers: [OWNER_MANUAL_ROUND_1_ANSWER, OWNER_CONDITIONAL_RECIPIENT_ANSWER],
    latestAnswer: OWNER_CONDITIONAL_RECIPIENT_ANSWER,
    priorQuestions: [...questions1, ...answeredQuestions],
    compactState: answeredCompact,
    routerSignal: signal,
    catalogs,
    capabilityContext,
  });
  assert.equal(
    conditionalRecipientFollowup.kind,
    "ok",
    conditionalRecipientFollowup.kind === "fail_closed"
      ? describeDiscoveryFailure(
          "conditional recipient follow-up",
          conditionalRecipientFollowup
        )
      : "conditional recipient follow-up"
  );
  assert.equal(
    conditionalRecipientFollowup.discovery.outbound_contract
      ?.recipient_strategy.kind,
    "operator_supplied_at_runtime",
    "conditional phrasing ('si no lo tuviese') still answers where the email comes from"
  );
  const conditionalSourceRef =
    conditionalRecipientFollowup.discovery.outbound_contract
      ?.recipient_strategy.source_ref;
  assert.equal(conditionalSourceRef?.type, "input_requirement");
  assert.ok(
    conditionalRecipientFollowup.discovery.input_requirements.some(
      (requirement) =>
        requirement.key === conditionalSourceRef?.key &&
        (requirement.kind === "runtime_input" ||
          requirement.kind === "human_input")
    ),
    "conditional recipient answer creates a linked per-use input"
  );
  assert.ok(
    conditionalRecipientFollowup.discovery.gap_plan?.gaps.every(
      (gap) =>
        gap.key !== "external_message.recipient_resolution" ||
        gap.resolution_status === "resolved" ||
        gap.resolution_status === "superseded"
    ),
    "conditional recipient follow-up resolves the blocker"
  );
  assert.ok(
    conditionalRecipientFollowup.diagnostics.callCount >= 1 &&
      conditionalRecipientFollowup.diagnostics.callCount <= 2,
    "conditional recipient may take one primary call or one schema repair"
  );
  assert.equal(
    conditionalRecipientFollowup.diagnostics.recipientReviewCallCount,
    1,
    "conditional recipient requires one bounded provenance review"
  );

  const second = await runAuthoringDiscovery({
    description: OWNER_DESCRIPTION,
    answers: [OWNER_ANSWER_1],
    latestAnswer: OWNER_ANSWER_1,
    priorQuestions: questions1,
    compactState: compact1,
    routerSignal: signal,
    catalogs,
    capabilityContext,
  });
  assert.equal(
    second.kind,
    "ok",
    second.kind === "fail_closed"
      ? describeDiscoveryFailure("second turn", second)
      : "second turn"
  );
  const secondQuestions = second.discovery.clarifying_questions.join(" ");
  assert.doesNotMatch(
    secondQuestions,
    /de qué sistema o información debe obtener|quién participa o debe tomar decisiones/i,
    "must not re-ask generic source/actor questions already answered"
  );
  assert.ok(second.discovery.understanding.sources.length > 0);
  assert.ok(second.discovery.understanding.actors.length > 0);
  assert.ok(second.discovery.understanding.decisions.length > 0);
  assert.ok(second.discovery.understanding.effects.length > 0);
  assertGapContract("owner second turn", second.discovery, [
    ...params.skills,
    ...params.tools,
  ]);
  assertCompleteExamples("owner second turn", second.discovery);
  assertOwnerTurnSurfaces("owner second turn", second.discovery);

  // Dependent gaps may unlock after the source answer. The plan is
  // append-preserving: every prior id remains represented. A merely `asked`
  // gap may legitimately return to `open` when the answer did not address it;
  // this is how ignored questions stay queued for a later round.
  const firstAskedIds = new Set(
    first.discovery.clarifying_question_details
      .map((detail) => detail.gap_id)
      .filter((id): id is string => Boolean(id))
  );
  const secondGapIds = new Set(
    (second.discovery.gap_plan?.gaps ?? []).map((gap) => gap.id)
  );
  for (const gapId of firstAskedIds) {
    assert.ok(
      secondGapIds.has(gapId),
      `owner second turn: prior gap ${gapId} must remain in the durable plan`
    );
  }

  const questions2 = second.discovery.clarifying_questions;
  const compact2 = buildAuthoringDiscoveryCompactState({
    discovery: second.discovery,
    priorQuestions: [...questions1, ...questions2],
    answerTurnCount: 1,
  });
  const third = await runAuthoringDiscovery({
    description: OWNER_DESCRIPTION,
    answers: [OWNER_ANSWER_1, OWNER_ANSWER_2],
    latestAnswer: OWNER_ANSWER_2,
    priorQuestions: [...questions1, ...questions2],
    compactState: compact2,
    routerSignal: signal,
    catalogs,
    capabilityContext,
  });
  assert.equal(
    third.kind,
    "ok",
    third.kind === "fail_closed"
      ? describeDiscoveryFailure("third turn", third)
      : "third turn"
  );
  assert.notEqual(third.discovery.readiness, "blocked_reformulate");
  assertGapContract("owner third turn", third.discovery, [
    ...params.skills,
    ...params.tools,
  ]);
  assertCompleteExamples("owner third turn", third.discovery);
  assert.ok(
    third.discovery.input_requirements.some(
      (requirement) =>
        requirement.kind === "runtime_input" &&
        requirement.source_hint === "chat_attachment"
    ),
    "owner source DOCX/TXT must be a per-execution chat attachment"
  );
  assert.deepEqual(
    third.discovery.invocation_channels.map((channel) => channel.channel),
    ["web_chat", "telegram"]
  );
  assert.equal(
    third.discovery.invocation_channels.find(
      (channel) => channel.channel === "telegram"
    )?.supports_generic_attachments,
    true
  );
  assert.ok(
    third.discovery.capability_needs.some(
      (need) => need.provider_id === "gmail"
    ),
    "Gmail is the execution provider for the requested email output"
  );
  assert.ok(
    third.discovery.capability_needs.every(
      (need) => need.provider_id !== "telegram_bot"
    ),
    "Telegram invocation/approval must not make Telegram an execution tool"
  );
  assertOwnerTurnSurfaces("owner third turn", third.discovery);

  // El checkpoint suave no interrumpe mientras quedan blockers preguntables.
  const checkpoint = resolveAuthoringConversationTurn({
    discovery: third.discovery,
    answerTurnCount: AUTHORING_SOFT_CHECKPOINT_TURN,
  });
  if ((third.discovery.gap_plan?.counts.blockers ?? 0) > 0) {
    assert.equal(checkpoint.phase, "discovering");
    assert.equal(checkpoint.meta.allow_proceed_to_proposal, false);
    const proceeded = proceedAuthoringDiscoveryToProposal({
      discovery: third.discovery,
      answerTurnCount: AUTHORING_SOFT_CHECKPOINT_TURN,
    });
    assert.equal(proceeded.ok, false);
  }

  const questions3 = third.discovery.clarifying_questions;
  const compact3 = buildAuthoringDiscoveryCompactState({
    discovery: third.discovery,
    priorQuestions: [...questions1, ...questions2, ...questions3],
    answerTurnCount: 2,
  });
  const fourth = await runAuthoringDiscovery({
    description: OWNER_DESCRIPTION,
    answers: [OWNER_ANSWER_1, OWNER_ANSWER_2, OWNER_ANSWER_3],
    latestAnswer: OWNER_ANSWER_3,
    priorQuestions: [...questions1, ...questions2, ...questions3],
    compactState: compact3,
    routerSignal: signal,
    catalogs,
    capabilityContext,
  });
  assert.equal(
    fourth.kind,
    "ok",
    fourth.kind === "fail_closed"
      ? describeDiscoveryFailure("fourth turn", fourth)
      : "fourth turn"
  );
  assertGapContract("owner fourth turn", fourth.discovery, [
    ...params.skills,
    ...params.tools,
  ]);
  assert.equal(
    fourth.discovery.outbound_contract?.recipient_strategy.kind,
    "operator_supplied_at_runtime",
    "Test #1: natural language about giving the email must become a runtime recipient strategy"
  );
  assert.ok(
    fourth.discovery.outbound_contract?.recipient_strategy.evidence.some(
      (item) => OWNER_ANSWER_3.includes(item.quote)
    ),
    "Test #1: runtime recipient strategy requires verbatim evidence"
  );
  assert.ok(
    fourth.discovery.gap_plan?.gaps.every(
      (gap) =>
        gap.key !== "external_message.recipient_resolution" ||
        gap.resolution_status === "resolved" ||
        gap.resolution_status === "superseded"
    ),
    "Test #1: the recipient strategy must not remain open or be re-asked"
  );
  assertOwnerTurnSurfaces("owner fourth turn", fourth.discovery);
  assertCleanOwnerProposalSurfaces("owner fourth turn", fourth.discovery);

  console.log(
    `✓ owner conversation: ${first.discovery.readiness} → ${second.discovery.readiness} → ${third.discovery.readiness} → ${fourth.discovery.readiness}`
  );

  return {
    first: first.discovery,
    second: second.discovery,
    third: third.discovery,
    fourth: fourth.discovery,
    finalKind: fourth.discovery.final_kind,
    skillSubtype: fourth.discovery.skill_subtype,
    questionBand: [
      first.discovery.clarifying_questions.length,
      second.discovery.clarifying_questions.length,
      third.discovery.clarifying_questions.length,
      fourth.discovery.clarifying_questions.length,
    ],
    blockerCounts: [
      first.discovery.gap_plan?.counts.blockers ?? 0,
      second.discovery.gap_plan?.counts.blockers ?? 0,
      third.discovery.gap_plan?.counts.blockers ?? 0,
      fourth.discovery.gap_plan?.counts.blockers ?? 0,
    ],
    planTotals: [
      first.discovery.gap_plan?.counts.total ?? 0,
      second.discovery.gap_plan?.counts.total ?? 0,
      third.discovery.gap_plan?.counts.total ?? 0,
      fourth.discovery.gap_plan?.counts.total ?? 0,
    ],
    completionCounts: [
      first.diagnostics.callCount,
      second.diagnostics.callCount,
      third.diagnostics.callCount,
      fourth.diagnostics.callCount,
    ],
    transportAttemptCounts: [
      first.diagnostics.transportAttemptCount,
      second.diagnostics.transportAttemptCount,
      third.diagnostics.transportAttemptCount,
      fourth.diagnostics.transportAttemptCount,
    ],
    resultModelIds: [first.modelId, second.modelId, third.modelId, fourth.modelId],
  };
}

function assertOwnerRunStability(
  traces: readonly OwnerConversationTrace[]
): void {
  assert.ok(traces.length >= 1);
  const baseline = traces[0]!;
  for (const [index, trace] of traces.entries()) {
    assert.equal(
      trace.finalKind,
      baseline.finalKind,
      `owner run ${index + 1}: final_kind must be stable`
    );
    assert.equal(
      trace.skillSubtype,
      baseline.skillSubtype,
      `owner run ${index + 1}: skill_subtype must be stable`
    );
    for (let turn = 0; turn < 4; turn += 1) {
      assert.ok(
        trace.questionBand[turn]! >= 0 && trace.questionBand[turn]! <= 4,
        `owner run ${index + 1}: questions/turn within band 0-4`
      );
    }
    // Channel/tool/input separation already asserted per turn; re-check final.
    assertOwnerTurnSurfaces(`owner stability run ${index + 1}`, trace.fourth);
    assert.ok(
      trace.fourth.capability_needs.some((need) => need.provider_id === "gmail")
    );
    assert.ok(
      trace.fourth.capability_needs.every(
        (need) => need.provider_id !== "telegram_bot"
      )
    );
  }
  const kindSet = new Set(traces.map((trace) => trace.finalKind));
  assert.equal(kindSet.size, 1, "owner N-run: single final_kind");
}

async function maybeWriteArtifacts(
  label: string,
  payload: unknown
): Promise<void> {
  if (!process.argv.includes("--write-artifacts")) return;
  const dir = path.resolve(
    process.cwd(),
    "tmp",
    "authoring-discovery-eval"
  );
  await mkdir(dir, { recursive: true });
  const json = JSON.stringify(payload, null, 2);
  const hash = createHash("sha256").update(json).digest("hex").slice(0, 16);
  const file = path.join(dir, `${label}-${hash}.json`);
  await writeFile(file, json, "utf8");
  console.log(`wrote artifact ${file}`);
}

const repoRoot = path.resolve(process.cwd(), "../..");
loadWebEnvLocal(process.cwd());

async function runRecipientProvenanceEval(): Promise<void> {
  const cases = [
    {
      id: "route_without_provenance",
      answer: "La entrega se realizará por correo a la contraparte.",
      expected: "not_entailed" as const,
    },
    {
      id: "explicit_runtime_supply",
      answer:
        "En cada ejecución la persona operadora proporcionará la dirección concreta en la conversación.",
      expected: "entailed" as const,
    },
    {
      id: "conditional_runtime_supply",
      answer: OWNER_CONDITIONAL_RECIPIENT_ANSWER,
      expected: "entailed" as const,
    },
  ];
  for (const fixture of cases) {
    const result = await reviewRecipientProvenance({
      description: OWNER_DESCRIPTION,
      answers: [fixture.answer],
      discovery: {
        outbound_contract: {
          recipient_strategy: {
            kind: "operator_supplied_at_runtime",
            address_type: "email",
            label: "Dirección del destinatario",
            source_ref: {
              type: "input_requirement",
              key: "recipient_address",
            },
            evidence: [
              {
                source: "answer",
                answer_index: 0,
                quote: fixture.answer,
              },
            ],
          },
          approval: { approver: null, scope: [], evidence: [] },
          delivery: { mode: "unknown", evidence: [] },
        },
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
        capability_needs: [],
      },
    });
    if (fixture.expected === "entailed") {
      assert.equal(result.verdict, "entailed", fixture.id);
    } else {
      assert.notEqual(result.verdict, "entailed", fixture.id);
    }
    console.log(`✓ recipient provenance ${fixture.id}: ${result.verdict}`);
  }
}

async function main() {
  const benchmarkId =
    parseStringFlag("--benchmark-id") ??
    `authoring-discovery-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const discoveryModel = parseStringFlag("--discovery-model");
  const escalationModel = parseStringFlag("--escalation-model");
  const recipientProvenanceModel = parseStringFlag(
    "--recipient-provenance-model"
  );
  process.env.AI_USAGE_BENCHMARK_ID = benchmarkId;
  if (discoveryModel) {
    process.env.WORKFLOW_AUTHORING_DISCOVERY_MODEL_ID = discoveryModel;
  }
  if (escalationModel) {
    process.env.WORKFLOW_AUTHORING_ESCALATION_MODEL_ID = escalationModel;
  }
  if (recipientProvenanceModel) {
    process.env.WORKFLOW_AUTHORING_RECIPIENT_PROVENANCE_MODEL_ID =
      recipientProvenanceModel;
  }
  if (!process.env.OPENROUTER_API_KEY) {
    console.log(
      "authoring-discovery.eval: OPENROUTER_API_KEY absent — live eval not executed"
    );
    return;
  }
  await withCliAiUsageMetering(
    async () => {
      console.log(
        `benchmark=${benchmarkId} discovery_model=${
          process.env.WORKFLOW_AUTHORING_DISCOVERY_MODEL_ID ?? "(resolver default)"
        } escalation_model=${
          process.env.WORKFLOW_AUTHORING_ESCALATION_MODEL_ID ??
          "(resolver default)"
        }`
      );
      if (process.argv.includes("--recipient-provenance-only")) {
        await runRecipientProvenanceEval();
        return;
      }
      const ownerRuns = parsePositiveInt("--runs", 5);
      const ownerConcurrency = Math.min(
        ownerRuns,
        parsePositiveInt("--concurrency", 1)
      );
      const batteryRuns = parsePositiveInt("--battery-runs", 3);
      const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
      const limit = limitArg
        ? Number(limitArg.split("=")[1])
        : Number.POSITIVE_INFINITY;
      const startArg = process.argv.find((arg) => arg.startsWith("--start="));
      const start = startArg ? Number(startArg.split("=")[1]) : 0;
      const registry = await getGlobalSkillRegistry({ rootDirOverride: repoRoot });
      const skills = registry.list().map((skill) => skill.name);
      const tools = TOOL_CATALOG.map((tool) => tool.id);
      const conversationOnly = process.argv.includes("--conversation");

      if (conversationOnly || !process.argv.includes("--battery-only")) {
        const traces: OwnerConversationTrace[] = new Array(ownerRuns);
        const started = Date.now();
        let nextRun = 0;
        await Promise.all(
          Array.from({ length: ownerConcurrency }, async () => {
            while (nextRun < ownerRuns) {
              const run = nextRun;
              nextRun += 1;
              console.log(`owner conversation run ${run + 1}/${ownerRuns}`);
              traces[run] = await runOwnerConversation({ skills, tools });
            }
          })
        );
        assertOwnerRunStability(traces);
        await maybeWriteArtifacts("owner-conversation", {
          runs: ownerRuns,
          latencyMs: Date.now() - started,
          traces: traces.map((trace) => ({
            finalKind: trace.finalKind,
            skillSubtype: trace.skillSubtype,
            questionBand: trace.questionBand,
            blockerCounts: trace.blockerCounts,
            planTotals: trace.planTotals,
            completionCounts: trace.completionCounts,
            transportAttemptCounts: trace.transportAttemptCounts,
            resultModelIds: trace.resultModelIds,
            third: {
              readiness: trace.third.readiness,
              capability_needs: trace.third.capability_needs,
              input_requirements: trace.third.input_requirements,
              invocation_channels: trace.third.invocation_channels,
              gap_plan: trace.third.gap_plan,
            },
          })),
        });
        console.log(
          `✓ owner conversation N-run: ${ownerRuns} stable (${Date.now() - started}ms) · completions=${traces
            .flatMap((trace) => trace.completionCounts)
            .join(",")} · result_models=${[
            ...new Set(traces.flatMap((trace) => trace.resultModelIds)),
          ].join(",")}`
        );
        if (conversationOnly) return;
      }

      const fixtures = AUTHORING_BATTERY_FIXTURES.slice(start, start + limit);
      for (let run = 0; run < batteryRuns; run += 1) {
        console.log(`battery run ${run + 1}/${batteryRuns}`);
        for (const fixture of fixtures) {
          const signal = classifyAuthoringIntentDeterministic(
            fixture.description
          );
          assert.ok(signal, `${fixture.id}: router signal`);
          const result = await runAuthoringDiscovery({
            description: fixture.description,
            routerSignal: signal,
            catalogs: {
              skills,
              tools,
              integrations: [],
              assets: [],
              workerCapabilities: [],
            },
          });
          assert.equal(
            result.kind,
            "ok",
            `${fixture.id}: ${
              result.kind === "fail_closed" ? result.reason : "unexpected result"
            }`
          );
          if (result.kind !== "ok") continue;
          assert.equal(
            result.discovery.final_kind,
            fixture.expectedKind,
            `${fixture.id}: final kind`
          );
          if (fixture.expectedSkillSubtype) {
            assert.equal(
              result.discovery.skill_subtype,
              fixture.expectedSkillSubtype,
              `${fixture.id}: subtype`
            );
          }
          assertGapContract(fixture.id, result.discovery, [...skills, ...tools]);
          assertSurfaceSeparation(fixture.id, result.discovery);
          if (fixture.id === "owner_followup_message") {
            assert.equal(
              result.discovery.readiness,
              "needs_clarification",
              "battery #1 must ask for the source of history/latest agreement"
            );
            assert.ok(
              result.discovery.clarifying_questions.some((question) =>
                /fuente|sistema|historial|acuerdo|datos/i.test(question)
              ),
              "battery #1 must ask a business-language data-source question"
            );
            assert.ok(
              (result.discovery.clarifying_questions.length ?? 0) <= 4
            );
          }
          console.log(
            `✓ ${fixture.id}: ${result.discovery.final_kind} · ${result.discovery.readiness}`
          );
        }
      }
      console.log(
        `authoring-discovery.eval: ${fixtures.length} fixtures × ${batteryRuns} runs passed`
      );
    },
    { label: "authoring-discovery.eval" }
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
