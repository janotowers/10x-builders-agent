/**
 * Applies the FROZEN legacy migration chain to a target database.
 *
 * This is historical/bootstrap machinery, NOT the normal way to ship a
 * migration. It exists because the 87 legacy files contain duplicated numeric
 * prefixes the Supabase CLI cannot record, so they can only be applied by
 * ordered-apply. Use it to stand up a NEW environment to the cutover point.
 *
 * Future migrations use the forward era instead:
 *   npm run migration:new   → npm run deliver:forward
 *
 * Ordering is full-filename lexicographic — the same order validate-migrations
 * and the RLS harness use, and what disambiguates the duplicated prefixes.
 *
 * Usage:
 *   npm run deliver:legacy -- --env-file .env.staging.local --env staging          # dry-run
 *   npm run deliver:legacy -- --env-file .env.staging.local --env staging --apply
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { resolveTarget, assertBinding, describeTarget, parseTargetArgs } from "./lib/target-env";
import { readLegacyChain, readManifest, diffAgainstManifest } from "./lib/legacy-manifest.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(__dirname, "..", "packages", "db", "supabase", "migrations");
const require_ = createRequire(import.meta.url);
const { Client } = require_("pg") as typeof import("pg");

async function main(): Promise<void> {
  const args = parseTargetArgs(process.argv.slice(2));
  const target = resolveTarget(args);
  assertBinding(target);
  console.log(describeTarget(target));
  console.log(`mode: ${args.apply ? "APPLY" : "dry-run (pass --apply to write)"}`);

  // Never ship a chain that does not match the frozen manifest.
  const chain = await readLegacyChain(MIGRATIONS);
  const frozen = diffAgainstManifest(chain, await readManifest());
  if (!frozen.ok) {
    throw new Error(`frozen legacy chain integrity check failed:\n  - ${frozen.errors.join("\n  - ")}`);
  }
  console.log(`frozen legacy chain verified: ${chain.length} files`);

  const client = new Client({ connectionString: target.databaseUrl });
  await client.connect();
  try {
    const existing = await client.query<{ n: string }>(
      "select count(*)::text as n from information_schema.tables where table_schema='public'"
    );
    console.log(`target public tables before: ${existing.rows[0].n}`);

    if (!args.apply) {
      console.log(`would apply ${chain.length} migrations in filename order`);
      console.log("dry-run complete — nothing was written.");
      return;
    }

    let applied = 0;
    for (const { file } of chain) {
      const sql = await fs.readFile(path.join(MIGRATIONS, file), "utf8");
      try {
        await client.query(sql);
        applied += 1;
      } catch (error) {
        throw new Error(
          `FAILED at ${file} after ${applied} applied: ${(error as Error).message}`
        );
      }
    }
    console.log(`applied ${applied}/${chain.length}`);

    const hist = await client.query<{ p: boolean }>(
      "select to_regclass('supabase_migrations.schema_migrations') is not null as p"
    );
    // The legacy era deliberately creates no CLI history; the forward era owns it.
    console.log(`CLI migration history present: ${hist.rows[0].p} (expected false at cutover)`);
  } finally {
    await client.end();
  }
}

void main().catch((error) => {
  console.error(`apply-legacy-chain: ${(error as Error).message}`);
  process.exitCode = 1;
});
