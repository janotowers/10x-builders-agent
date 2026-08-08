/**
 * Eval live de discovery. Carga apps/web/.env.local con Node >=20.
 *
 * Run:
 *   npx tsx src/lib/workflow-studio/authoring-discovery.eval.ts
 *   npx tsx src/lib/workflow-studio/authoring-discovery.eval.ts --limit=2
 *   npx tsx src/lib/workflow-studio/authoring-discovery.eval.ts --start=4 --limit=1
 */
import assert from "node:assert/strict";
import path from "node:path";
import {
  getGlobalSkillRegistry,
  TOOL_CATALOG,
} from "@agents/agent";
import {
  AUTHORING_BATTERY_FIXTURES,
  buildAuthoringDiscoveryCompactState,
  classifyAuthoringIntentDeterministic,
} from "@agents/workflows";
import {
  loadWebEnvLocal,
  withCliAiUsageMetering,
} from "../ai-usage/cli-metering";
import { runAuthoringDiscovery } from "./authoring-discovery";

const OWNER_DESCRIPTION =
  "Cada vez que prepares un mensaje de seguimiento para un propietario, resume el último acuerdo, usa un tono cordial y profesional y termina proponiendo una siguiente acción concreta. Nunca inventes compromisos, fechas ni información de la propiedad.";

const OWNER_ANSWER_1 = `Esta en un documento word usualmente aunque podría tener también otro formato, como texto por ejemplo.
Gu debe entregar un borrador en texto y también en archivo para que el usuario lo revise y pueda ajustarlo. Si lo aprueba, Gu debe enviarlo por email al propietario y confirmar el envío.
Este procedimiento solo es para propietarios de inmuebles que representamos o vamos a representar comercialmente. Actualmente los propietarios no se tienen en el sistema/cuenta.`;

const OWNER_ANSWER_2 =
  "El resultado correcto es un email enviado al propietario con un mensaje atractivo, un llamado a la acción concreto, datos fieles al documento y confirmación del envío.";

async function runOwnerConversation(params: {
  skills: string[];
  tools: string[];
}): Promise<void> {
  const signal = classifyAuthoringIntentDeterministic(OWNER_DESCRIPTION);
  assert.ok(signal);
  const catalogs = {
    skills: params.skills,
    tools: params.tools,
    integrations: [],
    assets: [],
    workerCapabilities: [],
  };

  const first = await runAuthoringDiscovery({
    description: OWNER_DESCRIPTION,
    routerSignal: signal,
    catalogs,
  });
  assert.equal(
    first.kind,
    "ok",
    first.kind === "fail_closed" ? first.reason : "first turn"
  );
  assert.equal(first.discovery.readiness, "needs_clarification");
  assert.ok(first.discovery.clarifying_question_details.length > 0);
  assert.ok(
    first.discovery.clarifying_question_details.some(
      (detail) => detail.examples.length > 0
    ),
    "at least one abstract question should include contextual examples"
  );

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
  });
  assert.equal(
    third.kind,
    "ok",
    third.kind === "fail_closed" ? third.reason : "third turn"
  );
  assert.notEqual(third.discovery.readiness, "blocked_reformulate");
  console.log(
    `✓ owner conversation: ${first.discovery.readiness} → ${second.discovery.readiness} → ${third.discovery.readiness}`
  );
}

const repoRoot = path.resolve(process.cwd(), "../..");
loadWebEnvLocal(process.cwd());

async function main() {
  assert.ok(
    process.env.OPENROUTER_API_KEY,
    "OPENROUTER_API_KEY required for model-backed eval"
  );
  await withCliAiUsageMetering(
    async () => {
      const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
      const limit = limitArg
        ? Number(limitArg.split("=")[1])
        : Number.POSITIVE_INFINITY;
      const startArg = process.argv.find((arg) => arg.startsWith("--start="));
      const start = startArg ? Number(startArg.split("=")[1]) : 0;
      const registry = await getGlobalSkillRegistry({ rootDirOverride: repoRoot });
      const skills = registry.list().map((skill) => skill.name);
      const tools = TOOL_CATALOG.map((tool) => tool.id);
      if (process.argv.includes("--conversation")) {
        await runOwnerConversation({ skills, tools });
        return;
      }
      const fixtures = AUTHORING_BATTERY_FIXTURES.slice(start, start + limit);

      for (const fixture of fixtures) {
        const signal = classifyAuthoringIntentDeterministic(fixture.description);
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
        }
        console.log(
          `✓ ${fixture.id}: ${result.discovery.final_kind} · ${result.discovery.readiness}`
        );
      }
      console.log(
        `authoring-discovery.eval: ${fixtures.length} live cases passed`
      );
    },
    { label: "authoring-discovery.eval" }
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
