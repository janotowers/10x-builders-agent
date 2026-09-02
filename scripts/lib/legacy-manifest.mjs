/**
 * Frozen legacy migration set — integrity by exact set + content hash.
 *
 * The legacy chain (`packages/db/supabase/migrations`) is historical: it was
 * applied by hand to deployed environments and contains three duplicated
 * numeric prefixes (00036 / 00044 / 00045) that the Supabase CLI cannot
 * represent in its history table. It is therefore FROZEN. Freezing by
 * "no new duplicate prefix" is not enough — a new unique `00085_*.sql`, a
 * deletion, a rename or an edit to an already-applied file would all pass that
 * weaker rule while silently changing what a fresh rebuild produces.
 *
 * This module is the strong form: the manifest pins the exact file set and the
 * sha256 of every file. Any addition, removal, rename or content change fails.
 * Forward work goes to the forward-only workdir instead (see packages/db/forward).
 *
 * Dependency-free on purpose so it runs in prebuild next to the other validators.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

export const LEGACY_DIR = path.join(REPO_ROOT, "packages", "db", "supabase", "migrations");
export const MANIFEST_PATH = path.join(REPO_ROOT, "packages", "db", "supabase", "legacy-manifest.json");

export function sha256(text) {
  // Normalise line endings so the manifest is stable across platforms: this
  // repo is developed on Windows (CRLF in the working copy) and verified in
  // Linux CI, and git may translate on checkout.
  return createHash("sha256").update(text.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

/** Reads the on-disk legacy chain as `{ file, sha256 }[]`, sorted by filename. */
export async function readLegacyChain(dir = LEGACY_DIR) {
  const names = (await fs.readdir(dir)).filter((n) => n.endsWith(".sql")).sort();
  const out = [];
  for (const file of names) {
    out.push({ file, sha256: sha256(await fs.readFile(path.join(dir, file), "utf8")) });
  }
  return out;
}

export async function readManifest(manifestPath = MANIFEST_PATH) {
  return JSON.parse(await fs.readFile(manifestPath, "utf8"));
}

/**
 * Compares an actual chain against a manifest. Pure so it can be unit-tested
 * without touching the filesystem.
 *
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function diffAgainstManifest(actual, manifest) {
  const errors = [];
  const expected = manifest.files ?? [];

  if (typeof manifest.count === "number" && manifest.count !== expected.length) {
    errors.push(
      `manifest is internally inconsistent: count=${manifest.count} but lists ${expected.length} files`
    );
  }

  const expectedByName = new Map(expected.map((f) => [f.file, f.sha256]));
  const actualByName = new Map(actual.map((f) => [f.file, f.sha256]));

  for (const { file, sha256: want } of expected) {
    if (!actualByName.has(file)) {
      errors.push(`frozen legacy migration removed or renamed: ${file}`);
      continue;
    }
    const got = actualByName.get(file);
    if (got !== want) {
      errors.push(
        `frozen legacy migration modified: ${file} (expected sha256 ${want.slice(0, 12)}…, found ${got.slice(0, 12)}…)`
      );
    }
  }

  for (const { file } of actual) {
    if (!expectedByName.has(file)) {
      errors.push(
        `new file added to the FROZEN legacy directory: ${file}. ` +
          `Forward migrations belong in packages/db/forward/supabase/migrations ` +
          `(create one with: npm run migration:new -- <name>).`
      );
    }
  }

  // Order is part of the contract: the chain is applied by full-filename sort,
  // and that ordering is what disambiguates the duplicated numeric prefixes.
  const expectedOrder = expected.map((f) => f.file);
  const actualOrder = actual.map((f) => f.file);
  if (
    errors.length === 0 &&
    JSON.stringify(expectedOrder) !== JSON.stringify(actualOrder)
  ) {
    errors.push("frozen legacy migration order changed");
  }

  return { ok: errors.length === 0, errors };
}

/** Builds the manifest object for an actual chain. */
export function buildManifest(actual) {
  return {
    $comment:
      "FROZEN legacy migration chain. Historical, applied by hand to deployed environments, " +
      "and containing three duplicated numeric prefixes the Supabase CLI cannot represent. " +
      "Never add, remove, rename or edit these files — forward migrations live in " +
      "packages/db/forward/supabase/migrations. Regenerate ONLY with an explicit approved " +
      "decision: npm run migrations:freeze.",
    frozenAt: "SL-0 closure (Technical Plan v1.4)",
    count: actual.length,
    files: actual,
  };
}
