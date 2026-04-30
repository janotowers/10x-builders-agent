import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadGlobalSkillRegistry } from "./registry";
import { SkillParseError } from "./parse";

async function makeTempRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skills-reg-"));
  await fs.mkdir(path.join(dir, "skills", "global"), { recursive: true });
  return dir;
}

async function writeSkill(
  rootDir: string,
  slug: string,
  frontmatter: string[],
  body: string
): Promise<string> {
  const skillDir = path.join(rootDir, "skills", "global", slug);
  await fs.mkdir(skillDir, { recursive: true });
  const text = ["---", ...frontmatter, "---", "", body, ""].join("\n");
  const filePath = path.join(skillDir, "SKILL.md");
  await fs.writeFile(filePath, text, "utf8");
  return filePath;
}

async function testEmptyDirectory(): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skills-reg-empty-"));
  try {
    const reg = await loadGlobalSkillRegistry(dir);
    assert.equal(reg.size, 0);
    assert.deepEqual([...reg.list()], []);
    assert.equal(reg.get("anything"), undefined);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function testLoadsMultipleSkills(): Promise<void> {
  const root = await makeTempRoot();
  try {
    await writeSkill(
      root,
      "alpha",
      [
        "name: alpha",
        "description: First skill description with what and when guidance.",
        "scope: business",
      ],
      "Alpha body."
    );
    await writeSkill(
      root,
      "beta",
      [
        "name: beta",
        "description: Second skill description with what and when guidance.",
        "scope: personal",
      ],
      "Beta body."
    );

    const reg = await loadGlobalSkillRegistry(root);
    assert.equal(reg.size, 2);
    assert.deepEqual(
      reg.list().map((m) => m.name),
      ["alpha", "beta"]
    );
    assert.equal(reg.has("alpha"), true);
    assert.equal(reg.has("missing"), false);

    const beta = reg.get("beta");
    assert.ok(beta);
    assert.equal(beta!.metadata.scope, "personal");

    const body = await beta!.loadBody();
    assert.ok(body.includes("Beta body."));
    const body2 = await beta!.loadBody();
    assert.equal(body, body2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testNonSkillDirectoriesIgnored(): Promise<void> {
  const root = await makeTempRoot();
  try {
    // A normal skill that should be loaded.
    await writeSkill(
      root,
      "alpha",
      [
        "name: alpha",
        "description: visible skill description with what and when guidance.",
      ],
      "Alpha body."
    );
    // An empty directory without a SKILL.md (stray scaffold).
    await fs.mkdir(path.join(root, "skills", "global", "empty-dir"), {
      recursive: true,
    });
    // A directory with a non-SKILL file (templates folder, etc).
    const otherDir = path.join(root, "skills", "global", "with-other-files");
    await fs.mkdir(otherDir, { recursive: true });
    await fs.writeFile(path.join(otherDir, "README.md"), "not a skill", "utf8");

    const reg = await loadGlobalSkillRegistry(root);
    assert.equal(reg.size, 1);
    assert.equal(reg.has("alpha"), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testInvalidSlugRejected(): Promise<void> {
  // Anthropic Skills spec forbids underscores at the start of names.
  // Confirm the parser rejects a slug like `_fixture` (the directory's
  // name flows through to the frontmatter `name` requirement).
  const root = await makeTempRoot();
  try {
    await writeSkill(
      root,
      "_fixture",
      [
        "name: _fixture",
        "description: invalid slug per spec, must be rejected.",
      ],
      "Body."
    );

    let thrown: unknown;
    try {
      await loadGlobalSkillRegistry(root);
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof SkillParseError, "expected fatal parse error");
    assert.match((thrown as Error).message, /name must match/i);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testParseErrorIsFatalByDefault(): Promise<void> {
  const root = await makeTempRoot();
  try {
    await writeSkill(
      root,
      "good",
      [
        "name: good",
        "description: ok skill description with what and when guidance.",
      ],
      "Body."
    );
    await writeSkill(
      root,
      "bad-slug-with-uppercase",
      ["name: BAD-Slug", "description: invalid name"],
      "Body."
    );

    let thrown: unknown;
    try {
      await loadGlobalSkillRegistry(root);
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof SkillParseError, "expected fatal parse error");

    const errs: SkillParseError[] = [];
    const reg = await loadGlobalSkillRegistry(root, {
      onParseError: (e) => errs.push(e),
    });
    assert.equal(reg.size, 1);
    assert.equal(reg.has("good"), true);
    assert.equal(errs.length, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testMissingDirectoryReturnsEmpty(): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skills-reg-noskills-"));
  try {
    const reg = await loadGlobalSkillRegistry(dir);
    assert.equal(reg.size, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await testEmptyDirectory();
  await testLoadsMultipleSkills();
  await testNonSkillDirectoriesIgnored();
  await testInvalidSlugRejected();
  await testParseErrorIsFatalByDefault();
  await testMissingDirectoryReturnsEmpty();
  console.log("skills/registry.selftest: all 6 cases passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
