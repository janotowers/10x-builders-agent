#!/usr/bin/env node
/**
 * Validates global SKILL.md files before runtime:
 *   - frontmatter shape and required fields
 *   - body token budget
 *   - directory slug matches `name`
 *   - allowed_tools resolve to TOOL_CATALOG ids
 *   - includes reference existing skills and do not form cycles
 *
 * This is intentionally dependency-free so it can run in prebuild without a
 * TypeScript loader. It mirrors the runtime parser's critical invariants.
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

const MAX_SKILL_BODY_TOKENS = 5000;
const WARN_SKILL_BODY_TOKENS = 4500;
const MAX_DESCRIPTION_CHARS = 1024;
const MAX_NAME_CHARS = 64;
const SCOPES = new Set(["business", "personal", "shared"]);
const MEMORY_MODES = new Set(["default", "ephemeral"]);
const HEARTBEAT_MODES = new Set(["native", "compatible", "blocked"]);

function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

async function loadCatalogToolIds() {
  const raw = await fs.readFile(CATALOG_PATH, "utf8");
  const ids = new Set();
  const re = /\bid:\s*"([^"]+)"/g;
  let match;
  while ((match = re.exec(raw))) {
    ids.add(match[1]);
  }
  if (ids.size === 0) {
    throw new Error(
      `No tool ids parsed from ${CATALOG_PATH}; the regex may need updating.`
    );
  }
  return ids;
}

function splitFrontmatter(raw) {
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) {
    throw new Error("SKILL.md must begin with a YAML frontmatter block");
  }
  const rest = text.slice(4);
  const end = rest.match(/\n---[ \t]*(?:\n|$)/);
  if (!end) {
    throw new Error("opening frontmatter fence found but closing fence is missing");
  }
  const frontmatter = rest.slice(0, end.index);
  const body = rest.slice((end.index ?? 0) + end[0].length);
  return { frontmatter, body };
}

function stripInlineComment(value) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "#" && !inSingle && !inDouble) return value.slice(0, i);
  }
  return value;
}

function parseScalar(raw, lineNo) {
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    return value
      .slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value.startsWith('"') || value.startsWith("'")) {
    throw new Error(`frontmatter line ${lineNo}: unterminated quoted string`);
  }
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}

function parseInlineArray(raw, lineNo) {
  const value = raw.trim();
  if (!value.startsWith("[") || !value.endsWith("]")) {
    throw new Error(`frontmatter line ${lineNo}: inline array must use [..]`);
  }
  const inner = value.slice(1, -1).trim();
  if (!inner) return [];
  return inner.split(",").map((item) => String(parseScalar(item.trim(), lineNo)));
}

function readIndentedBlock(lines, start) {
  const block = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      block.push("");
      i += 1;
      continue;
    }
    if (!line.startsWith(" ") && !line.startsWith("\t")) break;
    block.push(line.replace(/^[ \t]{2}/, ""));
    i += 1;
  }
  return { lines: block, next: i };
}

function parseBlockArray(lines) {
  const values = [];
  for (const line of lines) {
    const match = /^\s*-\s+(.+)$/.exec(line);
    if (match) values.push(String(parseScalar(match[1].trim(), 0)));
  }
  return values;
}

function parseFrontmatter(frontmatter) {
  const lines = frontmatter.split("\n");
  const metadata = {};
  let i = 0;
  while (i < lines.length) {
    const rawLine = lines[i] ?? "";
    const line = rawLine.trimEnd();
    if (!line.trim() || line.trim().startsWith("#")) {
      i += 1;
      continue;
    }
    if (/^[ \t]/.test(line)) {
      throw new Error(
        `frontmatter line ${i + 1}: unexpected indentation outside a block`
      );
    }
    const colon = line.indexOf(":");
    if (colon <= 0) {
      throw new Error(`frontmatter line ${i + 1}: expected key: value`);
    }
    const key = line.slice(0, colon).trim();
    if (!/^[a-z_][a-z0-9_]*$/i.test(key)) {
      throw new Error(`frontmatter line ${i + 1}: invalid key '${key}'`);
    }
    const rest = stripInlineComment(line.slice(colon + 1)).trimEnd();
    const restTrim = rest.trim();
    if (restTrim === "|") {
      const block = readIndentedBlock(lines, i + 1);
      metadata[key] = block.lines.join("\n").replace(/\s+$/, "");
      i = block.next;
      continue;
    }
    if (restTrim === "") {
      const block = readIndentedBlock(lines, i + 1);
      metadata[key] = parseBlockArray(block.lines);
      i = block.next;
      continue;
    }
    if (restTrim.startsWith("[")) {
      metadata[key] = parseInlineArray(restTrim, i + 1);
      i += 1;
      continue;
    }
    metadata[key] = parseScalar(restTrim, i + 1);
    i += 1;
  }
  return metadata;
}

function pushError(errors, slug, message) {
  errors.push({ slug, message });
}

function validateMetadata(slug, metadata, errors) {
  const allowedKeys = new Set([
    "name",
    "description",
    "scope",
    "allowed_tools",
    "includes",
    "guardrails",
    "requires_tenant_context",
    "memory_extraction",
    "heartbeat",
    "heartbeat_signals",
  ]);
  for (const key of Object.keys(metadata)) {
    if (!allowedKeys.has(key)) pushError(errors, slug, `unknown frontmatter key '${key}'`);
  }

  if (typeof metadata.name !== "string" || !metadata.name) {
    pushError(errors, slug, "`name` is required");
  } else {
    if (metadata.name !== slug) {
      pushError(errors, slug, `frontmatter name '${metadata.name}' must match directory '${slug}'`);
    }
    if (metadata.name.length > MAX_NAME_CHARS) {
      pushError(errors, slug, `name must be <= ${MAX_NAME_CHARS} chars`);
    }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(metadata.name)) {
      pushError(errors, slug, "name must match ^[a-z0-9][a-z0-9-]*$");
    }
    if (/anthropic|claude/i.test(metadata.name)) {
      pushError(errors, slug, "name must not contain anthropic or claude");
    }
  }

  if (typeof metadata.description !== "string" || !metadata.description) {
    pushError(errors, slug, "`description` is required");
  } else if (metadata.description.length > MAX_DESCRIPTION_CHARS) {
    pushError(errors, slug, `description must be <= ${MAX_DESCRIPTION_CHARS} chars`);
  }

  if (metadata.scope !== undefined && !SCOPES.has(metadata.scope)) {
    pushError(errors, slug, "`scope` must be business, personal, or shared");
  }
  if (metadata.allowed_tools !== undefined && !Array.isArray(metadata.allowed_tools)) {
    pushError(errors, slug, "`allowed_tools` must be an array");
  }
  if (metadata.includes !== undefined && !Array.isArray(metadata.includes)) {
    pushError(errors, slug, "`includes` must be an array");
  }
  if (
    metadata.requires_tenant_context !== undefined &&
    typeof metadata.requires_tenant_context !== "boolean"
  ) {
    pushError(errors, slug, "`requires_tenant_context` must be boolean");
  }
  if (
    metadata.memory_extraction !== undefined &&
    !MEMORY_MODES.has(metadata.memory_extraction)
  ) {
    pushError(errors, slug, "`memory_extraction` must be default or ephemeral");
  }
  if (metadata.heartbeat !== undefined && !HEARTBEAT_MODES.has(metadata.heartbeat)) {
    pushError(errors, slug, "`heartbeat` must be native, compatible, or blocked");
  }
}

async function loadSkills() {
  const skills = new Map();
  let entries = [];
  try {
    entries = await fs.readdir(SKILLS_DIR, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return skills;
    throw err;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const slug = entry.name;
    const skillFile = path.join(SKILLS_DIR, slug, "SKILL.md");
    try {
      const stat = await fs.stat(skillFile);
      if (!stat.isFile()) continue;
    } catch {
      continue;
    }
    const raw = await fs.readFile(skillFile, "utf8");
    skills.set(slug, { slug, skillFile, raw });
  }
  return skills;
}

function validateIncludes(skills, records, errors) {
  for (const [slug, record] of records) {
    for (const include of record.includes) {
      if (!skills.has(include)) {
        pushError(errors, slug, `includes unknown skill '${include}'`);
      }
    }
  }

  const visiting = new Set();
  const visited = new Set();
  const visit = (slug, trail) => {
    if (visited.has(slug)) return;
    if (visiting.has(slug)) {
      pushError(errors, slug, `include cycle detected: ${[...trail, slug].join(" -> ")}`);
      return;
    }
    visiting.add(slug);
    const record = records.get(slug);
    for (const include of record?.includes ?? []) {
      if (records.has(include)) visit(include, [...trail, slug]);
    }
    visiting.delete(slug);
    visited.add(slug);
  };
  for (const slug of records.keys()) visit(slug, []);
}

async function main() {
  const toolIds = await loadCatalogToolIds();
  const skills = await loadSkills();
  const errors = [];
  const warnings = [];
  const records = new Map();
  let totalToolRefs = 0;

  for (const [slug, skill] of skills) {
    try {
      const { frontmatter, body } = splitFrontmatter(skill.raw);
      const metadata = parseFrontmatter(frontmatter);
      validateMetadata(slug, metadata, errors);

      const tokens = estimateTokens(body);
      if (tokens > MAX_SKILL_BODY_TOKENS) {
        pushError(
          errors,
          slug,
          `body exceeds ${MAX_SKILL_BODY_TOKENS}-token cap (~${tokens} estimated)`
        );
      } else if (tokens > WARN_SKILL_BODY_TOKENS) {
        warnings.push({
          slug,
          message: `body is near token cap (~${tokens}/${MAX_SKILL_BODY_TOKENS})`,
        });
      }

      const allowedTools = Array.isArray(metadata.allowed_tools)
        ? metadata.allowed_tools
        : [];
      const includes = Array.isArray(metadata.includes) ? metadata.includes : [];
      for (const tool of allowedTools) {
        totalToolRefs += 1;
        if (!toolIds.has(tool)) {
          pushError(errors, slug, `allowed_tools references unknown tool '${tool}'`);
        }
      }
      records.set(slug, { includes });
    } catch (err) {
      pushError(errors, slug, err instanceof Error ? err.message : String(err));
    }
  }

  validateIncludes(skills, records, errors);

  console.log(`[validate-skills] catalog has ${toolIds.size} tool ids`);
  console.log(
    `[validate-skills] checked ${skills.size} skills, ${totalToolRefs} tool refs total`
  );
  for (const warning of warnings) {
    console.warn(`[validate-skills] WARN skill="${warning.slug}": ${warning.message}`);
  }

  if (errors.length > 0) {
    console.error(`[validate-skills] FOUND ${errors.length} ERRORS:`);
    for (const error of errors) {
      console.error(`  - skill="${error.slug}": ${error.message}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("[validate-skills] OK");
}

main().catch((err) => {
  console.error("[validate-skills] fatal:", err);
  process.exitCode = 1;
});
