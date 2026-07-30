// One-off generator for Slice 1.1-3: reads the GLOBAL operational_case_types
// rows, runs the production flow→graph transformer, validates the result and
// prints the graph JSON + definition hash for embedding into migration 00066.
//
// Usage: npx tsx scripts/generate-workflow-definition-seeds.ts
// Reads SUPABASE creds from apps/web/.env.local.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import type { OperationalCaseFlowStep } from "@agents/types";
import {
  computeDefinitionHash,
  registerBuiltinGuards,
  registeredGuardNames,
  transformFlowToGraph,
  validateWorkflowGraph,
} from "@agents/workflows";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = resolve(__dirname, "..", "apps", "web", ".env.local");

function loadEnv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  const text = readFileSync(path, "utf8");
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
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("missing supabase creds in .env.local");
  const db = createClient(url, key);

  const { data, error } = await db
    .from("operational_case_types")
    .select("case_type, display_name, operational_flow_jsonb")
    .is("user_id", null)
    .order("case_type");
  if (error) throw error;

  registerBuiltinGuards();
  const knownGuards = registeredGuardNames();

  for (const row of data ?? []) {
    const flow = (row.operational_flow_jsonb ?? []) as OperationalCaseFlowStep[];
    if (flow.length === 0) {
      console.log(`-- ${row.case_type}: EMPTY FLOW, skipping`);
      continue;
    }
    const graph = transformFlowToGraph({ caseType: row.case_type, flow });
    const validation = validateWorkflowGraph(graph, { knownGuards });
    if (!validation.ok) {
      console.log(
        `-- ${row.case_type}: VALIDATION FAILED`,
        JSON.stringify(validation.issues, null, 2)
      );
      continue;
    }
    const hash = computeDefinitionHash(graph);
    console.log(`\n=== ${row.case_type} (${row.display_name}) ===`);
    console.log(`hash: ${hash}`);
    console.log(`graph:`);
    console.log(JSON.stringify(graph));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
