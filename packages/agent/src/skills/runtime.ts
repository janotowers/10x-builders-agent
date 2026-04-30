/**
 * Runtime glue for V1-B: a process-level cache for the global skill
 * registry, plus a small helper that builds the system-prompt injection
 * for an active skill.
 *
 * The registry is read once from disk per process. In a long-running
 * server (Next.js / cron worker) this means the file system is touched
 * a single time on first turn and the parsed metadata is reused for
 * every subsequent turn. Use `resetGlobalSkillRegistryForTests()` to
 * force a reload from inside selftests.
 */
import { join } from "node:path";
import { loadGlobalSkillRegistry } from "./registry";
import type { ResolvedSkill, SkillRegistry } from "./types";

let cached: Promise<SkillRegistry> | null = null;
let cachedRoot: string | null = null;

/**
 * Resolve the path of the repo root (or wherever the `skills/` directory
 * lives). The default walks up from this file's location to the workspace
 * root; tests override `rootDirOverride` to point at a temp directory.
 */
export function defaultSkillsRoot(): string {
  // packages/agent/src/skills -> packages/agent/src -> packages/agent ->
  // packages -> <repo root>. We need <repo root> because the loader expects
  // <root>/skills/global/<slug>/SKILL.md.
  return join(__dirname, "..", "..", "..", "..");
}

export interface GetSkillRegistryOptions {
  readonly rootDirOverride?: string;
  readonly forceReload?: boolean;
}

/**
 * Return the cached global skill registry, loading it lazily on first
 * call. Errors during load are intentionally NOT cached so the next
 * turn can retry (e.g. after the operator fixes a malformed SKILL.md
 * during local dev).
 */
export async function getGlobalSkillRegistry(
  options: GetSkillRegistryOptions = {}
): Promise<SkillRegistry> {
  const root = options.rootDirOverride ?? defaultSkillsRoot();
  if (options.forceReload || cached === null || cachedRoot !== root) {
    cachedRoot = root;
    cached = loadGlobalSkillRegistry(root, {
      onParseError: (err) => {
        // Non-fatal at runtime: we log once and continue without that skill.
        // The selector will simply not see the broken slug.
        console.warn(
          `[skills] failed to parse skill at ${err.sourcePath}: ${err.message}`
        );
      },
    }).catch((err) => {
      // Bust the cache on hard failure so a subsequent turn can retry.
      cached = null;
      cachedRoot = null;
      throw err;
    });
  }
  return cached;
}

/** Force the next call to `getGlobalSkillRegistry` to reload from disk. */
export function resetGlobalSkillRegistryForTests(): void {
  cached = null;
  cachedRoot = null;
}

/**
 * Build the playbook block that gets appended to the system prompt when a
 * skill is active for this turn. The format is intentionally minimal so
 * `appendXxxRules()` chain still wins on tool-specific guidance — the
 * playbook adds DOMAIN context, not tool overrides.
 */
export function buildPlaybookInjection(resolved: ResolvedSkill): string {
  return [
    "",
    "",
    "---",
    "",
    `## Playbook activo: ${resolved.rootName}`,
    "",
    resolved.body.trim(),
  ].join("\n");
}
