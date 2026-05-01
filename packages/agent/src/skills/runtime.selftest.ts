import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  defaultSkillsRoot,
  getCachedSkillsRegistryRoot,
  getGlobalSkillRegistry,
  resetGlobalSkillRegistryForTests,
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

async function main(): Promise<void> {
  await testEnvOverride();
  await testEnvOverrideRelative();
  await testResolvedRootHasSkillsGlobal();
  await testCachedRootAfterLoad();
  console.log("skills/runtime.selftest: all 4 cases passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
