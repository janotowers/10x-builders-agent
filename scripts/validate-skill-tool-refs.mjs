#!/usr/bin/env node
/**
 * Validates that every `allowed_tools` reference in `skills/global/<slug>/SKILL.md`
 * resolves to a tool id present in `packages/agent/src/tools/catalog.ts`.
 *
 * Exits with non-zero if any reference is unknown. Designed to be wired in
 * CI / pre-build.
 *
 * Usage:
 *   node scripts/validate-skill-tool-refs.mjs
 *
 * Output:
 *   - Logs each (skill, tool) check.
 *   - Summary at the end with counts.
 *
 * Limitations:
 *   - Does NOT validate `account_skills` (DB-resident); for those the API
 *     handler `POST /api/account-skills` runs the same Zod parse and rejects
 *     bad frontmatter at write time. CI cannot reach the DB without secrets.
 *   - Uses a regex-based catalog scan instead of importing the TS module
 *     (this script must run without a TS toolchain, e.g. as a fast
 *     pre-commit). The regex looks for `id: "..."` inside TOOL_CATALOG.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const CATALOG_PATH = path.join(
  REPO_ROOT,
  "packages",
  "agent",
  "src",
  "tools",
  "catalog.ts"
);
const SKILLS_DIR = path.join(REPO_ROOT, "skills", "global");

async function loadCatalogToolIds() {
  const raw = await fs.readFile(CATALOG_PATH, "utf8");
  const ids = new Set();
  // Each ToolDefinition entry has `id: "..."` on its own line. We capture
  // those literally; this is robust to reordering and multiline objects.
  const re = /\bid:\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(raw))) {
    ids.add(m[1]);
  }
  if (ids.size === 0) {
    throw new Error(
      `No tool ids parsed from ${CATALOG_PATH}; the regex may need updating.`
    );
  }
  return ids;
}

function parseFrontmatter(raw) {
  // Minimal frontmatter parser: only handles the subset we need
  // (allowed_tools as YAML array). Returns { frontmatter, body }.
  const lines = raw.split(/\r?\n/);
  if (lines[0] !== "---") {
    return { frontmatter: null, body: raw };
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) {
    return { frontmatter: null, body: raw };
  }
  const fmText = lines.slice(1, end).join("\n");
  return { frontmatter: fmText, body: lines.slice(end + 1).join("\n") };
}

function extractAllowedTools(fmText) {
  if (!fmText) return [];
  // Look for `allowed_tools:` block until next non-indented key.
  const lines = fmText.split(/\r?\n/);
  const out = [];
  let inBlock = false;
  for (const line of lines) {
    if (/^allowed_tools:\s*$/.test(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock) {
      // Tool entry: `  - tool_name`. Stop at the first non-list line that
      // isn't blank (this handles other top-level keys).
      const m = /^\s+-\s+(\S.+)$/.exec(line);
      if (m) {
        out.push(m[1].trim());
        continue;
      }
      if (line.trim() === "") continue;
      // Top-level key reached; exit the block.
      if (/^\S/.test(line)) {
        break;
      }
    }
  }
  return out;
}

async function main() {
  const toolIds = await loadCatalogToolIds();
  console.log(`[validate-skill-tool-refs] catalog has ${toolIds.size} tool ids`);

  let totalSkills = 0;
  let totalRefs = 0;
  const errors = [];

  let skillSlugs = [];
  try {
    skillSlugs = await fs.readdir(SKILLS_DIR);
  } catch (e) {
    if (e.code === "ENOENT") {
      console.log(`[validate-skill-tool-refs] no skills dir at ${SKILLS_DIR}`);
      return;
    }
    throw e;
  }

  for (const slug of skillSlugs) {
    const skillFile = path.join(SKILLS_DIR, slug, "SKILL.md");
    try {
      const stat = await fs.stat(skillFile);
      if (!stat.isFile()) continue;
    } catch {
      continue;
    }
    totalSkills++;
    const raw = await fs.readFile(skillFile, "utf8");
    const { frontmatter } = parseFrontmatter(raw);
    const tools = extractAllowedTools(frontmatter);
    for (const t of tools) {
      totalRefs++;
      if (!toolIds.has(t)) {
        errors.push({ slug, tool: t });
      }
    }
  }

  console.log(
    `[validate-skill-tool-refs] checked ${totalSkills} skills, ${totalRefs} tool refs total`
  );
  if (errors.length > 0) {
    console.error(
      `[validate-skill-tool-refs] FOUND ${errors.length} INVALID REFERENCES:`
    );
    for (const e of errors) {
      console.error(`  - skill="${e.slug}" tool="${e.tool}" (not in catalog)`);
    }
    process.exitCode = 1;
    return;
  }
  console.log("[validate-skill-tool-refs] OK — all references resolve.");
}

main().catch((err) => {
  console.error("[validate-skill-tool-refs] fatal:", err);
  process.exitCode = 1;
});
