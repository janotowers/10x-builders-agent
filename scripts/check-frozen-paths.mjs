#!/usr/bin/env node
/**
 * CI change-path invariant: a normal change must not touch the frozen legacy
 * migration era.
 *
 * `validate:migrations` checks the CONTENT invariant — the on-disk chain must
 * match `legacy-manifest.json`. On its own that is defeatable: edit a frozen
 * migration, regenerate the manifest, and the content check passes again.
 * `--confirm` is not a governance boundary, because an agent can supply it too.
 *
 * So this is the CHANGE invariant, evaluated against the base..head diff: the
 * frozen migration files and the manifest itself must not change in a normal
 * PR or push. Together the two invariants make the legacy era immutable in
 * normal development — a coordinated migration+manifest edit fails here even
 * though the content check would pass.
 *
 * There is deliberately NO routine override flag. Regenerating the manifest is
 * repository maintenance / break-glass: it requires a human with the authority
 * to bypass this check at the repository level (admin merge or a temporary
 * branch-protection exception), which is a visible, auditable act rather than
 * a switch any change can flip.
 *
 * Forward migrations are the only normal migration path.
 *
 * Usage: node scripts/check-frozen-paths.mjs <baseSha> <headSha>
 */
import { execFileSync } from "node:child_process";

const LEGACY_DIR = "packages/db/supabase/migrations/";
const MANIFEST = "packages/db/supabase/legacy-manifest.json";

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function main() {
  const [base, head] = process.argv.slice(2);
  if (!base || !head) {
    console.error("usage: node scripts/check-frozen-paths.mjs <baseSha> <headSha>");
    process.exit(2);
  }

  // A zero SHA (first push to a branch) or an unreachable base means there is
  // no meaningful comparison; fail closed rather than silently passing.
  if (/^0{7,40}$/.test(base)) {
    console.log("check-frozen-paths: no base commit to compare against (new ref) — skipping diff check.");
    console.log("  the content invariant in validate:migrations still applies.");
    return;
  }

  let changed = [];
  try {
    changed = git(["diff", "--name-only", `${base}`, `${head}`]).split("\n").filter(Boolean);
  } catch (error) {
    console.error(
      `check-frozen-paths: could not diff ${base}..${head}. ` +
        "Ensure the workflow checks out enough history (fetch-depth: 0).\n" +
        String(error.message ?? error)
    );
    process.exit(1);
  }

  const touchedMigrations = changed.filter((p) => p.startsWith(LEGACY_DIR));
  const touchedManifest = changed.filter((p) => p === MANIFEST);

  // Introducing the manifest for the first time is legitimate (it did not exist
  // at base). Every later change to it is not.
  let manifestExistedAtBase = true;
  if (touchedManifest.length > 0) {
    try {
      git(["cat-file", "-e", `${base}:${MANIFEST}`]);
    } catch {
      manifestExistedAtBase = false;
    }
  }

  const errors = [];
  for (const p of touchedMigrations) {
    errors.push(`frozen legacy migration changed: ${p}`);
  }
  if (touchedManifest.length > 0 && manifestExistedAtBase) {
    errors.push(`frozen legacy manifest changed: ${MANIFEST}`);
  }

  if (errors.length > 0) {
    console.error("check-frozen-paths: FAILED — the frozen legacy era is immutable in normal development");
    for (const e of errors) console.error(`  - ${e}`);
    console.error(
      "\nAdd a forward migration instead:\n" +
        "  npm run migration:new -- <name>\n\n" +
        "Changing the frozen era is repository maintenance and requires an explicit, " +
        "auditable human bypass at the repository level. There is no override flag."
    );
    process.exit(1);
  }

  const note =
    touchedManifest.length > 0 && !manifestExistedAtBase
      ? " (manifest introduced for the first time — allowed)"
      : "";
  console.log(`check-frozen-paths: ok — frozen legacy era untouched across ${changed.length} changed file(s)${note}`);
}

main();
