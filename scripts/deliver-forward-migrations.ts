/**
 * Delivers forward-era migrations to a target environment — the NORMAL path for
 * every migration from the cutover onward.
 *
 * Mechanism: `supabase db push --workdir packages/db/forward --db-url <target>`.
 * The workdir isolation is what makes B′ work: the CLI discovers only the
 * forward era, never the frozen legacy chain it cannot represent.
 *
 * No baseline is created. `supabase_migrations.schema_migrations` comes into
 * existence with the first genuine forward migration.
 *
 * Dry-run is the DEFAULT. Delivery (this) and hosted verification
 * (`verify-hosted.ts`) are deliberately separate steps.
 *
 * Usage:
 *   npm run deliver:forward -- --env-file .env.staging.local --env staging
 *   npm run deliver:forward -- --env-file .env.staging.local --env staging --apply
 */
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTarget, assertBinding, describeTarget, parseTargetArgs } from "./lib/target-env";
import { listForwardMigrations, validateForwardSet } from "./lib/forward-migrations.mjs";
import { readLegacyChain } from "./lib/legacy-manifest.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const FORWARD_WORKDIR = path.join(REPO_ROOT, "packages", "db", "forward");

async function main(): Promise<void> {
  const args = parseTargetArgs(process.argv.slice(2));
  const target = resolveTarget(args);
  assertBinding(target);
  console.log(describeTarget(target));
  console.log(`mode: ${args.apply ? "APPLY" : "dry-run (pass --apply to write)"}`);

  const forward = await listForwardMigrations();
  const legacy = (await readLegacyChain()).map((f) => f.file);
  const structure = validateForwardSet(forward, legacy);
  if (!structure.ok) {
    throw new Error(`forward migration set is invalid:\n  - ${structure.errors.join("\n  - ")}`);
  }

  if (forward.length === 0) {
    console.log(
      "forward era is empty — nothing to deliver. This is the expected state until the " +
        "first genuine post-cutover migration (no artificial baseline is created)."
    );
    return;
  }
  console.log(`forward migrations to consider: ${forward.length}`);

  const cliArgs = [
    "db",
    "push",
    "--workdir",
    FORWARD_WORKDIR,
    "--db-url",
    target.databaseUrl,
    ...(args.apply ? [] : ["--dry-run"]),
  ];
  // The connection string is passed as an argv element, never echoed.
  console.log(
    `running: supabase db push --workdir packages/db/forward --db-url <redacted>${args.apply ? "" : " --dry-run"}`
  );

  const result = spawnSync("supabase", cliArgs, { stdio: "inherit", shell: process.platform === "win32" });
  if (result.error) {
    throw new Error(
      `could not run the Supabase CLI (${result.error.message}). ` +
        "Install it, or in CI use the supabase/setup-cli action."
    );
  }
  if (result.status !== 0) {
    throw new Error(`supabase db push exited with code ${result.status}`);
  }
  console.log(args.apply ? "delivery complete." : "dry-run complete — nothing was written.");
}

void main().catch((error) => {
  console.error(`deliver-forward-migrations: ${(error as Error).message}`);
  process.exitCode = 1;
});
