/**
 * Eval live de discovery. Carga apps/web/.env.local con Node >=20.
 *
 * Run:
 *   npx tsx src/lib/workflow-studio/authoring-discovery.eval.ts
 *   npx tsx src/lib/workflow-studio/authoring-discovery.eval.ts --conversation
 *   npx tsx src/lib/workflow-studio/authoring-discovery.eval.ts --conversation --runs=5
 *   npx tsx src/lib/workflow-studio/authoring-discovery.eval.ts --conversation --runs=5 --concurrency=5
 *   npx tsx src/lib/workflow-studio/authoring-discovery.eval.ts --battery-runs=3
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

const OWNER_DESCRIPTION =
  "Cada vez que prepares un mensaje de seguimiento para un propietario, resume el último acuerdo, usa un tono cordial y profesional y termina proponiendo una siguiente acción concreta. Nunca inventes compromisos, fechas ni información de la propiedad.";

const OWNER_ANSWER_1 = `Esta en un documento word usualmente aunque podría tener también otro formato, como texto por ejemplo.
Gu debe entregar un borrador en texto y también en archivo para que el usuario lo revise y pueda ajustarlo. Si lo aprueba, Gu debe enviarlo por email al propietario y confirmar el envío.
Este procedimiento solo es para propietarios de inmuebles que representamos o vamos a representar comercialmente. Actualmente los propietarios no se tienen en el sistema/cuenta.`;

const OWNER_ANSWER_2 =
  "El resultado correcto es un email enviado al propietario con un mensaje atractivo, un llamado a la acción concreto, datos fieles al documento y confirmación del envío.";

type DiscoveryOk = Extract<
  Awaited<ReturnType<typeof runAuthoringDiscovery>>,
  { kind: "ok" }
>;

interface OwnerConversationTrace {
  first: DiscoveryOk["discovery"];
  second: DiscoveryOk["discovery"];
  third: DiscoveryOk["discovery"];
  finalKind: string;
  skillSubtype: string | undefined;
  questionBand: number[];
  blockerCounts: number[];
  planTotals: number[];
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
    values: [OWNER_DESCRIPTION, OWNER_ANSWER_1, OWNER_ANSWER_2],
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
    first.kind === "fail_closed" ? first.reason : "first turn"
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
    second.kind === "fail_closed" ? second.reason : "second turn"
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

  // Dependent gaps may unlock after the source answer; plan must stay monotonic
  // in the sense that previously asked/resolved ids are not reopened as open.
  const firstAskedIds = new Set(
    first.discovery.clarifying_question_details
      .map((detail) => detail.gap_id)
      .filter((id): id is string => Boolean(id))
  );
  for (const gap of second.discovery.gap_plan?.gaps ?? []) {
    if (firstAskedIds.has(gap.id) && gap.state === "open") {
      assert.fail(
        `owner second turn: previously asked gap ${gap.id} must not reopen as open`
      );
    }
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
    third.kind === "fail_closed" ? third.reason : "third turn"
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

  // Blocker-aware checkpoint: while blockers remain, proposal preparation is denied.
  const checkpoint = resolveAuthoringConversationTurn({
    discovery: third.discovery,
    answerTurnCount: AUTHORING_SOFT_CHECKPOINT_TURN,
  });
  if ((third.discovery.gap_plan?.counts.blockers ?? 0) > 0) {
    assert.equal(checkpoint.meta.allow_proceed_to_proposal, false);
    assert.match(checkpoint.meta.human_message ?? "", /Queda \d+ decisión/i);
    const proceeded = proceedAuthoringDiscoveryToProposal({
      discovery: third.discovery,
      answerTurnCount: AUTHORING_SOFT_CHECKPOINT_TURN,
    });
    assert.equal(proceeded.ok, false);
  }

  console.log(
    `✓ owner conversation: ${first.discovery.readiness} → ${second.discovery.readiness} → ${third.discovery.readiness}`
  );

  return {
    first: first.discovery,
    second: second.discovery,
    third: third.discovery,
    finalKind: third.discovery.final_kind,
    skillSubtype: third.discovery.skill_subtype,
    questionBand: [
      first.discovery.clarifying_questions.length,
      second.discovery.clarifying_questions.length,
      third.discovery.clarifying_questions.length,
    ],
    blockerCounts: [
      first.discovery.gap_plan?.counts.blockers ?? 0,
      second.discovery.gap_plan?.counts.blockers ?? 0,
      third.discovery.gap_plan?.counts.blockers ?? 0,
    ],
    planTotals: [
      first.discovery.gap_plan?.counts.total ?? 0,
      second.discovery.gap_plan?.counts.total ?? 0,
      third.discovery.gap_plan?.counts.total ?? 0,
    ],
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
    for (let turn = 0; turn < 3; turn += 1) {
      assert.ok(
        trace.questionBand[turn]! >= 0 && trace.questionBand[turn]! <= 4,
        `owner run ${index + 1}: questions/turn within band 0-4`
      );
    }
    // Channel/tool/input separation already asserted per turn; re-check final.
    assertOwnerTurnSurfaces(`owner stability run ${index + 1}`, trace.third);
    assert.ok(
      trace.third.capability_needs.some((need) => need.provider_id === "gmail")
    );
    assert.ok(
      trace.third.capability_needs.every(
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

async function main() {
  if (!process.env.OPENROUTER_API_KEY) {
    console.log(
      "authoring-discovery.eval: OPENROUTER_API_KEY absent — live eval not executed"
    );
    return;
  }
  await withCliAiUsageMetering(
    async () => {
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
          `✓ owner conversation N-run: ${ownerRuns} stable (${Date.now() - started}ms)`
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
