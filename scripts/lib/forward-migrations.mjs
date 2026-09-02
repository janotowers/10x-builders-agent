/**
 * Forward-only migration era (B′).
 *
 * Future migrations live in their own Supabase workdir so the CLI never sees
 * the frozen legacy chain. The CLI discovers `<workdir>/supabase/migrations`,
 * so the workdir root is `packages/db/forward`.
 *
 * There is NO artificial baseline: `supabase_migrations.schema_migrations` is
 * created by the first genuine post-cutover migration. A remote-only baseline
 * row was measured to produce "Remote migration versions not found in local
 * migrations directory", which is exactly the synthetic drift we refuse to
 * create.
 *
 * Versions are 14-digit UTC timestamps, which sort after every 5-digit legacy
 * version, so `legacy → forward` is a single deterministic total order even
 * though the eras live in two directories.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

export const FORWARD_WORKDIR = path.join(REPO_ROOT, "packages", "db", "forward");
export const FORWARD_DIR = path.join(FORWARD_WORKDIR, "supabase", "migrations");

/** `<14-digit timestamp>_<snake_case>.sql` — the Supabase CLI's own convention. */
export const FORWARD_FILENAME_RE = /^(\d{14})_[a-z0-9_]+\.sql$/;

export async function listForwardMigrations(dir = FORWARD_DIR) {
  let entries = [];
  try {
    entries = await fs.readdir(dir);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return entries.filter((n) => n.endsWith(".sql")).sort();
}

/**
 * Structural rules for the forward era. Pure, so it is unit-testable.
 *
 * @param {string[]} forwardNames  filenames in the forward directory
 * @param {string[]} legacyNames   filenames in the frozen legacy directory
 */
export function validateForwardSet(forwardNames, legacyNames) {
  const errors = [];
  const seen = new Map();

  for (const name of forwardNames) {
    const m = FORWARD_FILENAME_RE.exec(name);
    if (!m) {
      errors.push(
        `${name}: forward migrations must be <14-digit-timestamp>_snake_case.sql ` +
          `(create one with: npm run migration:new -- <name>)`
      );
      continue;
    }
    const version = m[1];
    if (seen.has(version)) {
      // The history table keys on version; two files sharing one can never both
      // be recorded. This is the exact defect the legacy era is frozen for.
      errors.push(
        `duplicate forward migration version ${version}: ${seen.get(version)}, ${name}. ` +
          `Versions must be globally unique — supabase_migrations.schema_migrations keys on them.`
      );
      continue;
    }
    seen.set(version, name);
  }

  // A forward version must never collide with a legacy one, and must sort after
  // every legacy version so the two eras compose into one total order.
  const legacyVersions = new Set(
    legacyNames.map((n) => n.slice(0, n.indexOf("_"))).filter(Boolean)
  );
  for (const [version, name] of seen) {
    if (legacyVersions.has(version)) {
      errors.push(`forward migration ${name} reuses a legacy version ${version}`);
    }
    if (legacyVersions.size > 0) {
      const maxLegacy = [...legacyVersions].sort().at(-1);
      if (version <= maxLegacy) {
        errors.push(
          `forward migration ${name} sorts at or before the last legacy version ${maxLegacy}; ` +
            `forward versions must sort strictly after the frozen era`
        );
      }
    }
  }

  return { ok: errors.length === 0, errors, versions: [...seen.keys()].sort() };
}

/** UTC timestamp version for a new forward migration. */
export function newVersion(now = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return (
    `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
    `${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`
  );
}
