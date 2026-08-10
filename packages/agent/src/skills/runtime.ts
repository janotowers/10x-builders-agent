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
import { buildRegistryFromRecords, loadGlobalSkillRegistry } from "./registry";
import { parseAccountSkillSource, SkillParseError } from "./parse";
import type { ResolvedSkill, SkillRecord, SkillRegistry } from "./types";
import type { DbClient } from "@agents/db";
import { listActiveAccountSkillsForUser } from "@agents/db";

let cached: Promise<SkillRegistry> | null = null;
let cachedRoot: string | null = null;
let lastResolvedRootLogged: string | null = null;

/**
 * A single draft account skill supplied by an authenticated, server-side
 * qualification caller. This is deliberately turn-scoped: it is never added
 * to the process cache or persisted by the agent runtime.
 */
export interface SkillUnderTestInput {
  readonly slug: string;
  readonly userId: string;
  readonly bodyMd: string;
}

export class SkillUnderTestValidationError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "SkillUnderTestValidationError";
  }
}

export function validateSkillUnderTestInput(
  skillUnderTest: SkillUnderTestInput,
  turnUserId: string
): void {
  if (
    !skillUnderTest ||
    typeof skillUnderTest !== "object" ||
    Array.isArray(skillUnderTest)
  ) {
    throw new SkillUnderTestValidationError(
      "skillUnderTest must be a single draft skill object"
    );
  }
  if (
    typeof skillUnderTest.userId !== "string" ||
    skillUnderTest.userId.length === 0 ||
    skillUnderTest.userId !== skillUnderTest.userId.trim()
  ) {
    throw new SkillUnderTestValidationError(
      "skillUnderTest.userId must be a non-empty canonical user id"
    );
  }
  if (skillUnderTest.userId !== turnUserId) {
    throw new SkillUnderTestValidationError(
      "skillUnderTest.userId must match the runAgent userId"
    );
  }
  if (
    typeof skillUnderTest.slug !== "string" ||
    skillUnderTest.slug.length === 0 ||
    skillUnderTest.slug !== skillUnderTest.slug.trim()
  ) {
    throw new SkillUnderTestValidationError(
      "skillUnderTest.slug must be a non-empty canonical slug"
    );
  }
  if (typeof skillUnderTest.bodyMd !== "string") {
    throw new SkillUnderTestValidationError(
      "skillUnderTest.bodyMd must be a string"
    );
  }
}

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
 * Compose the global skill registry with a user's `account_skills` (V1
 * Opción B). Account skills with the same `name` shadow globals — this is
 * how a customer customises a global behaviour without losing the base.
 *
 * Errors parsing a single account skill are logged and the skill is dropped
 * (same policy as the global loader); other account skills still load.
 *
 * Cost: one DB read per call. Callers (cron heartbeat / case runner / web
 * turn) typically call this once per turn, so it is acceptable.
 */
export async function getSkillRegistryForUser(
  db: DbClient,
  userId: string,
  options: GetSkillRegistryOptions = {}
): Promise<SkillRegistry> {
  const globalRegistry = await getGlobalSkillRegistry(options);
  let accountSkills: Awaited<
    ReturnType<typeof listActiveAccountSkillsForUser>
  > = [];
  try {
    accountSkills = await listActiveAccountSkillsForUser(db, userId);
  } catch (err) {
    console.warn(
      `[skills] could not load account_skills for user=${userId}: ${(err as Error).message ?? err}`
    );
    return globalRegistry;
  }
  if (accountSkills.length === 0) return globalRegistry;

  const merged = new Map<string, SkillRecord>();
  for (const meta of globalRegistry.list()) {
    const rec = globalRegistry.get(meta.name);
    if (rec) merged.set(meta.name, rec);
  }
  for (const acc of accountSkills) {
    try {
      const record = parseAccountSkillSource(acc.body_md, acc.slug, acc.user_id);
      // Account wins over global on slug collision.
      merged.set(record.metadata.name, record);
    } catch (err) {
      if (err instanceof SkillParseError) {
        console.warn(
          `[skills] dropping account_skill ${acc.slug} for user=${userId}: ${err.message}`
        );
        continue;
      }
      throw err;
    }
  }
  return buildRegistryFromRecords(Array.from(merged.values()));
}

/**
 * Return a new registry where exactly one parsed draft account skill shadows
 * the tenant's normal registry. The base registry is not mutated, so the
 * draft cannot leak into selectors, cron runs, another tenant, or later calls.
 *
 * Ownership and slug checks are runtime checks (not just TypeScript checks)
 * because this input crosses a server boundary. Any mismatch or parse failure
 * is fatal to the qualification run.
 */
export function overlaySkillRegistryForTurn(
  baseRegistry: SkillRegistry,
  skillUnderTest: SkillUnderTestInput,
  turnUserId: string
): SkillRegistry {
  validateSkillUnderTestInput(skillUnderTest, turnUserId);

  let draftRecord: SkillRecord;
  try {
    draftRecord = parseAccountSkillSource(
      skillUnderTest.bodyMd,
      skillUnderTest.slug,
      skillUnderTest.userId
    );
  } catch (err) {
    throw new SkillUnderTestValidationError(
      `invalid skillUnderTest body for '${skillUnderTest.slug}'`,
      err
    );
  }

  const overlaid = new Map<string, SkillRecord>();
  for (const metadata of baseRegistry.list()) {
    const record = baseRegistry.get(metadata.name);
    if (record) overlaid.set(metadata.name, record);
  }
  overlaid.set(draftRecord.metadata.name, draftRecord);
  return buildRegistryFromRecords(Array.from(overlaid.values()));
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
