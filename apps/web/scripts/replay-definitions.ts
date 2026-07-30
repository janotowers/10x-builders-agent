// Slice 1.6-3 driver: replays recent pinned cases through the production
// transition evaluator and prints a per-case summary. Inserts one evidence
// record per replay (gate: historical_replay) unless --no-evidence.
//
// Usage: npm run test:replay --workspace @agents/web [-- --limit 20 --no-evidence]
// Reads SUPABASE creds from apps/web/.env.local.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { replayRecentCases } from "../src/lib/operational-cases/replay-definition";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = resolve(__dirname, "..", ".env.local");

function loadEnv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return out;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

async function main() {
  const env = loadEnv(ENV_PATH);
  const url = env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.log("replay-definitions: no Supabase creds (.env.local); skipping.");
    return;
  }
  const args = process.argv.slice(2);
  const limitArg = args.indexOf("--limit");
  const limit = limitArg >= 0 ? Number(args[limitArg + 1]) || 20 : 20;
  const recordEvidence = !args.includes("--no-evidence");

  const db = createClient(url, key);
  const outcomes = await replayRecentCases(db, { limit, recordEvidence });
  if (outcomes.length === 0) {
    console.log("replay-definitions: no pinned cases found.");
    return;
  }
  let failures = 0;
  for (const outcome of outcomes) {
    const { result } = outcome;
    const status = result.ok
      ? result.divergences.length === 0
        ? "PASS"
        : "PASS (con divergencias)"
      : "FAIL";
    if (!result.ok) failures += 1;
    console.log(
      `${status} case=${outcome.caseId} def=v${outcome.definitionVersion} ` +
        `transiciones=${result.transitions.length} divergencias=${result.divergences.length} ` +
        `huecos=${result.unrecordedGaps} ` +
        `terminal=${result.terminalStep ?? "(none)"} esperado=${result.expectedTerminalStep ?? "(none)"}` +
        (outcome.evidenceId ? ` evidence=${outcome.evidenceId}` : "")
    );
    for (const divergence of result.divergences) {
      console.log(
        `  · divergencia #${divergence.index}: ${divergence.from ?? "(inicio)"}→${divergence.to} ` +
          `(${divergence.reason ?? divergence.failedGuards.join(",")})`
      );
    }
  }
  console.log(
    `replay-definitions: ${outcomes.length} caso(s), ${failures} con terminal distinto.`
  );
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
