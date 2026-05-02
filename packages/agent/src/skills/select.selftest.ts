import assert from "node:assert/strict";
import type { BaseMessage } from "@langchain/core/messages";
import { parseSkillSource } from "./parse";
import { buildRegistryFromRecords } from "./registry";
import {
  parseSelectorJson,
  selectSkillForTurn,
  type SelectorChatModel,
  type SelectionNoneReason,
} from "./select";

function mkSkill(slug: string, description: string, tools: string[] = []) {
  const lines = [
    "---",
    `name: ${slug}`,
    `description: ${description}`,
    "scope: shared",
    "allowed_tools:",
    ...tools.map((t) => `  - ${t}`),
    "includes: []",
    "---",
    "",
    `Body for ${slug}.`,
    "",
  ];
  return parseSkillSource(lines.join("\n"), `/r/skills/global/${slug}/SKILL.md`);
}

function stubModel(replies: string[]): SelectorChatModel & { calls: BaseMessage[][] } {
  const queue = [...replies];
  const calls: BaseMessage[][] = [];
  return {
    calls,
    async invoke(messages: BaseMessage[]) {
      calls.push(messages);
      const next = queue.shift() ?? "";
      return { content: next };
    },
  };
}

function failingModel(err: Error): SelectorChatModel {
  return {
    async invoke() {
      throw err;
    },
  };
}

// ── parseSelectorJson ───────────────────────────────────────────

function testParseStrictJson(): void {
  assert.equal(parseSelectorJson('{"skill":"alpha"}'), "alpha");
  assert.equal(parseSelectorJson('{ "skill" : "beta" }'), "beta");
  assert.equal(parseSelectorJson('{"skill":"none"}'), "none");
}

function testParseToleratesFences(): void {
  assert.equal(parseSelectorJson('```json\n{"skill":"alpha"}\n```'), "alpha");
  assert.equal(parseSelectorJson('```\n{"skill":"alpha"}\n```'), "alpha");
}

function testParseToleratesProseWrap(): void {
  assert.equal(
    parseSelectorJson('Here is your answer: {"skill":"alpha"} thanks.'),
    "alpha"
  );
}

function testParseRejectsBadShape(): void {
  assert.equal(parseSelectorJson(""), null);
  assert.equal(parseSelectorJson("not json"), null);
  assert.equal(parseSelectorJson("{}"), null);
  assert.equal(parseSelectorJson('{"skill": 123}'), null);
  assert.equal(parseSelectorJson('{"skill": ""}'), null);
  assert.equal(parseSelectorJson('{"other": "alpha"}'), null);
}

// ── selectSkillForTurn ─────────────────────────────────────────

async function testEmptyMessageReturnsNone(): Promise<void> {
  const reg = buildRegistryFromRecords([
    mkSkill("alpha", "Alpha skill. Use when foo."),
  ]);
  const model = stubModel(['{"skill":"alpha"}']);
  const decisions: Array<{ kind: string; reason?: SelectionNoneReason }> = [];
  const result = await selectSkillForTurn({
    userMessage: "   ",
    registry: reg,
    model,
    onDecision: (d) => decisions.push(d),
  });
  assert.equal(result.kind, "none");
  if (result.kind === "none") {
    assert.equal(result.reason, "empty_message");
  }
  assert.equal(model.calls.length, 0, "model must not be called when message is empty");
  assert.equal(decisions.length, 1);
}

async function testEmptyRegistryReturnsNone(): Promise<void> {
  const reg = buildRegistryFromRecords([]);
  const model = stubModel(['{"skill":"alpha"}']);
  const result = await selectSkillForTurn({
    userMessage: "hola",
    registry: reg,
    model,
  });
  assert.equal(result.kind, "none");
  if (result.kind === "none") {
    assert.equal(result.reason, "empty_registry");
  }
  assert.equal(model.calls.length, 0);
}

async function testSelectsSkillWhenModelAgrees(): Promise<void> {
  const a = mkSkill(
    "company-data",
    "Answer questions backed by warehouse data. Use when the user asks for counts, KPIs, trends, or any business metric.",
    ["bigquery_run_query", "get_user_preferences"]
  );
  const b = mkSkill("daily-briefing", "Daily summary. Use when user asks for a briefing.");
  const reg = buildRegistryFromRecords([a, b]);
  const model = stubModel(['{"skill":"company-data"}']);

  const result = await selectSkillForTurn({
    userMessage: "Cuántos leads tuvimos en marzo?",
    registry: reg,
    model,
  });

  assert.equal(result.kind, "active");
  if (result.kind === "active") {
    assert.equal(result.skillId, "company-data");
    assert.ok(result.resolved.body.includes("Body for company-data."));
    assert.deepEqual(
      [...result.resolved.allowedTools],
      ["bigquery_run_query", "get_user_preferences"]
    );
  }
}

async function testNoneOnGreeting(): Promise<void> {
  const reg = buildRegistryFromRecords([
    mkSkill("company-data", "Warehouse questions. Use when KPIs."),
  ]);
  const model = stubModel(['{"skill":"none"}']);
  const result = await selectSkillForTurn({
    userMessage: "hola, buenos dias",
    registry: reg,
    model,
  });
  assert.equal(result.kind, "none");
  if (result.kind === "none") {
    assert.equal(result.reason, "model_returned_none");
  }
}

async function testInvalidJsonFallsBackToNone(): Promise<void> {
  const reg = buildRegistryFromRecords([
    mkSkill("alpha", "Alpha. Use when foo."),
  ]);
  const model = stubModel(["lol I don't know"]);
  const result = await selectSkillForTurn({
    userMessage: "do the foo thing",
    registry: reg,
    model,
  });
  assert.equal(result.kind, "none");
  if (result.kind === "none") {
    assert.equal(result.reason, "model_invalid_output");
  }
}

async function testHallucinatedSlugFallsBackToNone(): Promise<void> {
  const reg = buildRegistryFromRecords([
    mkSkill("alpha", "Alpha. Use when foo."),
  ]);
  const model = stubModel(['{"skill":"ghost-skill"}']);
  const result = await selectSkillForTurn({
    userMessage: "do something",
    registry: reg,
    model,
  });
  assert.equal(result.kind, "none");
  if (result.kind === "none") {
    assert.equal(result.reason, "model_unknown_skill");
  }
}

async function testModelErrorFallsBackToNone(): Promise<void> {
  const reg = buildRegistryFromRecords([
    mkSkill("alpha", "Alpha. Use when foo."),
  ]);
  const model = failingModel(new Error("network down"));
  const result = await selectSkillForTurn({
    userMessage: "hi",
    registry: reg,
    model,
  });
  assert.equal(result.kind, "none");
  if (result.kind === "none") {
    assert.equal(result.reason, "model_call_failed");
  }
}

async function testCandidateFilterRespected(): Promise<void> {
  const a = mkSkill("alpha", "Alpha. Use when foo.");
  const b = mkSkill("beta", "Beta. Use when bar.");
  const reg = buildRegistryFromRecords([a, b]);

  // Restrict to only alpha. Even if the model picks beta, we treat it as
  // unknown because it is not in the candidate set.
  const model = stubModel(['{"skill":"beta"}']);
  const result = await selectSkillForTurn({
    userMessage: "do bar",
    registry: reg,
    model,
    candidateSlugs: ["alpha"],
  });
  assert.equal(result.kind, "none");
  if (result.kind === "none") {
    assert.equal(result.reason, "model_unknown_skill");
  }

  // Confirm prompt only included alpha (the model would never see beta).
  const promptText = String(model.calls[0]?.[1]?.content ?? "");
  assert.ok(promptText.includes("alpha"), "candidate alpha should be listed");
  assert.ok(!promptText.includes("beta"), "non-candidate beta should not be listed");
}

async function testPromptIncludesChannelWhenProvided(): Promise<void> {
  const a = mkSkill("alpha", "Alpha. Use when foo.");
  const reg = buildRegistryFromRecords([a]);
  const model = stubModel(['{"skill":"none"}']);
  await selectSkillForTurn({
    userMessage: "hi",
    registry: reg,
    model,
    channel: "telegram",
  });
  const promptText = String(model.calls[0]?.[1]?.content ?? "");
  assert.ok(/Channel:\s*telegram/.test(promptText));
}

async function testPromptIncludesRoutingContextWhenProvided(): Promise<void> {
  const a = mkSkill("company-data", "Warehouse questions. Use when KPIs.");
  const reg = buildRegistryFromRecords([a]);
  const model = stubModel(['{"skill":"company-data"}']);
  await selectSkillForTurn({
    userMessage: "y en febrero?",
    registry: reg,
    model,
    routingContext: {
      currentMessage: "y en febrero?",
      isContinuation: true,
      lastActiveSkill: "company-data",
      lastDomain: "leads",
      lastMetric: "count",
      lastPeriod: "abril 2026",
      lastTenantName: "Alebrixe",
      recentTurnSummary: "Recent leads turn for abril 2026",
      evidence: ["user: cuantos leads tuvimos en abril?"],
      confidence: "high",
    },
  });
  const promptText = String(model.calls[0]?.[1]?.content ?? "");
  assert.ok(promptText.includes("Routing context"));
  assert.ok(promptText.includes('"lastActiveSkill": "company-data"'));
  assert.ok(promptText.includes('"lastDomain": "leads"'));
}

async function main(): Promise<void> {
  testParseStrictJson();
  testParseToleratesFences();
  testParseToleratesProseWrap();
  testParseRejectsBadShape();
  await testEmptyMessageReturnsNone();
  await testEmptyRegistryReturnsNone();
  await testSelectsSkillWhenModelAgrees();
  await testNoneOnGreeting();
  await testInvalidJsonFallsBackToNone();
  await testHallucinatedSlugFallsBackToNone();
  await testModelErrorFallsBackToNone();
  await testCandidateFilterRespected();
  await testPromptIncludesChannelWhenProvided();
  await testPromptIncludesRoutingContextWhenProvided();
  console.log("skills/select.selftest: all 14 cases passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
