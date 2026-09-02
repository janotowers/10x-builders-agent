/**
 * Reusable hosted verification — evidence against a real environment.
 *
 * This is the third of four distinct layers; do not collapse them:
 *   local tests   → implementation feedback while building
 *   CI            → deterministic verification in a clean disposable environment
 *   hosted verify → THIS: evidence against an actual hosted environment
 *   post-release  → evidence against production after a release
 *
 * Read-only by default and non-destructive always. `npm run test:rls` must
 * never be pointed at a hosted environment — it drops the public, storage and
 * auth schemas, which on a real project would destroy the auth service.
 *
 * Check groups are selected per slice, because a slice's DoD decides what
 * "verified" means. Slice-specific business assertions (for example an
 * individual pilot's Organization) belong in that slice's own evidence run,
 * not hardcoded here as universal CI.
 *
 * Usage:
 *   npm run verify:hosted -- --env-file .env.staging.local --env staging
 *   npm run verify:hosted -- --env staging --groups smoke,schema,security --json evidence.json
 */
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolveTarget, assertBinding, describeTarget, parseTargetArgs } from "./lib/target-env";

const require_ = createRequire(import.meta.url);
const { Client } = require_("pg") as typeof import("pg");

type Group = "smoke" | "schema" | "security";
const ALL_GROUPS: Group[] = ["smoke", "schema", "security"];

interface Result {
  group: Group;
  label: string;
  ok: boolean;
  detail?: string;
}

const results: Result[] = [];
function record(group: Group, label: string, ok: boolean, detail?: string): void {
  results.push({ group, label, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  [${group}] ${label}${detail ? ` — ${detail}` : ""}`);
}

function parseExtra(argv: string[]): { groups: Group[]; json?: string } {
  let groups = ALL_GROUPS;
  let json: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--groups") {
      groups = (argv[++i] ?? "").split(",").map((g) => g.trim()).filter(Boolean) as Group[];
    } else if (argv[i] === "--json") json = argv[++i];
  }
  const unknown = groups.filter((g) => !ALL_GROUPS.includes(g));
  if (unknown.length > 0) throw new Error(`unknown check group(s): ${unknown.join(", ")}`);
  return { groups, json };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const args = parseTargetArgs(argv);
  const { groups, json } = parseExtra(argv);
  const target = resolveTarget(args);
  assertBinding(target);
  console.log(describeTarget(target));
  console.log(`groups: ${groups.join(", ")}\n`);

  const client = new Client({ connectionString: target.databaseUrl });
  await client.connect();
  try {
    // Read-only for the whole run: enforced by the server, not by convention.
    await client.query("begin transaction read only");
    const ro = await client.query<{ transaction_read_only: string }>("show transaction_read_only");
    if (ro.rows[0].transaction_read_only !== "on") throw new Error("could not enter a READ ONLY transaction");

    if (groups.includes("smoke")) {
      const db = await client.query<{ d: string }>("select current_database() as d");
      record("smoke", "database reachable", true, `database ${db.rows[0].d}`);
      const t = await client.query<{ n: string }>(
        "select count(*)::text as n from information_schema.tables where table_schema='public'"
      );
      record("smoke", "public schema is populated", Number(t.rows[0].n) > 0, `${t.rows[0].n} tables`);
      if (target.supabaseUrl && target.publishableKey) {
        const r = await fetch(`${target.supabaseUrl.replace(/\/+$/, "")}/auth/v1/settings`, {
          headers: { apikey: target.publishableKey },
        });
        record("smoke", "public API answers with the publishable credential", r.ok, `HTTP ${r.status}`);
      }
    }

    if (groups.includes("schema")) {
      // Migration state: which era has been delivered, and is history coherent?
      const hist = await client.query<{ p: boolean }>(
        "select to_regclass('supabase_migrations.schema_migrations') is not null as p"
      );
      const hasHistory = hist.rows[0].p;
      if (hasHistory) {
        const rows = await client.query<{ n: string; hi: string | null }>(
          "select count(*)::text as n, max(version) as hi from supabase_migrations.schema_migrations"
        );
        record("schema", "forward-era history present", true, `${rows.rows[0].n} recorded, latest ${rows.rows[0].hi}`);
        const legacyShaped = await client.query<{ n: string }>(
          "select count(*)::text as n from supabase_migrations.schema_migrations where version ~ '^[0-9]{5}$'"
        );
        record(
          "schema",
          "history contains no legacy-era versions",
          legacyShaped.rows[0].n === "0",
          `${legacyShaped.rows[0].n} legacy-shaped rows`
        );
      } else {
        record("schema", "no forward-era history yet (expected before the first forward migration)", true);
      }
      const key = await client.query<{ n: string }>(
        `select count(*)::text as n from pg_class c join pg_namespace s on s.oid=c.relnamespace
          where s.nspname='public' and c.relname='profiles'`
      );
      record("schema", "legacy era applied (profiles present)", key.rows[0].n === "1");
    }

    if (groups.includes("security")) {
      // Invariants that must hold wherever the schema is deployed.
      const rls = await client.query<{ relname: string }>(
        `select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
          where n.nspname='public' and c.relkind='r' and c.relrowsecurity=false
            and c.relname in ('profiles','operational_cases','case_facts','organizations',
                              'organization_memberships','external_identity_bindings','case_relationships')`
      );
      record(
        "security",
        "row-level security enabled on governed tables",
        rls.rows.length === 0,
        rls.rows.length ? `missing on: ${rls.rows.map((r) => r.relname).join(", ")}` : "all enabled"
      );

      const fns = await client.query<{ proname: string; prosecdef: boolean; proconfig: string[] | null; pub: boolean }>(
        `select p.proname, p.prosecdef, p.proconfig,
                has_function_privilege('public', p.oid, 'execute') as pub
           from pg_proc p join pg_namespace n on n.oid=p.pronamespace
          where n.nspname='public' and p.proname in ('is_active_org_member','bootstrap_organization')`
      );
      for (const f of fns.rows) {
        record("security", `${f.proname}: PUBLIC holds no EXECUTE`, f.pub === false);
        if (f.prosecdef) {
          record(
            "security",
            `${f.proname}: SECURITY DEFINER pins search_path`,
            (f.proconfig ?? []).some((c) => c.startsWith("search_path="))
          );
        }
      }
    }

    await client.query("rollback");
  } finally {
    await client.end();
  }

  const failed = results.filter((r) => !r.ok);
  const evidence = {
    environment: target.name,
    projectRef: target.projectRef,
    ranAt: new Date().toISOString(),
    groups,
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    results,
  };
  if (json) {
    writeFileSync(json, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    console.log(`\nevidence written to ${json}`);
  }
  console.log(`\nverify-hosted: ${evidence.passed}/${evidence.total} passed on "${target.name}"`);
  if (failed.length > 0) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(`verify-hosted: ${(error as Error).message}`);
  process.exitCode = 1;
});
