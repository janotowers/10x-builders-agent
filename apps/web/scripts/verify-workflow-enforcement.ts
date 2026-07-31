/**
 * S1.7 evidence: proves the current workflow_enforcement_mode behaves as
 * expected for an illegal protected-key proposal on a real pinned case.
 *
 * Uso:
 *   npx tsx --env-file=apps/web/.env.local apps/web/scripts/verify-workflow-enforcement.ts
 *   npx tsx --env-file=apps/web/.env.local apps/web/scripts/verify-workflow-enforcement.ts --case <uuid>
 *
 * Does not mutate the case step/status. Only appends a divergence/rejection
 * telemetry event via adviseCaseTransition (same path production uses).
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { adviseCaseTransition } from "@agents/agent";
import {
  getOperationalCase,
  getWorkflowEnforcementMode,
} from "@agents/db";

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
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[line.slice(0, idx).trim()] = value;
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const caseArg = args.indexOf("--case");
  const caseIdArg = caseArg >= 0 ? args[caseArg + 1] : undefined;

  const env = { ...loadEnv(ENV_PATH), ...process.env };
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Missing Supabase credentials in .env.local");
  }
  const db = createClient(url, key);

  let caseId = caseIdArg;
  if (!caseId) {
    const { data, error } = await db
      .from("operational_cases")
      .select("id")
      .eq("case_type", "property_optioning")
      .not("workflow_definition_id", "is", null)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    caseId = data?.id as string | undefined;
  }
  if (!caseId) {
    throw new Error("No pinned property_optioning case found");
  }

  const opCase = await getOperationalCase(db, caseId);
  if (!opCase) throw new Error(`case not found: ${caseId}`);

  const mode = await getWorkflowEnforcementMode(db, opCase.user_id);
  const before = new Date().toISOString();
  const advice = await adviseCaseTransition({
    db,
    opCase,
    proposal: {
      toStep: opCase.current_step,
      toStatus: opCase.status,
      proposer: "model",
      contextPatchKeys: ["publication", "published"],
    },
    site: "s1_7_enforcement_probe",
  });

  const { data: events, error: eventsError } = await db
    .from("operational_case_events")
    .select("id, payload_jsonb, created_at")
    .eq("case_id", caseId)
    .eq("event_type", "state_changed")
    .gte("created_at", before)
    .order("created_at", { ascending: false })
    .limit(5);
  if (eventsError) throw eventsError;

  const probeEvent = (events ?? []).find((row) => {
    const payload = row.payload_jsonb as Record<string, unknown> | null;
    return (
      payload?.site === "s1_7_enforcement_probe" &&
      (payload?.kind === "transition_rejected" ||
        payload?.kind === "transition_divergence")
    );
  });

  const result = {
    case_id: caseId,
    mode,
    advice_mode: advice.mode,
    verdict: advice.verdict?.verdict ?? null,
    reject: advice.reject,
    probe_event_kind:
      probeEvent &&
      typeof probeEvent.payload_jsonb === "object" &&
      probeEvent.payload_jsonb &&
      "kind" in probeEvent.payload_jsonb
        ? (probeEvent.payload_jsonb as { kind?: string }).kind
        : null,
  };

  console.log(JSON.stringify(result, null, 2));

  if (advice.verdict?.verdict !== "illegal") {
    throw new Error("expected illegal verdict for protected publication keys");
  }
  if (!probeEvent) {
    throw new Error("expected transition_* event from probe");
  }
  if (mode === "enforcing") {
    if (!advice.reject) {
      throw new Error("enforcing mode must reject illegal proposals");
    }
    if (result.probe_event_kind !== "transition_rejected") {
      throw new Error("enforcing mode must emit transition_rejected");
    }
  } else if (mode === "advisory") {
    if (advice.reject) {
      throw new Error("advisory mode must not reject");
    }
    if (result.probe_event_kind !== "transition_divergence") {
      throw new Error("advisory mode must emit transition_divergence");
    }
  }

  console.log("verify-workflow-enforcement: ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
