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
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadGlobalSkillRegistry } from "./registry";
import type { ResolvedSkill, SkillRegistry } from "./types";

let cached: Promise<SkillRegistry> | null = null;
let cachedRoot: string | null = null;
let lastResolvedRootLogged: string | null = null;

/**
 * Resolve the path of the repo root (or wherever the `skills/` directory
 * lives). The default tries, in order:
 *
 *   1. `SKILLS_ROOT_DIR` env (absolute or relative to `process.cwd()`).
 *   2. Walk up from this file's URL using `import.meta.url` (works under
 *      tsx/ts-node and ESM-bundled Next/Turbopack).
 *   3. Walk up from `__dirname` (only defined under CommonJS).
 *   4. Walk up from `process.cwd()` looking for a `skills/global` folder
 *      (handles cases where Next/Turbopack rewrote the file URL).
 *
 * The first candidate that contains `skills/global` wins. Tests override
 * `rootDirOverride` to point at a temp directory.
 */
export function defaultSkillsRoot(): string {
  const envRoot = process.env.SKILLS_ROOT_DIR?.trim();
  if (envRoot) {
    return isAbsolute(envRoot) ? envRoot : resolve(process.cwd(), envRoot);
  }

  const candidates: string[] = [];

  try {
    const here = dirname(fileURLToPath(import.meta.url));
    candidates.push(join(here, "..", "..", "..", ".."));
  } catch {
    // import.meta.url unavailable (CJS host); fall through.
  }

  if (typeof __dirname === "string" && __dirname.length > 0) {
    candidates.push(join(__dirname, "..", "..", "..", ".."));
  }

  let cwd = process.cwd();
  for (let i = 0; i < 6; i++) {
    candidates.push(cwd);
    const parent = dirname(cwd);
    if (parent === cwd) break;
    cwd = parent;
  }

  for (const candidate of candidates) {
    if (existsSync(join(candidate, "skills", "global"))) {
      return candidate;
    }
  }

  return candidates[0] ?? process.cwd();
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
    })
      .then((reg) => {
        if (lastResolvedRootLogged !== root) {
          lastResolvedRootLogged = root;
          console.log(
            `[skills] registry loaded root=${root} count=${reg.size}`
          );
        }
        return reg;
      })
      .catch((err) => {
        // Bust the cache on hard failure so a subsequent turn can retry.
        cached = null;
        cachedRoot = null;
        lastResolvedRootLogged = null;
        throw err;
      });
  }
  return cached;
}

/** Force the next call to `getGlobalSkillRegistry` to reload from disk. */
export function resetGlobalSkillRegistryForTests(): void {
  cached = null;
  cachedRoot = null;
  lastResolvedRootLogged = null;
}

/**
 * Last `rootDir` used by `getGlobalSkillRegistry`. Useful for diagnostics
 * (turn log, health endpoints) so we can tell whether the loader pointed
 * at the right directory. Returns `null` until the first registry load.
 */
export function getCachedSkillsRegistryRoot(): string | null {
  return cachedRoot;
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
