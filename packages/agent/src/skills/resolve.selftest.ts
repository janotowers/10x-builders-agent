import assert from "node:assert/strict";
import { parseSkillSource } from "./parse";
import { buildRegistryFromRecords } from "./registry";
import { resolveSkill, SkillResolveError } from "./resolve";

function mk(
  slug: string,
  body: string,
  opts: {
    includes?: string[];
    tools?: string[];
    memoryExtraction?: "default" | "ephemeral";
  } = {}
) {
  const tools = opts.tools ?? [];
  const includes = opts.includes ?? [];
  const lines = [
    "---",
    `name: ${slug}`,
    `description: Test skill ${slug} with what and when guidance text.`,
    "scope: shared",
    "allowed_tools:",
    ...tools.map((t) => `  - ${t}`),
    "includes:",
    ...includes.map((i) => `  - ${i}`),
    `memory_extraction: ${opts.memoryExtraction ?? "default"}`,
    "---",
    "",
    body,
    "",
  ];
  return parseSkillSource(lines.join("\n"), `/r/skills/global/${slug}/SKILL.md`);
}

async function testSingleSkillNoIncludes(): Promise<void> {
  const a = mk("alpha", "Alpha body content.", { tools: ["t1", "t2"] });
  const reg = buildRegistryFromRecords([a]);
  const resolved = await resolveSkill("alpha", reg);
  assert.equal(resolved.rootName, "alpha");
  assert.deepEqual([...resolved.composedFrom], ["alpha"]);
  assert.ok(resolved.body.includes("Alpha body content."));
  assert.ok(resolved.body.startsWith("## Skill: alpha"));
  assert.deepEqual([...resolved.allowedTools], ["t1", "t2"]);
  assert.equal(resolved.memoryExtraction, "default");
  assert.ok(resolved.estimatedTokens > 0);
}

async function testCompositeChildBeforeRoot(): Promise<void> {
  const b = mk("beta", "Beta procedure.", { tools: ["b1", "shared"] });
  const a = mk("alpha", "Alpha procedure.", {
    tools: ["a1", "shared"],
    includes: ["beta"],
  });
  const reg = buildRegistryFromRecords([a, b]);
  const resolved = await resolveSkill("alpha", reg);
  assert.deepEqual([...resolved.composedFrom], ["beta", "alpha"]);
  const betaIdx = resolved.body.indexOf("Beta procedure.");
  const alphaIdx = resolved.body.indexOf("Alpha procedure.");
  assert.ok(
    betaIdx >= 0 && alphaIdx > betaIdx,
    "child body must appear before root"
  );
  assert.ok(resolved.body.includes("## Included skill: beta"));
  assert.ok(resolved.body.includes("## Skill: alpha"));
  assert.deepEqual([...resolved.allowedTools], ["b1", "shared", "a1"]);
}

async function testDiamondDedup(): Promise<void> {
  const d = mk("d", "D body.", { tools: ["dt"] });
  const b = mk("b", "B body.", { tools: ["bt"], includes: ["d"] });
  const c = mk("c", "C body.", { tools: ["ct"], includes: ["d"] });
  const a = mk("a", "A body.", { tools: ["at"], includes: ["b", "c"] });
  const reg = buildRegistryFromRecords([a, b, c, d]);
  const resolved = await resolveSkill("a", reg);
  const occurrences = (resolved.body.match(/D body\./g) ?? []).length;
  assert.equal(occurrences, 1, "diamond child should appear exactly once");
  assert.deepEqual([...resolved.allowedTools], ["dt", "bt", "ct", "at"]);
}

async function testCycleRejected(): Promise<void> {
  const a = mk("a", "A.", { includes: ["b"] });
  const b = mk("b", "B.", { includes: ["a"] });
  const reg = buildRegistryFromRecords([a, b]);
  let thrown: unknown;
  try {
    await resolveSkill("a", reg);
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown instanceof SkillResolveError, "expected SkillResolveError");
  assert.match((thrown as Error).message, /cycle/i);
  assert.match((thrown as Error).message, /->/);
}

async function testSelfCycleRejected(): Promise<void> {
  const a = mk("a", "A.", { includes: ["a"] });
  const reg = buildRegistryFromRecords([a]);
  let thrown: unknown;
  try {
    await resolveSkill("a", reg);
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown instanceof SkillResolveError);
  assert.match((thrown as Error).message, /cycle/i);
}

async function testUnknownRoot(): Promise<void> {
  const reg = buildRegistryFromRecords([]);
  let thrown: unknown;
  try {
    await resolveSkill("missing", reg);
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown instanceof SkillResolveError);
  assert.match((thrown as Error).message, /unknown skill/i);
}

async function testUnknownChild(): Promise<void> {
  const a = mk("a", "A body.", { includes: ["ghost"] });
  const reg = buildRegistryFromRecords([a]);
  let thrown: unknown;
  try {
    await resolveSkill("a", reg);
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown instanceof SkillResolveError);
  assert.match((thrown as Error).message, /unknown skill 'ghost'/);
}

async function testComposedBodyCap(): Promise<void> {
  const big = "x".repeat(14_000);
  const a = mk("a", big, { includes: ["b"] });
  const b = mk("b", big);
  const reg = buildRegistryFromRecords([a, b]);
  let thrown: unknown;
  try {
    await resolveSkill("a", reg);
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown instanceof SkillResolveError);
  assert.match((thrown as Error).message, /5000-token cap/);
}

async function testToolDedupOrder(): Promise<void> {
  const c = mk("c", "C.", { tools: ["x", "y"] });
  const b = mk("b", "B.", { tools: ["y", "z"], includes: ["c"] });
  const a = mk("a", "A.", { tools: ["w", "x"], includes: ["b"] });
  const reg = buildRegistryFromRecords([a, b, c]);
  const resolved = await resolveSkill("a", reg);
  assert.deepEqual([...resolved.allowedTools], ["x", "y", "z", "w"]);
}

async function testEphemeralComposesFromChild(): Promise<void> {
  const child = mk("child", "Child.", { memoryExtraction: "ephemeral" });
  const root = mk("root", "Root.", { includes: ["child"] });
  const reg = buildRegistryFromRecords([root, child]);
  const resolved = await resolveSkill("root", reg);
  assert.equal(resolved.memoryExtraction, "ephemeral");
}

async function main(): Promise<void> {
  await testSingleSkillNoIncludes();
  await testCompositeChildBeforeRoot();
  await testDiamondDedup();
  await testCycleRejected();
  await testSelfCycleRejected();
  await testUnknownRoot();
  await testUnknownChild();
  await testComposedBodyCap();
  await testToolDedupOrder();
  await testEphemeralComposesFromChild();
  console.log("skills/resolve.selftest: all 10 cases passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
