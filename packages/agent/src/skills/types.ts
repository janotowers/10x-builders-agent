/**
 * Skill types — V1-A.
 *
 * A "Skill" is a markdown-based playbook that can be lazily loaded into the
 * system prompt of `runAgent`. V1-A only delivers the registry plumbing:
 * file parsing, metadata-first registry, and composite resolution. Wiring
 * into `runAgent` and the tool gate happens in V1-B.
 *
 * Frontmatter contract is documented in
 * `docs/business-brain-evolution-roadmap.md` (§ V1-A).
 */

export type SkillScope = "business" | "personal" | "shared";

/**
 * Validated, in-memory representation of a single SKILL.md frontmatter.
 * `body` is **not** held here; it is loaded on demand via `SkillRecord.loadBody()`.
 */
export interface SkillMetadata {
  readonly name: string;
  readonly description: string;
  readonly scope: SkillScope;
  readonly allowedTools: readonly string[];
  readonly includes: readonly string[];
  readonly guardrails: string | null;
  /** Absolute path to the SKILL.md file the metadata was read from. */
  readonly sourcePath: string;
}

/**
 * One entry in the registry. Body access is lazy and cached.
 */
export interface SkillRecord {
  readonly metadata: SkillMetadata;
  /**
   * Reads the SKILL.md body (markdown after the frontmatter) and caches it.
   * Idempotent: subsequent calls return the same string without disk IO.
   */
  loadBody(): Promise<string>;
}

/**
 * Result of merging a (possibly composite) skill into a single playbook
 * payload that can be appended to the system prompt and used to derive
 * `allowed_tools` for the bound model.
 */
export interface ResolvedSkill {
  /** The slug of the top-level skill that was resolved. */
  readonly rootName: string;
  /** Ordered list of skill slugs that contributed to the body (root last). */
  readonly composedFrom: readonly string[];
  /** Concatenated body text ready to inject into the system prompt. */
  readonly body: string;
  /** Union of `allowed_tools` across composed skills, deduped, order-preserving. */
  readonly allowedTools: readonly string[];
  /** Estimated tokens in `body` (chars / 4 heuristic, matching compaction_node). */
  readonly estimatedTokens: number;
}

/**
 * Read-only view over the loaded skills.
 */
export interface SkillRegistry {
  /** Number of skills in the registry. */
  readonly size: number;
  /** Lookup by slug (frontmatter `name`). */
  get(name: string): SkillRecord | undefined;
  /** Iterate metadata only (cheap; bodies stay unloaded). */
  list(): readonly SkillMetadata[];
  /** True when a skill with that slug exists. */
  has(name: string): boolean;
}
