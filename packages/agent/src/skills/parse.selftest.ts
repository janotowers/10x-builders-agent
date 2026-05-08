import assert from "node:assert/strict";
import * as path from "node:path";
import {
  parseSkillSource,
  SkillParseError,
  estimateTokens,
  MAX_DESCRIPTION_CHARS,
} from "./parse";

const FIXTURE_PATH = "/repo/skills/global/sample/SKILL.md";

function makeFront(extra: string): string {
  return [
    "---",
    "name: sample",
    "description: Sample skill description with what and when guidance.",
    extra,
    "---",
    "",
    "# Sample body",
    "",
    "Hello.",
    "",
  ].join("\n");
}

function expectThrows(
  fn: () => void,
  match: string | RegExp,
  label: string
): void {
  let thrown: unknown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, `${label}: expected an error`);
  assert.ok(
    thrown instanceof SkillParseError,
    `${label}: not a SkillParseError`
  );
  const msg = (thrown as Error).message;
  if (typeof match === "string") {
    assert.ok(
      msg.includes(match),
      `${label}: '${msg}' does not include '${match}'`
    );
  } else {
    assert.match(msg, match, label);
  }
}

function testHappyPath(): void {
  const src = [
    "---",
    "name: sample",
    "description: A skill that explains what it does and when to use it.",
    "scope: business",
    "allowed_tools:",
    "  - get_user_preferences",
    "  - calendar_list_events",
    "includes: []",
    "memory_extraction: ephemeral",
    "guardrails: |",
    "  Read-only.",
    "  Never schedule sends.",
    "---",
    "",
    "# Body",
    "",
    "Procedure goes here.",
    "",
  ].join("\n");
  const rec = parseSkillSource(src, FIXTURE_PATH);
  assert.equal(rec.metadata.name, "sample");
  assert.equal(rec.metadata.scope, "business");
  assert.deepEqual(
    [...rec.metadata.allowedTools],
    ["get_user_preferences", "calendar_list_events"]
  );
  assert.deepEqual([...rec.metadata.includes], []);
  assert.equal(rec.metadata.memoryExtraction, "ephemeral");
  assert.equal(rec.metadata.heartbeatMode, "compatible");
  assert.ok(rec.metadata.guardrails?.includes("Read-only"));
  assert.equal(rec.metadata.sourcePath, FIXTURE_PATH);
}

function testDefaults(): void {
  const src = makeFront("");
  const rec = parseSkillSource(src, FIXTURE_PATH);
  assert.equal(rec.metadata.scope, "shared");
  assert.deepEqual([...rec.metadata.allowedTools], []);
  assert.deepEqual([...rec.metadata.includes], []);
  assert.equal(rec.metadata.guardrails, null);
  // V1-C-α: requires_tenant_context defaults to false.
  assert.equal(rec.metadata.requiresTenantContext, false);
  assert.equal(rec.metadata.memoryExtraction, "default");
  assert.equal(rec.metadata.heartbeatMode, "compatible");
}

function testHeartbeatModeNative(): void {
  const rec = parseSkillSource(makeFront("heartbeat: native"), FIXTURE_PATH);
  assert.equal(rec.metadata.heartbeatMode, "native");
}

function testHeartbeatModeRejectsUnknownValue(): void {
  expectThrows(
    () => parseSkillSource(makeFront("heartbeat: noisy"), FIXTURE_PATH),
    /heartbeat/,
    "heartbeat rejects unknown value"
  );
}

function testRequiresTenantContextTrue(): void {
  const src = makeFront("requires_tenant_context: true");
  const rec = parseSkillSource(src, FIXTURE_PATH);
  assert.equal(rec.metadata.requiresTenantContext, true);
}

function testRequiresTenantContextRejectsString(): void {
  expectThrows(
    () =>
      parseSkillSource(
        makeFront('requires_tenant_context: "yes"'),
        FIXTURE_PATH
      ),
    /requires_tenant_context/,
    "requires_tenant_context rejects string"
  );
}

function testMemoryExtractionRejectsUnknownValue(): void {
  expectThrows(
    () => parseSkillSource(makeFront("memory_extraction: durable"), FIXTURE_PATH),
    /memory_extraction/,
    "memory_extraction rejects unknown value"
  );
}

function testInlineArray(): void {
  const src = makeFront("allowed_tools: [foo, bar]");
  const rec = parseSkillSource(src, FIXTURE_PATH);
  assert.deepEqual([...rec.metadata.allowedTools], ["foo", "bar"]);
}

async function testLazyBody(): Promise<void> {
  const src = makeFront("");
  const rec = parseSkillSource(src, FIXTURE_PATH);
  const body = await rec.loadBody();
  assert.ok(body.startsWith("# Sample body"));
}

function testInvalidNameRegex(): void {
  expectThrows(
    () =>
      parseSkillSource(
        makeFront("").replace("name: sample", "name: Sample-Bad"),
        FIXTURE_PATH
      ),
    "name must match",
    "invalid name regex"
  );
}

function testForbiddenName(): void {
  const src = ["---", "name: claude-helper", "description: forbidden", "---", ""].join(
    "\n"
  );
  expectThrows(
    () =>
      parseSkillSource(src, "/repo/skills/global/claude-helper/SKILL.md"),
    "must not contain",
    "forbidden name fragment"
  );
}

function testDescriptionTooLong(): void {
  const longDesc = "x".repeat(MAX_DESCRIPTION_CHARS + 1);
  const src = ["---", "name: sample", `description: ${longDesc}`, "---", ""].join(
    "\n"
  );
  expectThrows(
    () => parseSkillSource(src, FIXTURE_PATH),
    "<= 1024 chars",
    "description too long"
  );
}

function testMissingDescription(): void {
  const src = ["---", "name: sample", "---", ""].join("\n");
  expectThrows(
    () => parseSkillSource(src, FIXTURE_PATH),
    "description",
    "missing description"
  );
}

function testInvalidScope(): void {
  const src = makeFront("scope: weird");
  expectThrows(
    () => parseSkillSource(src, FIXTURE_PATH),
    "scope",
    "invalid scope"
  );
}

function testNameSlugMismatch(): void {
  const src = makeFront("");
  expectThrows(
    () =>
      parseSkillSource(src, "/repo/skills/global/other-slug/SKILL.md"),
    "must match directory",
    "name vs slug mismatch"
  );
}

function testMissingFrontmatter(): void {
  const src = "# No frontmatter\n\nbody only\n";
  expectThrows(
    () => parseSkillSource(src, FIXTURE_PATH),
    "frontmatter",
    "missing frontmatter"
  );
}

function testUnterminatedInlineArray(): void {
  const src = makeFront("allowed_tools: [foo, bar");
  expectThrows(
    () => parseSkillSource(src, FIXTURE_PATH),
    /array|frontmatter/,
    "unterminated inline array"
  );
}

function testUnknownFrontmatterKey(): void {
  const src = makeFront("scop: business");
  expectThrows(
    () => parseSkillSource(src, FIXTURE_PATH),
    /Unrecognized|invalid|scop/i,
    "unknown frontmatter key"
  );
}

function testBodyTooLarge(): void {
  const huge = "a".repeat(40_000);
  const src = makeFront("") + huge;
  expectThrows(
    () => parseSkillSource(src, FIXTURE_PATH),
    "5000-token cap",
    "body too large"
  );
}

function testEstimateTokens(): void {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("a".repeat(40)), 10);
}

function testCRLF(): void {
  const src = [
    "---",
    "name: sample",
    "description: works with windows line endings",
    "---",
    "",
    "# body",
    "",
  ].join("\r\n");
  const rec = parseSkillSource(src, FIXTURE_PATH);
  assert.equal(rec.metadata.name, "sample");
}

function testCommentsSkipped(): void {
  const src = [
    "---",
    "# this is a comment",
    "name: sample",
    "description: skill with comment in frontmatter",
    "# another comment",
    "scope: personal",
    "---",
    "",
  ].join("\n");
  const rec = parseSkillSource(src, FIXTURE_PATH);
  assert.equal(rec.metadata.scope, "personal");
}

function testRelativePath(): void {
  const rec = parseSkillSource(
    makeFront(""),
    path.join("relative", "skills", "global", "sample", "SKILL.md")
  );
  assert.equal(rec.metadata.name, "sample");
}

async function main(): Promise<void> {
  testHappyPath();
  testDefaults();
  testRequiresTenantContextTrue();
  testRequiresTenantContextRejectsString();
  testMemoryExtractionRejectsUnknownValue();
  testHeartbeatModeNative();
  testHeartbeatModeRejectsUnknownValue();
  testInlineArray();
  await testLazyBody();
  testInvalidNameRegex();
  testForbiddenName();
  testDescriptionTooLong();
  testMissingDescription();
  testInvalidScope();
  testNameSlugMismatch();
  testMissingFrontmatter();
  testUnterminatedInlineArray();
  testUnknownFrontmatterKey();
  testBodyTooLarge();
  testEstimateTokens();
  testCRLF();
  testCommentsSkipped();
  testRelativePath();
  console.log("skills/parse.selftest: all 23 cases passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
