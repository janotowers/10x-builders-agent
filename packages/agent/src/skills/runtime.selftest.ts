import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  defaultSkillsRoot,
  getCachedSkillsRegistryRoot,
  getGlobalSkillRegistry,
  overlaySkillRegistryForTurn,
  resetGlobalSkillRegistryForTests,
  SkillUnderTestValidationError,
} from "./runtime";

async function makeRootWithSkill(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skills-runtime-"));
  const skillDir = path.join(dir, "skills", "global", "alpha");
  await fs.mkdir(skillDir, { recursive: true });
  const text = [
    "---",
    "name: alpha",
    "description: First skill description with what and when guidance.",
    "scope: business",
    "---",
    "",
    "Alpha body.",
  ].join("\n");
  await fs.writeFile(path.join(skillDir, "SKILL.md"), text, "utf8");
  return dir;
}

async function testEnvOverride(): Promise<void> {
  const root = await makeRootWithSkill();
  const prev = process.env.SKILLS_ROOT_DIR;
  process.env.SKILLS_ROOT_DIR = root;
  try {
    const resolved = defaultSkillsRoot();
    assert.equal(resolved, root, "env var should win over auto-discovery");
  } finally {
    if (prev === undefined) delete process.env.SKILLS_ROOT_DIR;
    else process.env.SKILLS_ROOT_DIR = prev;
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testEnvOverrideRelative(): Promise<void> {
  const root = await makeRootWithSkill();
  const prev = process.env.SKILLS_ROOT_DIR;
  const prevCwd = process.cwd();
  process.chdir(path.dirname(root));
  process.env.SKILLS_ROOT_DIR = path.basename(root);
  try {
    const resolved = defaultSkillsRoot();
    assert.equal(
      resolved,
      path.resolve(path.dirname(root), path.basename(root))
    );
  } finally {
    if (prev === undefined) delete process.env.SKILLS_ROOT_DIR;
    else process.env.SKILLS_ROOT_DIR = prev;
    process.chdir(prevCwd);
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testResolvedRootHasSkillsGlobal(): Promise<void> {
  const prev = process.env.SKILLS_ROOT_DIR;
  delete process.env.SKILLS_ROOT_DIR;
  try {
    const resolved = defaultSkillsRoot();
    const skillsGlobal = path.join(resolved, "skills", "global");
    assert.ok(
      await fs
        .stat(skillsGlobal)
        .then((s) => s.isDirectory())
        .catch(() => false),
      `defaultSkillsRoot returned ${resolved} but ${skillsGlobal} is missing`
    );
  } finally {
    if (prev !== undefined) process.env.SKILLS_ROOT_DIR = prev;
  }
}

async function testCachedRootAfterLoad(): Promise<void> {
  resetGlobalSkillRegistryForTests();
  const root = await makeRootWithSkill();
  try {
    assert.equal(
      getCachedSkillsRegistryRoot(),
      null,
      "no load yet → cached root is null"
    );
    const reg = await getGlobalSkillRegistry({ rootDirOverride: root });
    assert.equal(reg.size, 1);
    assert.equal(getCachedSkillsRegistryRoot(), root);
  } finally {
    resetGlobalSkillRegistryForTests();
    await fs.rm(root, { recursive: true, force: true });
  }
}

function draftSkillSource(slug: string, body: string): string {
  return [
    "---",
    `name: ${slug}`,
    "description: Draft skill used only for qualification.",
    "scope: business",
    "allowed_tools:",
    "  - qualification_tool",
    "---",
    "",
    body,
  ].join("\n");
}

async function testDraftOverlayPrecedence(): Promise<void> {
  resetGlobalSkillRegistryForTests();
  const root = await makeRootWithSkill();
  try {
    const base = await getGlobalSkillRegistry({ rootDirOverride: root });
    const overlaid = overlaySkillRegistryForTurn(
      base,
      {
        slug: "alpha",
        userId: "user-a",
        bodyMd: draftSkillSource("alpha", "Draft alpha body."),
      },
      "user-a"
    );

    assert.equal(await overlaid.get("alpha")?.loadBody(), "Draft alpha body.");
    assert.deepEqual(overlaid.get("alpha")?.metadata.allowedTools, [
      "qualification_tool",
    ]);
    assert.equal(
      await base.get("alpha")?.loadBody(),
      "Alpha body.",
      "the turn overlay must not mutate the base registry"
    );
  } finally {
    resetGlobalSkillRegistryForTests();
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testDraftOverlayIsolation(): Promise<void> {
  resetGlobalSkillRegistryForTests();
  const root = await makeRootWithSkill();
  try {
    const base = await getGlobalSkillRegistry({ rootDirOverride: root });
    const firstTurn = overlaySkillRegistryForTurn(
      base,
      {
        slug: "draft-only",
        userId: "user-a",
        bodyMd: draftSkillSource("draft-only", "First turn only."),
      },
      "user-a"
    );
    const secondTurn = overlaySkillRegistryForTurn(
      base,
      {
        slug: "draft-only",
        userId: "user-a",
        bodyMd: draftSkillSource("draft-only", "Second turn only."),
      },
      "user-a"
    );

    assert.equal(await firstTurn.get("draft-only")?.loadBody(), "First turn only.");
    assert.equal(
      await secondTurn.get("draft-only")?.loadBody(),
      "Second turn only."
    );
    assert.equal(base.has("draft-only"), false, "draft must not leak to later calls");
    assert.throws(
      () =>
        overlaySkillRegistryForTurn(
          base,
          [] as unknown as {
            slug: string;
            userId: string;
            bodyMd: string;
          },
          "user-a"
        ),
      SkillUnderTestValidationError,
      "runtime validation must reject non-object overlay payloads"
    );
    assert.throws(
      () =>
        overlaySkillRegistryForTurn(
          base,
          {
            slug: "draft-only",
            userId: "user-b",
            bodyMd: draftSkillSource("draft-only", "Wrong tenant."),
          },
          "user-a"
        ),
      SkillUnderTestValidationError
    );
  } finally {
    resetGlobalSkillRegistryForTests();
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testDraftOverlayRejectsInvalidBody(): Promise<void> {
  resetGlobalSkillRegistryForTests();
  const root = await makeRootWithSkill();
  try {
    const base = await getGlobalSkillRegistry({ rootDirOverride: root });
    assert.throws(
      () =>
        overlaySkillRegistryForTurn(
          base,
          {
            slug: "alpha",
            userId: "user-a",
            bodyMd: [
              "---",
              "name: another-slug",
              "description: Mismatched draft.",
              "---",
              "",
              "Invalid draft.",
            ].join("\n"),
          },
          "user-a"
        ),
      (err: unknown) =>
        err instanceof SkillUnderTestValidationError &&
        err.message.includes("invalid skillUnderTest body")
    );
  } finally {
    resetGlobalSkillRegistryForTests();
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await testEnvOverride();
  await testEnvOverrideRelative();
  await testResolvedRootHasSkillsGlobal();
  await testCachedRootAfterLoad();
  await testDraftOverlayPrecedence();
  await testDraftOverlayIsolation();
  await testDraftOverlayRejectsInvalidBody();
  console.log("skills/runtime.selftest: all 7 cases passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
