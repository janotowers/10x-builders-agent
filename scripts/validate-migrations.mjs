#!/usr/bin/env node
/**
 * Guards Supabase migration numbering (flexible-workflows plan, Slice 0.5-3 /
 * Technical Plan §29.3).
 *
 * Historical duplicates 00036 / 00044 / 00045 are IMMUTABLE deployed history:
 * the Supabase CLI orders files lexicographically by full filename, so within
 * one duplicated number the `_name` suffix decided the order, and renumbering
 * now would desync `supabase_migrations.schema_migrations` on every deployed
 * environment. They are allowlisted here; every NEW duplicate fails prebuild.
 *
 * Dependency-free on purpose so it runs in prebuild next to
 * validate-skills.mjs.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(
  __dirname,
  "..",
  "packages",
  "db",
  "supabase",
  "migrations"
);

/** Deployed duplicated prefixes — frozen history, never extend this list. */
const LEGACY_DUPLICATE_ALLOWLIST = new Map([
  [
    "00036",
    [
      "00036_notification_engagement_policy_overrides.sql",
      "00036_waiting_internal_status.sql",
    ],
  ],
  [
    "00044",
    [
      "00044_operational_case_conversation_bindings.sql",
      "00044_property_optioning_add_avaclick_tool.sql",
    ],
  ],
  [
    "00045",
    [
      "00045_operational_case_e2e_lab_sessions.sql",
      "00045_property_optioning_add_geocode_tool.sql",
    ],
  ],
]);

const FILENAME_RE = /^(\d{5})_[a-z0-9_]+\.sql$/;

async function main() {
  const entries = await fs.readdir(MIGRATIONS_DIR);
  const sqlFiles = entries.filter((name) => name.endsWith(".sql")).sort();
  const errors = [];
  const byPrefix = new Map();

  for (const name of sqlFiles) {
    const match = FILENAME_RE.exec(name);
    if (!match) {
      errors.push(
        `${name}: filename must match NNNNN_snake_case.sql (5-digit prefix).`
      );
      continue;
    }
    const prefix = match[1];
    const bucket = byPrefix.get(prefix) ?? [];
    bucket.push(name);
    byPrefix.set(prefix, bucket);
  }

  for (const [prefix, files] of byPrefix) {
    if (files.length === 1) continue;
    const allowed = LEGACY_DUPLICATE_ALLOWLIST.get(prefix);
    const isExactLegacySet =
      allowed &&
      allowed.length === files.length &&
      allowed.every((name, i) => files[i] === name);
    if (!isExactLegacySet) {
      errors.push(
        `Duplicate migration number ${prefix}: ${files.join(", ")}. ` +
          `Pick the next free number (numbers are append-only; the 00036/00044/00045 duplicates are frozen legacy).`
      );
    }
  }

  if (errors.length > 0) {
    console.error("validate-migrations: FAILED");
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  const maxPrefix = [...byPrefix.keys()].sort().at(-1);
  console.log(
    `validate-migrations: ok (${sqlFiles.length} files, latest ${maxPrefix}, ` +
      `${LEGACY_DUPLICATE_ALLOWLIST.size} frozen legacy duplicate numbers)`
  );
}

main().catch((error) => {
  console.error("validate-migrations: unexpected failure", error);
  process.exit(1);
});
