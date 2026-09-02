#!/usr/bin/env node
/**
 * Regenerates the frozen legacy migration manifest.
 *
 * This is NOT part of the normal workflow. The legacy chain is frozen; running
 * this rewrites the integrity baseline and should happen only under an explicit
 * approved decision (for example, a governed correction to historical files).
 * Everyday forward work uses `npm run migration:new` instead.
 *
 * Usage: npm run migrations:freeze -- --confirm
 */
import { promises as fs } from "node:fs";
import {
  MANIFEST_PATH,
  buildManifest,
  readLegacyChain,
  readManifest,
  diffAgainstManifest,
} from "./lib/legacy-manifest.mjs";

async function main() {
  const confirmed = process.argv.includes("--confirm");
  const actual = await readLegacyChain();

  let existing = null;
  try {
    existing = await readManifest();
  } catch {
    /* first run */
  }

  if (existing) {
    const { ok, errors } = diffAgainstManifest(actual, existing);
    if (ok) {
      console.log(`freeze-legacy-migrations: manifest already matches (${actual.length} files) — nothing to do.`);
      return;
    }
    console.log("freeze-legacy-migrations: the frozen set would change:");
    for (const e of errors) console.log(`  - ${e}`);
  }

  if (!confirmed) {
    console.error(
      "\nRefusing to rewrite the frozen manifest without --confirm.\n" +
        "The legacy chain is historical and already applied to deployed environments.\n" +
        "If you meant to add a migration, create a forward one instead:\n" +
        "  npm run migration:new -- <name>\n"
    );
    process.exit(1);
  }

  await fs.writeFile(MANIFEST_PATH, `${JSON.stringify(buildManifest(actual), null, 2)}\n`, "utf8");
  console.log(`freeze-legacy-migrations: wrote manifest for ${actual.length} files.`);
}

main().catch((error) => {
  console.error("freeze-legacy-migrations: unexpected failure", error);
  process.exit(1);
});
