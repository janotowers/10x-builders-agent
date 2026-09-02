/**
 * READ-ONLY schema-state preflight for a target environment.
 *
 * Mandatory before delivering migrations to an environment whose state is not
 * proven — production in particular. The absence of CLI migration history is
 * NOT evidence that a given set of migrations has been applied: production's
 * chain was applied by hand and `supabase_migrations.schema_migrations` does
 * not exist there, so "which migrations are in place" can only be established
 * by inspecting actual objects.
 *
 * For the R1 transition this is the gate before 00080-00084 reach production.
 *
 * Strictly read-only: everything runs inside BEGIN TRANSACTION READ ONLY,
 * asserted before any query and rolled back. Writes nothing, ever.
 *
 * Usage:
 *   npm run preflight:schema -- --env-file .env.staging.local --env staging
 */
import { createRequire } from "node:module";
import { resolveTarget, assertBinding, describeTarget, parseTargetArgs } from "./lib/target-env";

const require_ = createRequire(import.meta.url);
const { Client } = require_("pg") as typeof import("pg");

/**
 * Objects the R1 substrate migrations (00080-00084) depend on or introduce.
 * `expected` = must already exist for those migrations to apply;
 * `introduced` = must NOT exist yet, or they have already been applied.
 */
const PREREQUISITE_TABLES = [
  "profiles",
  "operational_cases",
  "operational_case_types",
  "operational_case_events",
  "case_facts",
  "case_artifacts",
  "case_approvals",
  "work_items",
  "artifact_inputs",
];
const INTRODUCED_TABLES = [
  "organizations",
  "organization_memberships",
  "contacts",
  "organization_feature_flags",
  "organization_tool_secrets",
  "external_identity_bindings",
  "case_relationships",
];

async function main(): Promise<void> {
  const args = parseTargetArgs(process.argv.slice(2));
  if (args.apply) throw new Error("preflight is read-only; --apply is not accepted");
  const target = resolveTarget(args);
  assertBinding(target);
  console.log(describeTarget(target));

  const client = new Client({ connectionString: target.databaseUrl });
  await client.connect();
  try {
    await client.query("begin transaction read only");
    const ro = await client.query<{ transaction_read_only: string }>("show transaction_read_only");
    console.log(`transaction_read_only = ${ro.rows[0].transaction_read_only}`);
    if (ro.rows[0].transaction_read_only !== "on") throw new Error("refusing to continue: not READ ONLY");

    const present = async (names: string[]) =>
      (
        await client.query<{ relname: string }>(
          `select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
            where n.nspname='public' and c.relname = any($1::text[]) order by c.relname`,
          [names]
        )
      ).rows.map((r) => r.relname);

    const prereq = await present(PREREQUISITE_TABLES);
    const missing = PREREQUISITE_TABLES.filter((t) => !prereq.includes(t));
    console.log(`\nprerequisites present : ${prereq.length}/${PREREQUISITE_TABLES.length}`);
    if (missing.length) console.log(`  MISSING             : ${missing.join(", ")}`);

    const introduced = await present(INTRODUCED_TABLES);
    console.log(`already introduced    : ${introduced.length ? introduced.join(", ") : "none"}`);

    const hist = await client.query<{ p: boolean }>(
      "select to_regclass('supabase_migrations.schema_migrations') is not null as p"
    );
    console.log(`CLI migration history : ${hist.rows[0].p ? "present" : "absent (hand-applied era)"}`);

    // Drift signals that would change how the R1 migrations behave.
    const orgCol = await client.query<{ n: string }>(
      `select count(*)::text as n from information_schema.columns
        where table_name='operational_cases' and column_name in ('organization_id','runtime_authority')`
    );
    console.log(`operational_cases R1 columns already added: ${orgCol.rows[0].n}/2`);

    const funcs = await client.query<{ proname: string }>(
      `select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname in ('is_active_org_member','bootstrap_organization')`
    );
    console.log(`R1 functions already present: ${funcs.rows.length ? funcs.rows.map(r=>r.proname).join(", ") : "none"}`);

    const verdict =
      missing.length > 0
        ? "BLOCKED — prerequisites missing; do not deliver"
        : introduced.length === 0 && orgCol.rows[0].n === "0"
          ? "READY — prerequisites present, R1 substrate not yet applied"
          : introduced.length === INTRODUCED_TABLES.length
            ? "ALREADY APPLIED — R1 substrate appears fully present"
            : "PARTIAL — R1 substrate partially present; investigate before delivering";
    console.log(`\nverdict: ${verdict}`);

    await client.query("rollback");
    console.log("rolled back; nothing was written.");
    if (verdict.startsWith("BLOCKED") || verdict.startsWith("PARTIAL")) process.exitCode = 1;
  } finally {
    await client.end();
  }
}

void main().catch((error) => {
  console.error(`preflight-schema-state: ${(error as Error).message}`);
  process.exitCode = 1;
});
