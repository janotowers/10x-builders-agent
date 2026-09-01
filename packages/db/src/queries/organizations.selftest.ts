/**
 * Selftests for the Organization substrate (R1 SL-0).
 *
 * Scope boundary: this file covers the DETERMINISTIC TypeScript contracts —
 * authorization decisions, fail-closed flag resolution, registry integrity and
 * the idempotency semantics the bootstrap path depends on. It runs against a
 * small in-memory fake, following the repo's existing DB selftest pattern.
 *
 * It deliberately does NOT claim to verify row-level security. Permissive /
 * restrictive composition, auth.uid() resolution and SECURITY DEFINER behaviour
 * are PostgreSQL semantics; asserting them here would only prove the fake
 * agrees with itself. Those live in `test-rls/run.ts` against a real database.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXTERNAL_BINDING_KINDS,
  ORGANIZATION_FLAG_KEYS,
  type ExternalBindingKind,
} from "@agents/types";
import type { DbClient } from "../client";
import {
  authorizeOrgAction,
  assertOrgAction,
  bootstrapOrganizationFromLegacyKey,
  ensureOrganizationMembership,
  OrgAuthorizationError,
} from "./organizations";
import {
  getLegacyEventIngestionMode,
  getRelationshipAdmissionMode,
  getRelationshipSendEffectMode,
  getRuntimeAuthorityTransferMode,
  isRelationshipOpsEnabled,
} from "./organization-feature-flags";
import { resolveOrganizationByExternalId } from "./external-identity-bindings";
import { createCaseRelationship } from "./case-relationships";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type Row = Record<string, unknown>;

interface UpsertCall {
  table: string;
  values: Row | Row[];
  options?: { onConflict?: string; ignoreDuplicates?: boolean };
}

interface FakeDb {
  db: DbClient;
  upserts: UpsertCall[];
  rpcCalls: Array<{ name: string; args: Record<string, unknown> }>;
}

/**
 * Minimal supabase-js stand-in: filters, single/maybeSingle, thenable list
 * queries, upsert and rpc. Enough for the query modules under test, and no more.
 */
function fakeDb(
  tables: Record<string, Row[]>,
  rpcs: Record<string, (args: Record<string, unknown>) => unknown> = {}
): FakeDb {
  const upserts: UpsertCall[] = [];
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

  function builder(table: string) {
    let rows = (tables[table] ?? []).slice();
    const self: Record<string, unknown> = {
      select: () => self,
      order: () => self,
      eq: (column: string, value: unknown) => {
        rows = rows.filter((r) => r[column] === value);
        return self;
      },
      or: () => self,
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      single: async () =>
        rows.length === 1
          ? { data: rows[0], error: null }
          : { data: null, error: new Error(`expected one row, got ${rows.length}`) },
      insert: (values: Row) => {
        const inserted = { id: `generated-${(tables[table] ?? []).length}`, ...values };
        (tables[table] ??= []).push(inserted);
        rows = [inserted];
        return self;
      },
      update: (values: Row) => {
        rows = rows.map((r) => Object.assign(r, values));
        return self;
      },
      upsert: (values: Row | Row[], options?: UpsertCall["options"]) => {
        upserts.push({ table, values, options });
        return self;
      },
      then: (resolve: (v: { data: Row[]; error: null }) => unknown) =>
        resolve({ data: rows, error: null }),
    };
    return self;
  }

  const db = {
    from: (table: string) => builder(table),
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      const handler = rpcs[name];
      if (!handler) return { data: null, error: new Error(`no rpc ${name}`) };
      return { data: handler(args), error: null };
    },
  } as unknown as DbClient;

  return { db, upserts, rpcCalls };
}

const ORG = "11111111-1111-1111-1111-111111111111";
const OTHER_ORG = "22222222-2222-2222-2222-222222222222";
const USER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

function membershipRow(overrides: Row = {}): Row {
  return {
    id: "m1",
    organization_id: ORG,
    user_id: USER,
    role: "advisor",
    status: "active",
    ...overrides,
  };
}

async function testAuthorization(): Promise<void> {
  {
    const { db } = fakeDb({ organization_memberships: [membershipRow()] });
    const result = await authorizeOrgAction(db, USER, ORG, "case.write");
    assert.equal(result.allowed, true);
    assert.equal(result.reason, "active_member");
    // The membership is returned so callers can persist actor + role with the
    // decision, as TD-1 requires for consequential operations.
    assert.equal(result.membership?.role, "advisor");
  }

  {
    // Inactive membership: identity still exists, authority does not.
    const { db } = fakeDb({
      organization_memberships: [membershipRow({ status: "inactive" })],
    });
    const result = await authorizeOrgAction(db, USER, ORG, "case.write");
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "no_active_membership");
    assert.equal(result.membership, null);
  }

  {
    // Active in one Organization grants nothing in another.
    const { db } = fakeDb({ organization_memberships: [membershipRow()] });
    const result = await authorizeOrgAction(db, USER, OTHER_ORG, "case.write");
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "no_active_membership");
  }

  {
    // Role gate: an advisor may work Cases but not manage members.
    const { db } = fakeDb({ organization_memberships: [membershipRow()] });
    const result = await authorizeOrgAction(
      db,
      USER,
      ORG,
      "organization.manage_members"
    );
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "role_not_permitted");
    assert.equal(result.membership?.role, "advisor");
  }

  {
    const { db } = fakeDb({
      organization_memberships: [membershipRow({ role: "org_admin" })],
    });
    const result = await authorizeOrgAction(
      db,
      USER,
      ORG,
      "organization.manage_members"
    );
    assert.equal(result.allowed, true);
  }

  {
    // Unknown action fails closed rather than defaulting to permitted.
    const { db } = fakeDb({ organization_memberships: [membershipRow()] });
    const result = await authorizeOrgAction(
      db,
      USER,
      ORG,
      "case.destroy_everything" as never
    );
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "unknown_action");
  }

  {
    const { db } = fakeDb({ organization_memberships: [] });
    await assert.rejects(
      () => assertOrgAction(db, USER, ORG, "case.write"),
      (error: unknown) => error instanceof OrgAuthorizationError
    );
  }

  console.log("  ok  authorizeOrgAction: membership + role, fail-closed");
}

async function testBootstrapSemantics(): Promise<void> {
  {
    const { db, rpcCalls } = fakeDb({}, { bootstrap_organization: () => ORG });
    const id = await bootstrapOrganizationFromLegacyKey(db, {
      legacyKey: "  alebrixe-key  ",
      organizationName: "  Pilot  ",
    });
    assert.equal(id, ORG);
    assert.equal(rpcCalls[0].name, "bootstrap_organization");
    assert.equal(rpcCalls[0].args.p_legacy_key, "alebrixe-key");
    assert.equal(rpcCalls[0].args.p_org_name, "Pilot");
  }

  {
    // An empty name must not become an empty Organization name; the function
    // falls back to the legacy key instead.
    const { db, rpcCalls } = fakeDb({}, { bootstrap_organization: () => ORG });
    await bootstrapOrganizationFromLegacyKey(db, {
      legacyKey: "k",
      organizationName: "   ",
    });
    assert.equal(rpcCalls[0].args.p_org_name, null);
  }

  {
    const { db } = fakeDb({}, { bootstrap_organization: () => ORG });
    await assert.rejects(() =>
      bootstrapOrganizationFromLegacyKey(db, { legacyKey: "   " })
    );
  }

  {
    // The bootstrap membership path must be non-mutating on conflict: re-running
    // it can never revive a deactivated member or overwrite an administrator's
    // role change. That is expressed as ON CONFLICT DO NOTHING.
    const { db, upserts } = fakeDb({ organization_memberships: [] });
    await ensureOrganizationMembership(db, {
      organizationId: ORG,
      userId: USER,
      role: "advisor",
    });
    assert.equal(upserts.length, 1);
    assert.equal(upserts[0].options?.ignoreDuplicates, true);
    assert.equal(upserts[0].options?.onConflict, "organization_id,user_id");
  }

  console.log("  ok  bootstrap: trimmed inputs, non-mutating membership re-run");
}

async function testFlagResolversFailClosed(): Promise<void> {
  const noFlags = fakeDb({ organization_feature_flags: [] }).db;

  assert.equal(await isRelationshipOpsEnabled(noFlags, ORG), false);
  assert.equal(await getRelationshipAdmissionMode(noFlags, ORG), "shadow");
  assert.equal(await getRelationshipSendEffectMode(noFlags, ORG), "off");
  assert.equal(await getRuntimeAuthorityTransferMode(noFlags, ORG), "off");
  assert.equal(await getLegacyEventIngestionMode(noFlags, ORG), "poll");

  // A disabled row must not leak its value: disabled means the conservative mode.
  const disabled = fakeDb({
    organization_feature_flags: [
      {
        organization_id: ORG,
        flag_key: ORGANIZATION_FLAG_KEYS.admissionMode,
        enabled: false,
        value_text: "live",
      },
    ],
  }).db;
  assert.equal(await getRelationshipAdmissionMode(disabled, ORG), "shadow");

  // An unrecognized value must not widen authority either.
  const garbage = fakeDb({
    organization_feature_flags: [
      {
        organization_id: ORG,
        flag_key: ORGANIZATION_FLAG_KEYS.sendEffects,
        enabled: true,
        value_text: "yolo",
      },
    ],
  }).db;
  assert.equal(await getRelationshipSendEffectMode(garbage, ORG), "off");

  const live = fakeDb({
    organization_feature_flags: [
      {
        organization_id: ORG,
        flag_key: ORGANIZATION_FLAG_KEYS.admissionMode,
        enabled: true,
        value_text: "live",
      },
    ],
  }).db;
  assert.equal(await getRelationshipAdmissionMode(live, ORG), "live");

  console.log("  ok  organization flag resolvers fail closed");
}

/**
 * The binding-kind registry encodes which kinds carry the GLOBAL partial unique
 * index. If the registry and the migration drift apart, inbound routing could
 * silently resolve one external id to two Organizations — so assert them
 * against each other rather than trusting a comment.
 */
async function testBindingRegistryMatchesMigration(): Promise<void> {
  const migrationPath = path.resolve(
    __dirname,
    "..",
    "..",
    "supabase",
    "migrations",
    "00082_external_identity_bindings.sql"
  );
  const sql = await fs.readFile(migrationPath, "utf8");

  const indexBlock = sql
    .split("uq_external_identity_bindings_global_routing")[1]
    ?.split(";")[0];
  assert.ok(indexBlock, "global routing partial unique index must exist");

  const indexedKinds = [...indexBlock.matchAll(/'([a-z_]+)'/g)]
    .map((m) => m[1])
    .sort();

  const registryGlobalKinds = (
    Object.keys(EXTERNAL_BINDING_KINDS) as ExternalBindingKind[]
  )
    .filter((kind) => EXTERNAL_BINDING_KINDS[kind] === "global_routing")
    .sort();

  assert.deepEqual(
    indexedKinds,
    registryGlobalKinds,
    "packages/types registry and the migration's partial unique index disagree"
  );

  // Every kind in the type union must also appear in the CHECK constraint.
  const checkBlock = sql.split("binding_kind         text not null")[1]?.split(")")[0];
  assert.ok(checkBlock);
  for (const kind of Object.keys(EXTERNAL_BINDING_KINDS)) {
    assert.ok(
      checkBlock.includes(`'${kind}'`),
      `binding kind ${kind} missing from the migration CHECK`
    );
  }

  console.log("  ok  binding-kind registry matches the migration index and CHECK");
}

async function testResolutionAndRelationshipGuards(): Promise<void> {
  // Organization-scoped kinds have no global uniqueness, so a global resolve
  // would be ambiguous across tenants: refuse rather than return a guess.
  const { db } = fakeDb({ external_identity_bindings: [] });
  await assert.rejects(() =>
    resolveOrganizationByExternalId(db, {
      sourceSystem: "traditional_gu",
      bindingKind: "prospect_channel",
      externalId: "x",
    })
  );

  const routing = fakeDb({
    external_identity_bindings: [
      {
        id: "b1",
        organization_id: ORG,
        source_system: "traditional_gu",
        binding_kind: "legacy_lead",
        external_id: "lead-1",
      },
    ],
  }).db;
  const found = await resolveOrganizationByExternalId(routing, {
    sourceSystem: "traditional_gu",
    bindingKind: "legacy_lead",
    externalId: "lead-1",
  });
  assert.equal(found?.organization_id, ORG);

  const rel = fakeDb({ case_relationships: [] }).db;
  await assert.rejects(() =>
    createCaseRelationship(rel, {
      organizationId: ORG,
      fromCaseId: "case-1",
      toCaseId: "case-1",
      relationshipType: "duplicate_of",
    })
  );

  console.log("  ok  routing resolution scope + self-edge guard");
}

async function main(): Promise<void> {
  console.log("organizations selftest");
  await testAuthorization();
  await testBootstrapSemantics();
  await testFlagResolversFailClosed();
  await testBindingRegistryMatchesMigration();
  await testResolutionAndRelationshipGuards();
  console.log("organizations selftest ok");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
