import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readSkillReference,
  MAX_REFERENCE_BYTES,
} from "./skill-references";

async function withTempSkillsRoot<T>(
  setup: (root: string) => Promise<void> | void,
  fn: (root: string) => Promise<T>
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "skill-refs-test-"));
  try {
    await setup(root);
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testHappyPath(): Promise<void> {
  await withTempSkillsRoot(
    async (root) => {
      const dir = join(root, "skills", "global", "demo", "references");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        join(dir, "schema.md"),
        "# Schema\n\nTabla `proj.ds.leads`",
        "utf8"
      );
    },
    async (root) => {
      const result = await readSkillReference({
        name: "schema",
        activeSkillName: "demo",
        skillsRoot: root,
      });
      assert.equal(result.status, "ok");
      if (result.status === "ok") {
        assert.equal(result.skill, "demo");
        assert.equal(result.name, "schema");
        assert.ok(result.content.includes("Tabla"));
        assert.equal(result.truncated, false);
        assert.ok(result.bytes > 0);
      }
    }
  );
}

async function testNoActiveSkill(): Promise<void> {
  const result = await readSkillReference({
    name: "schema",
    activeSkillName: undefined,
    skillsRoot: "/tmp/whatever",
  });
  assert.equal(result.status, "no_active_skill");
}

async function testNoActiveSkillEmptyString(): Promise<void> {
  const result = await readSkillReference({
    name: "schema",
    activeSkillName: "   ",
    skillsRoot: "/tmp/whatever",
  });
  assert.equal(result.status, "no_active_skill");
}

async function testInvalidNamePathTraversal(): Promise<void> {
  const cases = [
    "../etc/passwd",
    "..",
    "./schema",
    "schema/",
    "/etc/passwd",
    "schema.md", // extension included
    "Schema",    // uppercase
    "_hidden",   // leading underscore
    "-leading",  // leading hyphen
    "",
    "  ",
    "with space",
    "weird$char",
  ];
  for (const bad of cases) {
    const result = await readSkillReference({
      name: bad,
      activeSkillName: "demo",
      skillsRoot: "/tmp/anything",
    });
    assert.equal(
      result.status,
      "invalid_name",
      `expected invalid_name for '${bad}', got ${result.status}`
    );
  }
}

async function testNotFound(): Promise<void> {
  await withTempSkillsRoot(
    async (root) => {
      const dir = join(root, "skills", "global", "demo", "references");
      await fs.mkdir(dir, { recursive: true });
    },
    async (root) => {
      const result = await readSkillReference({
        name: "missing",
        activeSkillName: "demo",
        skillsRoot: root,
      });
      assert.equal(result.status, "not_found");
      if (result.status === "not_found") {
        assert.equal(result.skill, "demo");
        assert.equal(result.name, "missing");
      }
    }
  );
}

async function testNotFoundForUnknownSkill(): Promise<void> {
  await withTempSkillsRoot(
    async () => {
      // No directories created.
    },
    async (root) => {
      const result = await readSkillReference({
        name: "schema",
        activeSkillName: "ghost-skill",
        skillsRoot: root,
      });
      assert.equal(result.status, "not_found");
    }
  );
}

async function testTruncationAtSizeCap(): Promise<void> {
  await withTempSkillsRoot(
    async (root) => {
      const dir = join(root, "skills", "global", "demo", "references");
      await fs.mkdir(dir, { recursive: true });
      const big = "A".repeat(MAX_REFERENCE_BYTES + 500);
      await fs.writeFile(join(dir, "huge.md"), big, "utf8");
    },
    async (root) => {
      const result = await readSkillReference({
        name: "huge",
        activeSkillName: "demo",
        skillsRoot: root,
      });
      assert.equal(result.status, "ok");
      if (result.status === "ok") {
        assert.equal(result.truncated, true);
        assert.equal(result.content.length, MAX_REFERENCE_BYTES);
        assert.ok(result.bytes > MAX_REFERENCE_BYTES);
      }
    }
  );
}

async function testRejectsDirectoryAsFile(): Promise<void> {
  await withTempSkillsRoot(
    async (root) => {
      // Create a *directory* named the same as a reference would be.
      const dir = join(root, "skills", "global", "demo", "references", "schema.md");
      await fs.mkdir(dir, { recursive: true });
    },
    async (root) => {
      const result = await readSkillReference({
        name: "schema",
        activeSkillName: "demo",
        skillsRoot: root,
      });
      assert.equal(result.status, "not_found");
    }
  );
}

async function testRejectsBadActiveSkillSlug(): Promise<void> {
  await withTempSkillsRoot(
    async () => {},
    async (root) => {
      // The active skill name itself isn't validated by readSkillReference
      // (the selector only ever sets it from a parsed registry); but if
      // someone passes a path-traversing skill name, the resolved target
      // still lands inside the skillsRoot tree because of the join + the
      // expected_prefix check we do on the references dir.
      const result = await readSkillReference({
        name: "schema",
        activeSkillName: "../../etc",
        skillsRoot: root,
      });
      // Either invalid_name (if we ever validate) or not_found (because
      // the directory doesn't exist). Path traversal must NOT succeed.
      assert.notEqual(result.status, "ok");
    }
  );
}

async function main(): Promise<void> {
  await testHappyPath();
  await testNoActiveSkill();
  await testNoActiveSkillEmptyString();
  await testInvalidNamePathTraversal();
  await testNotFound();
  await testNotFoundForUnknownSkill();
  await testTruncationAtSizeCap();
  await testRejectsDirectoryAsFile();
  await testRejectsBadActiveSkillSlug();
  console.log("tools/skill-references.selftest: all 9 cases passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
