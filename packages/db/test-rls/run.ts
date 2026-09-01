/**
 * Cross-tenant / RLS negative suite — R1 Relationship Operations SL-0.
 *
 * Technical Plan §8: "Cross-tenant negative suite (two-orgs fixture, read and
 * write paths) required from SL-0 and gating every multi-seat surface."
 *
 * Why this is a separate runner: every other DB test in this repo runs against
 * an in-memory fake Supabase client, which can simulate a unique constraint or
 * an append-only trigger but CANNOT enforce row-level security. Permissive /
 * restrictive composition, auth.uid() resolution and SECURITY DEFINER behaviour
 * are PostgreSQL semantics — asserting them against a fake would only prove the
 * fake agrees with itself. So this suite applies the real migration chain to a
 * real PostgreSQL and exercises the real policies.
 *
 * Usage:  DATABASE_URL=postgres://... npm run test:rls --workspace @agents/db
 *
 * The target database is DESTROYED and rebuilt on every run. Never point it at
 * anything but a disposable instance; the runner refuses obvious remotes.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, "..", "supabase", "migrations");

const RLS_VIOLATION = "42501";
const FK_VIOLATION = "23503";

type Role = "anon" | "authenticated" | "service_role";
interface Claims {
  sub?: string;
  role: Role;
}

let passed = 0;
async function t(label: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}

// ============================================================
// Harness
// ============================================================

function requireDisposableUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is required. Point it at a DISPOSABLE PostgreSQL (pgvector " +
        "image) — this suite drops and rebuilds the schema."
    );
  }
  if (/supabase\.(co|in)|amazonaws\.com|\.render\.com|neon\.tech/i.test(url)) {
    throw new Error(
      "DATABASE_URL looks like a hosted database. Refusing to run: this suite " +
        "drops schemas. Use a local throwaway instance."
    );
  }
  return url;
}

async function applySqlFile(client: Client, file: string): Promise<void> {
  const sql = await fs.readFile(file, "utf8");
  try {
    await client.query(sql);
  } catch (error) {
    throw new Error(
      `Failed applying ${path.basename(file)}: ${(error as Error).message}`
    );
  }
}

async function rebuildSchema(client: Client): Promise<void> {
  await client.query(`
    drop schema if exists public cascade;
    drop schema if exists storage cascade;
    drop schema if exists auth cascade;
    create schema public;
  `);

  await applySqlFile(client, path.join(__dirname, "platform-shim.sql"));

  const entries = await fs.readdir(MIGRATIONS_DIR);
  const migrations = entries.filter((n) => n.endsWith(".sql")).sort();
  for (const name of migrations) {
    await applySqlFile(client, path.join(MIGRATIONS_DIR, name));
  }

  await applySqlFile(client, path.join(__dirname, "grants.sql"));
  console.log(`  applied platform shim + ${migrations.length} migrations + grants`);
}

/**
 * Run `fn` with the request-scoped JWT claims and PostgreSQL role a real
 * request would carry. `set local role` is mandatory: the connection user is a
 * superuser and would otherwise bypass RLS entirely, making every assertion
 * vacuous. Always rolled back, so cases cannot leak into each other.
 */
async function asRole<T>(
  client: Client,
  claims: Claims,
  fn: () => Promise<T>
): Promise<T> {
  const role = claims.role;
  if (role !== "anon" && role !== "authenticated" && role !== "service_role") {
    throw new Error(`unsupported role: ${String(role)}`);
  }
  await client.query("begin");
  try {
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify(claims),
    ]);
    await client.query(`set local role ${role}`);
    return await fn();
  } finally {
    await client.query("rollback");
  }
}

/** SQLSTATE of an expected failure, or null when the call unexpectedly succeeded. */
async function errorCode(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? "unknown";
  }
}

// ============================================================
// Fixture — two Organizations, an inactive member, a legacy user
// ============================================================

interface Fixture {
  orgA: string;
  orgB: string;
  creatorA: string;
  memberA2: string;
  revokedA: string;
  memberB: string;
  legacyUser: string;
  caseType: string;
  caseTypeId: string;
  orgCaseA: string;
  orgCaseA2: string;
  orgCaseB: string;
  legacyCase: string;
  /**
   * A second legacy Case with NO facts. `case_facts` is append-only by trigger,
   * so deleting a Case that has facts fails on the cascade for a reason that
   * has nothing to do with row-level security — the DELETE assertion needs a
   * Case whose cascade is empty to actually test the policy.
   */
  legacyCaseNoFacts: string;
}

async function seed(client: Client): Promise<Fixture> {
  const users = {
    creatorA: randomUUID(),
    memberA2: randomUUID(),
    revokedA: randomUUID(),
    memberB: randomUUID(),
    legacyUser: randomUUID(),
  };

  // profiles are created by the handle_new_user trigger on auth.users (00001).
  for (const [name, id] of Object.entries(users)) {
    await client.query("insert into auth.users (id, email) values ($1, $2)", [
      id,
      `${name}@example.test`,
    ]);
  }

  // 00022 moved the case-type primary key to `id` and turned `case_type` into a
  // partial unique index (global types only), so cases carry BOTH the text key
  // and the NOT NULL `case_type_id`. The schema is rebuilt per run, so a plain
  // insert is enough — no conflict target to infer.
  const caseType = "lead_opportunity_rls_fixture";
  const caseTypeId = (
    await client.query<{ id: string }>(
      `insert into public.operational_case_types (case_type, display_name, default_skill_slug)
       values ($1, 'RLS fixture', 'noop')
       returning id`,
      [caseType]
    )
  ).rows[0].id;

  const org = async (name: string) =>
    (
      await client.query<{ id: string }>(
        "insert into public.organizations (name) values ($1) returning id",
        [name]
      )
    ).rows[0].id;

  const orgA = await org("Org A");
  const orgB = await org("Org B");

  const membership = (o: string, u: string, status: string) =>
    client.query(
      `insert into public.organization_memberships (organization_id, user_id, role, status)
       values ($1, $2, 'advisor', $3)`,
      [o, u, status]
    );

  await membership(orgA, users.creatorA, "active");
  await membership(orgA, users.memberA2, "active");
  await membership(orgA, users.revokedA, "inactive");
  await membership(orgB, users.memberB, "active");

  const newCase = async (user: string, organization: string | null) =>
    (
      await client.query<{ id: string }>(
        `insert into public.operational_cases
           (user_id, case_type, case_type_id, organization_id)
         values ($1, $2, $3, $4) returning id`,
        [user, caseType, caseTypeId, organization]
      )
    ).rows[0].id;

  // revokedA is the historical creator of orgCaseA2 — that is what makes the
  // "revoked creator" assertion meaningful rather than incidental.
  const orgCaseA = await newCase(users.creatorA, orgA);
  const orgCaseA2 = await newCase(users.revokedA, orgA);
  const orgCaseB = await newCase(users.memberB, orgB);
  const legacyCase = await newCase(users.legacyUser, null);
  const legacyCaseNoFacts = await newCase(users.legacyUser, null);

  const fact = (caseId: string, userId: string) =>
    client.query(
      `insert into public.case_facts (case_id, user_id, fact_key, value_jsonb, source_kind)
       values ($1, $2, 'opportunity.objective', '{"v":1}'::jsonb, 'derived')`,
      [caseId, userId]
    );
  await fact(orgCaseA, users.creatorA);
  await fact(orgCaseA2, users.revokedA);
  await fact(legacyCase, users.legacyUser);

  await client.query(
    `insert into public.case_relationships
       (organization_id, from_case_id, to_case_id, relationship_type)
     values ($1, $2, $3, 'duplicate_of')`,
    [orgA, orgCaseA, orgCaseA2]
  );

  return {
    orgA,
    orgB,
    caseType,
    caseTypeId,
    orgCaseA,
    orgCaseA2,
    orgCaseB,
    legacyCase,
    legacyCaseNoFacts,
    ...users,
  };
}

// ============================================================
// Suite
// ============================================================

async function main(): Promise<void> {
  const url = requireDisposableUrl();
  const client = new Client({ connectionString: url });
  await client.connect();

  try {
    console.log("R1 SL-0 — cross-tenant / RLS suite\n");
    await rebuildSchema(client);
    const f = await seed(client);
    console.log("  seeded 2 Organizations, 5 users, 4 Cases\n");

    const authed = (sub: string): Claims => ({ sub, role: "authenticated" });
    const service: Claims = { role: "service_role" };

    const countCases = (claims: Claims, id: string) =>
      asRole(client, claims, async () =>
        (
          await client.query(
            "select id from public.operational_cases where id = $1",
            [id]
          )
        ).rowCount
      );

    const countFacts = (claims: Claims, caseId: string) =>
      asRole(client, claims, async () =>
        (
          await client.query(
            "select id from public.case_facts where case_id = $1",
            [caseId]
          )
        ).rowCount
      );

    // ---------------------------------------------------------------
    console.log("operational_cases — read paths");

    await t("active member who is not the creator reads an Organization Case", async () => {
      assert.equal(await countCases(authed(f.memberA2), f.orgCaseA), 1);
    });

    await t("revoked creator is denied on the Case they created", async () => {
      assert.equal(await countCases(authed(f.revokedA), f.orgCaseA2), 0);
    });

    await t("active member of another Organization is denied", async () => {
      assert.equal(await countCases(authed(f.memberB), f.orgCaseA), 0);
    });

    await t("legacy owner still reads their own NULL-Organization Case", async () => {
      assert.equal(await countCases(authed(f.legacyUser), f.legacyCase), 1);
    });

    await t("legacy Case is invisible to an unrelated user", async () => {
      assert.equal(await countCases(authed(f.memberA2), f.legacyCase), 0);
    });

    // ---------------------------------------------------------------
    console.log("\noperational_cases — write paths (membership grants READ only)");

    await t("creator who is an active member cannot UPDATE an Organization Case", async () => {
      const affected = await asRole(client, authed(f.creatorA), async () =>
        (
          await client.query(
            "update public.operational_cases set status = 'paused' where id = $1",
            [f.orgCaseA]
          )
        ).rowCount
      );
      assert.equal(affected, 0);
    });

    await t("creator who is an active member cannot DELETE an Organization Case", async () => {
      const affected = await asRole(client, authed(f.creatorA), async () =>
        (
          await client.query("delete from public.operational_cases where id = $1", [
            f.orgCaseA,
          ])
        ).rowCount
      );
      assert.equal(affected, 0);
    });

    await t("authenticated user cannot INSERT an Organization-owned Case", async () => {
      const code = await errorCode(() =>
        asRole(client, authed(f.creatorA), () =>
          client.query(
            `insert into public.operational_cases
               (user_id, case_type, case_type_id, organization_id)
             values ($1, $2, $3, $4)`,
            [f.creatorA, f.caseType, f.caseTypeId, f.orgA]
          )
        )
      );
      assert.equal(code, RLS_VIOLATION);
    });

    await t("legacy owner retains UPDATE on their own NULL-Organization Case", async () => {
      const affected = await asRole(client, authed(f.legacyUser), async () =>
        (
          await client.query(
            "update public.operational_cases set status = 'paused' where id = $1",
            [f.legacyCase]
          )
        ).rowCount
      );
      assert.equal(affected, 1);
    });

    await t("legacy owner retains DELETE on their own NULL-Organization Case", async () => {
      const affected = await asRole(client, authed(f.legacyUser), async () =>
        (
          await client.query("delete from public.operational_cases where id = $1", [
            f.legacyCaseNoFacts,
          ])
        ).rowCount
      );
      assert.equal(affected, 1);
    });

    await t("legacy owner cannot adopt their Case into an Organization", async () => {
      const code = await errorCode(() =>
        asRole(client, authed(f.legacyUser), () =>
          client.query(
            "update public.operational_cases set organization_id = $1 where id = $2",
            [f.orgA, f.legacyCase]
          )
        )
      );
      assert.equal(code, RLS_VIOLATION);
    });

    await t("service role can write Organization-owned Cases", async () => {
      const affected = await asRole(client, service, async () =>
        (
          await client.query(
            "update public.operational_cases set status = 'paused' where id = $1",
            [f.orgCaseA]
          )
        ).rowCount
      );
      assert.equal(affected, 1);
    });

    // ---------------------------------------------------------------
    console.log("\nCase child surfaces — resolved through the parent Case");

    await t("active member reads Organization Case facts", async () => {
      assert.equal(await countFacts(authed(f.memberA2), f.orgCaseA), 1);
    });

    await t("revoked creator is denied on the children of their Case", async () => {
      assert.equal(await countFacts(authed(f.revokedA), f.orgCaseA2), 0);
    });

    await t("member of another Organization is denied on children", async () => {
      assert.equal(await countFacts(authed(f.memberB), f.orgCaseA), 0);
    });

    await t("legacy owner still reads their own Case facts", async () => {
      assert.equal(await countFacts(authed(f.legacyUser), f.legacyCase), 1);
    });

    // ---------------------------------------------------------------
    console.log("\ncase_relationships — ADR-109 §9 Organization containment");

    await t("cross-Organization edge is rejected by the database itself", async () => {
      const code = await errorCode(() =>
        client.query(
          `insert into public.case_relationships
             (organization_id, from_case_id, to_case_id, relationship_type)
           values ($1, $2, $3, 'duplicate_of')`,
          [f.orgA, f.orgCaseA, f.orgCaseB]
        )
      );
      assert.equal(code, FK_VIOLATION);
    });

    await t("a legacy NULL-Organization Case cannot be an endpoint", async () => {
      const code = await errorCode(() =>
        client.query(
          `insert into public.case_relationships
             (organization_id, from_case_id, to_case_id, relationship_type)
           values ($1, $2, $3, 'duplicate_of')`,
          [f.orgA, f.orgCaseA, f.legacyCase]
        )
      );
      assert.equal(code, FK_VIOLATION);
    });

    await t("active member reads edges in their Organization", async () => {
      const rows = await asRole(client, authed(f.memberA2), async () =>
        (await client.query("select id from public.case_relationships")).rowCount
      );
      assert.equal(rows, 1);
    });

    await t("member of another Organization sees no edges", async () => {
      const rows = await asRole(client, authed(f.memberB), async () =>
        (await client.query("select id from public.case_relationships")).rowCount
      );
      assert.equal(rows, 0);
    });

    await t("authenticated user cannot write an edge", async () => {
      const code = await errorCode(() =>
        asRole(client, authed(f.creatorA), () =>
          client.query(
            `insert into public.case_relationships
               (organization_id, from_case_id, to_case_id, relationship_type)
             values ($1, $2, $3, 'split_from')`,
            [f.orgA, f.orgCaseA, f.orgCaseA2]
          )
        )
      );
      assert.equal(code, RLS_VIOLATION);
    });

    // ---------------------------------------------------------------
    console.log("\nscope — the Work Plane must be untouched by SL-0");

    await t("work_items / work_item_attempts / artifact_inputs keep exactly their CURRENT policies", async () => {
      const { rows } = await client.query<{ tablename: string; policyname: string }>(
        `select tablename, policyname
           from pg_policies
          where schemaname = 'public'
            and tablename in ('work_items', 'work_item_attempts', 'artifact_inputs')
          order by tablename, policyname`
      );
      assert.deepEqual(
        rows.map((r) => `${r.tablename}: ${r.policyname}`),
        [
          "artifact_inputs: Service role manages artifact inputs",
          "artifact_inputs: Users view own artifact inputs",
          "work_item_attempts: Service role manages work item attempts",
          "work_item_attempts: Users view own work item attempts",
          "work_items: Service role manages work items",
          "work_items: Users view own work items",
        ]
      );
    });

    await t("external_identity_bindings is unreadable from any authenticated JWT", async () => {
      const rows = await asRole(client, authed(f.creatorA), async () =>
        (await client.query("select id from public.external_identity_bindings")).rowCount
      );
      assert.equal(rows, 0);
    });

    await t("organization_tool_secrets is unreadable from any authenticated JWT", async () => {
      const rows = await asRole(client, authed(f.creatorA), async () =>
        (await client.query("select id from public.organization_tool_secrets")).rowCount
      );
      assert.equal(rows, 0);
    });

    // ---------------------------------------------------------------
    console.log("\nfunction hardening");

    const fnMeta = async (name: string) =>
      (
        await client.query<{
          prosecdef: boolean;
          proconfig: string[] | null;
          public_exec: boolean;
          authenticated_exec: boolean;
          service_exec: boolean;
        }>(
          `select p.prosecdef,
                  p.proconfig,
                  has_function_privilege('public', p.oid, 'execute')        as public_exec,
                  has_function_privilege('authenticated', p.oid, 'execute') as authenticated_exec,
                  has_function_privilege('service_role', p.oid, 'execute')  as service_exec
             from pg_proc p
             join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = $1`,
          [name]
        )
      ).rows[0];

    await t("is_active_org_member is SECURITY DEFINER with a fixed search_path and no PUBLIC execute", async () => {
      const meta = await fnMeta("is_active_org_member");
      assert.equal(meta.prosecdef, true, "must be SECURITY DEFINER");
      assert.ok(
        (meta.proconfig ?? []).some((c) => c.startsWith("search_path=")),
        "must pin search_path"
      );
      assert.equal(meta.public_exec, false, "PUBLIC must not hold EXECUTE");
      assert.equal(meta.authenticated_exec, true, "policies need it from authenticated");
    });

    await t("bootstrap_organization is SECURITY INVOKER, executable only by service_role", async () => {
      const meta = await fnMeta("bootstrap_organization");
      assert.equal(meta.prosecdef, false, "must NOT be SECURITY DEFINER");
      assert.equal(meta.public_exec, false);
      assert.equal(meta.authenticated_exec, false);
      assert.equal(meta.service_exec, true);
    });

    await t("an authenticated JWT cannot execute bootstrap_organization", async () => {
      const code = await errorCode(() =>
        asRole(client, authed(f.creatorA), () =>
          client.query("select public.bootstrap_organization($1)", ["k-denied"])
        )
      );
      assert.equal(code, RLS_VIOLATION);
    });

    await t("service_role can execute bootstrap_organization", async () => {
      const id = await asRole(client, service, async () =>
        (
          await client.query<{ bootstrap_organization: string }>(
            "select public.bootstrap_organization($1, $2)",
            ["k-service", "Service Org"]
          )
        ).rows[0].bootstrap_organization
      );
      assert.match(id, /^[0-9a-f-]{36}$/);
    });

    // ---------------------------------------------------------------
    console.log("\nbootstrap convergence");

    const bootstrap = async (key: string, name?: string) =>
      (
        await client.query<{ bootstrap_organization: string }>(
          "select public.bootstrap_organization($1, $2)",
          [key, name ?? null]
        )
      ).rows[0].bootstrap_organization;

    await t("re-running bootstrap returns the same Organization and creates no duplicate", async () => {
      const first = await bootstrap("legacy-key-1", "Pilot");
      const second = await bootstrap("legacy-key-1", "A Different Name");
      assert.equal(second, first, "must converge on the same Organization");

      const { rows } = await client.query<{ n: string }>(
        `select count(*)::text as n
           from public.external_identity_bindings
          where binding_kind = 'legacy_organization_key' and external_id = 'legacy-key-1'`
      );
      assert.equal(rows[0].n, "1", "binding must not be duplicated");
      // A different name must not have created a second Organization.
      const orgs = await client.query<{ n: string }>(
        "select count(*)::text as n from public.organizations where name = 'A Different Name'"
      );
      assert.equal(orgs.rows[0].n, "0", "identity is the binding, never the name");
    });

    await t("concurrent bootstrap runs converge on one Organization", async () => {
      const other = new Client({ connectionString: url });
      await other.connect();
      try {
        await client.query("begin");
        const winner = (
          await client.query<{ bootstrap_organization: string }>(
            "select public.bootstrap_organization($1, $2)",
            ["legacy-key-race", "Racer"]
          )
        ).rows[0].bootstrap_organization;

        // Blocks on the global routing unique index until the first run commits.
        const contender = other.query<{ bootstrap_organization: string }>(
          "select public.bootstrap_organization($1, $2)",
          ["legacy-key-race", "Racer"]
        );
        await new Promise((r) => setTimeout(r, 250));
        await client.query("commit");

        const loser = (await contender).rows[0].bootstrap_organization;
        assert.equal(loser, winner, "the losing run must return the existing Organization");

        const { rows } = await client.query<{ n: string }>(
          `select count(*)::text as n
             from public.external_identity_bindings
            where external_id = 'legacy-key-race'`
        );
        assert.equal(rows[0].n, "1", "no orphan Organization or duplicate binding");
      } finally {
        await other.end();
      }
    });

    await t("bootstrap re-run never revives a deactivated membership", async () => {
      const orgId = await bootstrap("legacy-key-lifecycle", "Lifecycle Org");
      const upsert = () =>
        client.query(
          `insert into public.organization_memberships
             (organization_id, user_id, role, status)
           values ($1, $2, 'advisor', 'active')
           on conflict (organization_id, user_id) do nothing`,
          [orgId, f.memberA2]
        );

      await upsert();
      await client.query(
        `update public.organization_memberships set status = 'inactive'
          where organization_id = $1 and user_id = $2`,
        [orgId, f.memberA2]
      );

      await upsert(); // the re-run

      const { rows } = await client.query<{ status: string; role: string }>(
        `select status, role from public.organization_memberships
          where organization_id = $1 and user_id = $2`,
        [orgId, f.memberA2]
      );
      assert.equal(rows.length, 1, "must not create a second membership");
      assert.equal(rows[0].status, "inactive", "reactivation must be explicit");
      assert.equal(rows[0].role, "advisor");
    });

    console.log(`\nRLS suite ok — ${passed} checks passed`);
  } finally {
    await client.end();
  }
}

void main().catch((error) => {
  console.error(`\nRLS suite FAILED: ${(error as Error).message}`);
  process.exitCode = 1;
});
