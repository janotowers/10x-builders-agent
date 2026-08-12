/**
 * Diagnose Studio / Opus metering coverage in ai_usage_events.
 *
 * Helps answer: "why does OpenRouter show more Opus spend than the UI?"
 * Past CLI evals that ran without ambient context left no rows — this script
 * cannot reconstruct them; it shows what *is* ledgered by channel.
 *
 * Usage (from apps/web):
 *   npx tsx scripts/check-ai-usage-studio-gap.ts [--days 30]
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createServerClient,
  formatUsdFromMicro,
  listAiUsageEvents,
  totalEffectiveCostMicroUsd,
} from "@agents/db";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnv(path: string): void {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
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
    if (!process.env[key]) process.env[key] = value;
  }
}

function argNumber(flag: string, fallback: number): number {
  const eq = process.argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) {
    const n = Number(eq.split("=")[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const i = process.argv.indexOf(flag);
  if (i >= 0) {
    const n = Number(process.argv[i + 1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return fallback;
}

function argString(flag: string): string | null {
  const eq = process.argv.find((argument) =>
    argument.startsWith(`${flag}=`)
  );
  if (eq) return eq.slice(flag.length + 1).trim() || null;
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1]?.trim() || null : null;
}

loadEnv(resolve(__dirname, "..", ".env.local"));

async function main(): Promise<void> {
  const days = argNumber("--days", 30);
  const benchmarkId = argString("--benchmark-id");
  const db = createServerClient();
  const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  // Any admin-wide read needs a user id for the helper contract; use a
  // placeholder — adminWide ignores tenant filter.
  const loadedEvents = await listAiUsageEvents(db, {
    userId: "00000000-0000-0000-0000-000000000000",
    adminWide: true,
    sinceIso,
    limit: 10_000,
  });
  const events = benchmarkId
    ? loadedEvents.filter(
        (event) => event.metadata_jsonb?.benchmark_id === benchmarkId
      )
    : loadedEvents;

  const opus = events.filter((e) => e.model_id.includes("opus"));
  const studioRoles = new Set([
    "workflow_compiler",
    "studio_authoring_router",
    "studio_authoring_discovery",
    "studio_authoring_proposal_audit",
    "studio_authoring_recipient_provenance_verifier",
    "studio_case_compiler",
    "studio_durable_task_compiler",
    "studio_reusable_skill_compiler",
    "studio_skill_repair",
    "studio_capability_coder",
    "studio_operational_judge",
  ]);
  const studio = events.filter((event) => studioRoles.has(event.model_role));

  const byChannel = (rows: typeof events) => {
    const map = new Map<
      string,
      { events: number; costMicro: number; reported: number }
    >();
    for (const row of rows) {
      const key = row.channel ?? "(null)";
      const bucket = map.get(key) ?? { events: 0, costMicro: 0, reported: 0 };
      bucket.events += 1;
      bucket.costMicro +=
        row.reported_cost_micro_usd ?? row.estimated_cost_micro_usd ?? 0;
      if (row.reported_cost_micro_usd != null) bucket.reported += 1;
      map.set(key, bucket);
    }
    return [...map.entries()].sort((a, b) => b[1].costMicro - a[1].costMicro);
  };

  console.log(
    `Window: last ${days} days · loaded ${events.length} events${
      benchmarkId ? ` · benchmark=${benchmarkId}` : ""
    }`
  );
  console.log(
    `All models accounted: ${formatUsdFromMicro(totalEffectiveCostMicroUsd(events))}`
  );
  console.log("");
  console.log(
    `Opus model_id (*opus*): ${opus.length} calls · ${formatUsdFromMicro(
      totalEffectiveCostMicroUsd(opus)
    )}`
  );
  for (const [channel, bucket] of byChannel(opus)) {
    console.log(
      `  channel=${channel} · calls=${bucket.events} · accounted=${formatUsdFromMicro(
        bucket.costMicro
      )} · reported=${bucket.reported}/${bucket.events}`
    );
  }
  console.log("");
  console.log(
    `Studio model roles: ${studio.length} calls · ${formatUsdFromMicro(
      totalEffectiveCostMicroUsd(studio)
    )}`
  );
  const studioByRole = new Map<string, typeof studio>();
  for (const event of studio) {
    const rows = studioByRole.get(event.model_role) ?? [];
    rows.push(event);
    studioByRole.set(event.model_role, rows);
  }
  for (const [role, rows] of [...studioByRole.entries()].sort((a, b) =>
    a[0].localeCompare(b[0])
  )) {
    console.log(
      `  role=${role} · calls=${rows.length} · accounted=${formatUsdFromMicro(
        totalEffectiveCostMicroUsd(rows)
      )}`
    );
  }

  const cliRows = events.filter((e) => e.channel === "cli");
  console.log("");
  if (cliRows.length === 0) {
    console.log(
      "No channel=cli rows in this window. Historical live evals/scripts that " +
        "ran without withCliAiUsageMetering left no ledger rows (OpenRouter " +
        "still billed). Going forward: npm run eval:authoring-discovery " +
        "(requires --user or AI_USAGE_CLI_USER_ID)."
    );
  } else {
    console.log(
      `channel=cli: ${cliRows.length} calls · ${formatUsdFromMicro(
        totalEffectiveCostMicroUsd(cliRows)
      )} (these are local eval/script spends that are now ledgered)`
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
