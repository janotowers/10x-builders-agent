#!/usr/bin/env node
/**
 * Creates a forward-era migration with a globally unique timestamp version.
 *
 * Use this instead of hand-naming files: it puts the migration in the forward
 * workdir (never the frozen legacy directory) and guarantees the version the
 * Supabase CLI can record in supabase_migrations.schema_migrations.
 *
 * Usage: npm run migration:new -- add_widget_table
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  FORWARD_DIR,
  listForwardMigrations,
  newVersion,
} from "./lib/forward-migrations.mjs";
import { readLegacyChain } from "./lib/legacy-manifest.mjs";

async function main() {
  const raw = process.argv.slice(2).filter((a) => !a.startsWith("--"))[0];
  if (!raw) {
    console.error("usage: npm run migration:new -- <snake_case_name>");
    process.exit(1);
  }
  const name = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!name) {
    console.error("name must contain at least one alphanumeric character");
    process.exit(1);
  }

  let version = newVersion();
  const existing = new Set(await listForwardMigrations());
  // Two migrations created in the same second would collide on the primary key
  // of the history table — the exact defect the legacy era is frozen for.
  while ([...existing].some((f) => f.startsWith(`${version}_`))) {
    version = String(BigInt(version) + 1n);
  }

  const file = `${version}_${name}.sql`;
  const target = path.join(FORWARD_DIR, file);
  const legacy = await readLegacyChain();
  const lastLegacy = legacy.at(-1)?.file ?? "(none)";

  await fs.mkdir(FORWARD_DIR, { recursive: true });
  await fs.writeFile(
    target,
    `-- ${file}\n` +
      `--\n` +
      `-- Forward-era migration (B'). Applied by the Supabase CLI against the\n` +
      `-- forward workdir and recorded in supabase_migrations.schema_migrations.\n` +
      `-- The frozen legacy chain (through ${lastLegacy}) is applied separately by\n` +
      `-- the ordered-apply bootstrap path and is never touched by the CLI.\n` +
      `--\n` +
      `-- Keep migrations additive and reversible-by-flag where they carry behavior.\n` +
      `\n`,
    "utf8"
  );

  console.log(`created ${path.relative(process.cwd(), target)}`);
  console.log("next: edit it, then `npm run validate:migrations`");
}

main().catch((error) => {
  console.error("new-forward-migration: unexpected failure", error);
  process.exit(1);
});
