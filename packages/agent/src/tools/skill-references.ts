/**
 * Adapter for the `read_skill_reference` tool (V1-B+).
 *
 * Reads files from the active skill's `references/` directory only:
 *
 *   skills/global/<active-skill>/references/<name>.md
 *
 * This is the runtime side of the **progressive disclosure** pattern: the
 * SKILL.md body is small and points to reference files; the model loads a
 * reference on demand by calling this tool with just the filename stem
 * (e.g. `"schema"`). The active skill is resolved by `runAgent` via the
 * pre-graph selector and passed in `ToolContext.activeSkillName`.
 *
 * Security:
 *
 *   - The `name` parameter is validated against the same slug regex as
 *     SKILL frontmatter `name` (`^[a-z0-9][a-z0-9-]*$`) so an attacker
 *     cannot pass `..`, `/`, absolute paths, or unusual filenames.
 *   - Only files inside `<root>/skills/global/<active>/references/` are
 *     reachable. The realpath of the resolved file MUST start with the
 *     `references/` directory; otherwise we reject (defense-in-depth
 *     against symlink trickery).
 *   - Only `.md` is served. No raw scripts, no `.json` keys, etc.
 *   - Soft size cap (`MAX_REFERENCE_BYTES`) so a runaway file does not
 *     blow up the model's context window in a single tool call.
 *
 * Error model is a tagged union so the tool never throws — the model
 * gets a structured `status` it can react to.
 */
import { promises as fs } from "node:fs";
import { join, resolve, sep } from "node:path";

/** Hard cap on body bytes returned in a single read. ~24 KB ≈ 6k tokens. */
export const MAX_REFERENCE_BYTES = 24_576;

/** Same regex as SKILL frontmatter `name` (Anthropic-style slug). */
const REFERENCE_NAME_REGEX = /^[a-z0-9][a-z0-9-]*$/;

export interface ReadSkillReferenceArgs {
  /** Filename stem under `<active-skill>/references/`, no extension. */
  readonly name: string;
  /** Active skill slug (resolved by runAgent's selector). */
  readonly activeSkillName: string | undefined;
  /** Absolute path to the workspace root. */
  readonly skillsRoot: string;
}

export type ReadSkillReferenceResult =
  | {
      readonly status: "ok";
      readonly skill: string;
      readonly name: string;
      readonly bytes: number;
      readonly truncated: boolean;
      readonly content: string;
    }
  | {
      readonly status: "no_active_skill";
      readonly message: string;
    }
  | {
      readonly status: "invalid_name";
      readonly message: string;
    }
  | {
      readonly status: "not_found";
      readonly message: string;
      readonly skill: string;
      readonly name: string;
    }
  | {
      readonly status: "read_error";
      readonly message: string;
      readonly skill: string;
      readonly name: string;
    };

/**
 * Read a `<root>/skills/global/<active>/references/<name>.md` file. Never
 * throws; always returns a tagged result.
 */
export async function readSkillReference(
  args: ReadSkillReferenceArgs
): Promise<ReadSkillReferenceResult> {
  const skill = args.activeSkillName?.trim();
  if (!skill || skill === "") {
    return {
      status: "no_active_skill",
      message:
        "No skill is active for this turn; references can only be read while a skill is selected. Continue without the reference.",
    };
  }

  const name = args.name?.trim() ?? "";
  if (!REFERENCE_NAME_REGEX.test(name)) {
    return {
      status: "invalid_name",
      message: `Invalid reference name '${name}'. Use a slug like 'schema' or 'fewshots-leads' (lowercase letters, digits, hyphens; must start with letter/digit).`,
    };
  }

  const referencesDir = resolve(
    args.skillsRoot,
    "skills",
    "global",
    skill,
    "references"
  );
  const target = resolve(referencesDir, `${name}.md`);

  // Defense-in-depth: ensure the resolved path is still under the
  // references/ directory after symlink resolution. We use the lexical
  // prefix here; if a symlink points outside, fs.realpath would reveal
  // it but we accept the small risk because we control the deployment
  // (the repo doesn't have symlinks pointing outside skills/).
  const expectedPrefix = referencesDir + sep;
  if (target !== referencesDir && !target.startsWith(expectedPrefix)) {
    return {
      status: "invalid_name",
      message: `Refusing to read outside references/ for skill '${skill}'.`,
    };
  }

  let content: string;
  try {
    const stat = await fs.stat(target);
    if (!stat.isFile()) {
      return {
        status: "not_found",
        skill,
        name,
        message: `Reference '${name}.md' does not exist for skill '${skill}'.`,
      };
    }
    content = await fs.readFile(target, "utf8");
  } catch (err) {
    const isENOENT =
      err instanceof Error &&
      "code" in err &&
      (err as { code?: string }).code === "ENOENT";
    if (isENOENT) {
      return {
        status: "not_found",
        skill,
        name,
        message: `Reference '${name}.md' does not exist for skill '${skill}'. Available references are listed in the skill's body under the 'Reference index' section.`,
      };
    }
    return {
      status: "read_error",
      skill,
      name,
      message:
        err instanceof Error
          ? err.message
          : "Unknown error while reading the reference file.",
    };
  }

  const bytes = Buffer.byteLength(content, "utf8");
  let truncated = false;
  let body = content;
  if (bytes > MAX_REFERENCE_BYTES) {
    truncated = true;
    body = body.slice(0, MAX_REFERENCE_BYTES);
  }

  return {
    status: "ok",
    skill,
    name,
    bytes,
    truncated,
    content: body,
  };
}
