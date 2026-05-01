/**
 * SKILL.md → SkillRecord parser.
 *
 * Validates the frontmatter against the contract in
 * `docs/business-brain-evolution-roadmap.md` (§ V1-A) using Zod, and returns
 * a `SkillRecord` with a lazy, cached body loader. Bodies are **not** read
 * from disk until `loadBody()` is called.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import {
  FrontmatterError,
  parseFrontmatterBlock,
  splitFrontmatter,
} from "./frontmatter";
import type { SkillMetadata, SkillRecord } from "./types";

/** Hard cap on SKILL.md body size (estimated tokens, chars/4 heuristic). */
export const MAX_SKILL_BODY_TOKENS = 5000;
/** Maximum description length per Anthropic Skills spec. */
export const MAX_DESCRIPTION_CHARS = 1024;
/** Maximum name length per Anthropic Skills spec. */
export const MAX_NAME_CHARS = 64;

/**
 * Reserved name fragments forbidden in `name` per the Anthropic Skills spec.
 * Match is case-insensitive on the slug.
 */
const FORBIDDEN_NAME_SUBSTRINGS = ["anthropic", "claude"] as const;

const SCOPE_VALUES = ["business", "personal", "shared"] as const;

const FrontmatterSchema = z
  .object({
    name: z
      .string()
      .min(1, "name is required")
      .max(MAX_NAME_CHARS, `name must be <= ${MAX_NAME_CHARS} chars`)
      .regex(
        /^[a-z0-9][a-z0-9-]*$/,
        "name must match ^[a-z0-9][a-z0-9-]*$ (lowercase, digits, hyphens)"
      )
      .refine(
        (n) =>
          !FORBIDDEN_NAME_SUBSTRINGS.some((bad) =>
            n.toLowerCase().includes(bad)
          ),
        {
          message: `name must not contain ${FORBIDDEN_NAME_SUBSTRINGS.join(" or ")}`,
        }
      ),
    description: z
      .string()
      .min(1, "description is required")
      .max(
        MAX_DESCRIPTION_CHARS,
        `description must be <= ${MAX_DESCRIPTION_CHARS} chars`
      ),
    scope: z.enum(SCOPE_VALUES).default("shared"),
    allowed_tools: z.array(z.string().min(1)).default([]),
    includes: z.array(z.string().min(1)).default([]),
    guardrails: z.string().min(1).optional(),
    requires_tenant_context: z.boolean().default(false),
  })
  .strict();

export class SkillParseError extends Error {
  constructor(
    message: string,
    readonly sourcePath: string,
    readonly cause?: unknown
  ) {
    super(`${message} (${sourcePath})`);
    this.name = "SkillParseError";
  }
}

/** Estimated tokens for a chunk of text. Mirrors compaction_node's heuristic. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Parse a SKILL.md file from disk. The directory containing the file MUST
 * be named identically to the frontmatter `name` (the slug); this is
 * enforced so registry lookups by slug are safe.
 *
 * Body content is read once to size-validate the file at registry build time
 * and is then **discarded**; subsequent `loadBody()` calls re-read from
 * disk and cache the result. This keeps the registry footprint at "metadata
 * only" until a skill is actually selected for a turn.
 */
export async function parseSkillFile(filePath: string): Promise<SkillRecord> {
  const absPath = path.resolve(filePath);
  let raw: string;
  try {
    raw = await fs.readFile(absPath, "utf8");
  } catch (err) {
    throw new SkillParseError("could not read SKILL.md", absPath, err);
  }
  return parseSkillSourceImpl(raw, absPath, /* keepBody */ false);
}

/**
 * Parse SKILL.md content already loaded into memory. Useful for tests and
 * for callers that want to avoid the second disk read when they already
 * have the raw text. The split body is cached on the returned record.
 */
export function parseSkillSource(
  raw: string,
  sourcePath: string
): SkillRecord {
  return parseSkillSourceImpl(raw, sourcePath, /* keepBody */ true);
}

function parseSkillSourceImpl(
  raw: string,
  sourcePath: string,
  keepBody: boolean
): SkillRecord {
  const split = (() => {
    try {
      return splitFrontmatter(raw);
    } catch (err) {
      throw new SkillParseError(
        "could not split frontmatter",
        sourcePath,
        err
      );
    }
  })();

  if (!split.hasFrontmatter) {
    throw new SkillParseError(
      "SKILL.md must begin with a YAML frontmatter block delimited by '---'",
      sourcePath
    );
  }

  let parsedBlock: Record<string, unknown>;
  try {
    parsedBlock = parseFrontmatterBlock(split.frontmatter);
  } catch (err) {
    if (err instanceof FrontmatterError) {
      throw new SkillParseError(err.message, sourcePath, err);
    }
    throw new SkillParseError(
      "could not parse frontmatter",
      sourcePath,
      err
    );
  }

  // Surface unknown keys as a strict error so authors notice typos early.
  const result = FrontmatterSchema.safeParse(parsedBlock);
  if (!result.success) {
    const issues = result.error.issues
      .map((iss) => `  - ${iss.path.join(".") || "<root>"}: ${iss.message}`)
      .join("\n");
    throw new SkillParseError(
      `invalid frontmatter:\n${issues}`,
      sourcePath
    );
  }

  const dirSlug = path.basename(path.dirname(sourcePath));
  if (dirSlug !== result.data.name) {
    throw new SkillParseError(
      `frontmatter name '${result.data.name}' must match directory '${dirSlug}'`,
      sourcePath
    );
  }

  const bodyEstimated = estimateTokens(split.body);
  if (bodyEstimated > MAX_SKILL_BODY_TOKENS) {
    throw new SkillParseError(
      `body exceeds ${MAX_SKILL_BODY_TOKENS}-token cap (~${bodyEstimated} estimated)`,
      sourcePath
    );
  }

  const metadata: SkillMetadata = {
    name: result.data.name,
    description: result.data.description,
    scope: result.data.scope,
    allowedTools: Object.freeze([...result.data.allowed_tools]),
    includes: Object.freeze([...result.data.includes]),
    guardrails: result.data.guardrails ?? null,
    requiresTenantContext: result.data.requires_tenant_context,
    sourcePath,
  };

  let cachedBody: string | null = keepBody ? split.body.trimStart() : null;
  return {
    metadata,
    async loadBody(): Promise<string> {
      if (cachedBody !== null) return cachedBody;
      const fresh = await fs.readFile(sourcePath, "utf8");
      const reSplit = splitFrontmatter(fresh);
      cachedBody = reSplit.body.trimStart();
      return cachedBody;
    },
  };
}
