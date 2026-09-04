/**
 * Selftests for Organization-scoped provider credentials (R1 SL-1, TD-1/TD-5).
 *
 * Scope boundary: these cover the DETERMINISTIC TypeScript contracts - provider
 * material parsing, the projection that keeps ciphertext off every read path,
 * the `pending_test -> active` transition and the fail-closed runtime resolver.
 * They run against a small in-memory fake, following the repo's existing DB
 * selftest pattern.
 *
 * They deliberately do NOT claim to verify that the database refuses a user-JWT
 * read of this table. That is RLS, it is asserted in `test-rls/run.ts` against a
 * real PostgreSQL, and proving it here would only prove the fake agrees with
 * itself.
 *
 * No real credential material appears in this file.
 */
import assert from "node:assert/strict";
import type { DbClient } from "../client";
import {
  OrganizationToolSecretValidationError,
  describeOrganizationToolSecret,
  disconnectOrganizationToolSecret,
  getOrganizationToolSecretForRuntime,
  getOrganizationToolSecretPublic,
  isOrganizationToolSecretProvider,
  markOrganizationToolSecretTested,
  parseTraditionalGuFirestoreMaterial,
  parseTraditionalGuMongoMaterial,
  upsertOrganizationToolSecret,
  type OrganizationToolSecretPublic,
} from "./organization-tool-secrets";

type Row = Record<string, unknown>;

interface FakeDb {
  db: DbClient;
  selects: Array<{ table: string; columns: string }>;
  upserts: Array<{ table: string; values: Row; options?: { onConflict?: string } }>;
  updates: Array<{ table: string; values: Row }>;
}

function fakeDb(tables: Record<string, Row[]>): FakeDb {
  const selects: FakeDb["selects"] = [];
  const upserts: FakeDb["upserts"] = [];
  const updates: FakeDb["updates"] = [];

  function builder(table: string) {
    let rows = (tables[table] ?? []).slice();
    const self: Record<string, unknown> = {
      select: (columns: string) => {
        selects.push({ table, columns });
        return self;
      },
      order: () => self,
      eq: (column: string, value: unknown) => {
        rows = rows.filter((r) => r[column] === value);
        return self;
      },
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      single: async () =>
        rows.length === 1
          ? { data: rows[0], error: null }
          : {
              data: null,
              error: new Error(`expected one row, got ${rows.length}`),
            },
      update: (values: Row) => {
        updates.push({ table, values });
        rows = rows.map((r) => Object.assign(r, values));
        return self;
      },
      upsert: (values: Row, options?: { onConflict?: string }) => {
        upserts.push({ table, values, options });
        const existing = (tables[table] ??= []);
        const index = existing.findIndex(
          (r) =>
            r.organization_id === values.organization_id &&
            r.provider === values.provider
        );
        const merged = { id: "secret-1", ...values };
        if (index >= 0) existing[index] = merged;
        else existing.push(merged);
        rows = [merged];
        return self;
      },
      then: (resolve: (v: { data: Row[]; error: null }) => unknown) =>
        resolve({ data: rows, error: null }),
    };
    return self;
  }

  const db = {
    from: (table: string) => builder(table),
  } as unknown as DbClient;

  return { db, selects, upserts, updates };
}

const ORG = "11111111-1111-1111-1111-111111111111";
const OTHER_ORG = "22222222-2222-2222-2222-222222222222";

/** Structurally valid, obviously fake. Never a real key. */
const FAKE_SERVICE_ACCOUNT = {
  type: "service_account",
  project_id: "example-project",
  private_key_id: "not-a-real-key-id",
  private_key:
    "-----BEGIN PRIVATE KEY-----\nTEST-MATERIAL-NOT-A-REAL-KEY\n-----END PRIVATE KEY-----\n",
  client_email: "gu-os-selftest@example-project.iam.gserviceaccount.com",
};

const FAKE_MONGO_URI = "mongodb+srv://selftest:not-a-real-password@cluster.example.net/";

/**
 * Encryption is a hard dependency of storage, so tests that store supply their
 * own throwaway key rather than depending on the developer's environment.
 */
async function withTestEncryptionKey<T>(
  key: string,
  run: () => Promise<T>
): Promise<T> {
  const previous = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = key;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = previous;
  }
}

function testProviderRegistry(): void {
  assert.equal(isOrganizationToolSecretProvider("traditional_gu_firestore"), true);
  assert.equal(isOrganizationToolSecretProvider("traditional_gu_mongo"), true);
  assert.equal(isOrganizationToolSecretProvider("traditional_gu_api"), true);
  assert.equal(isOrganizationToolSecretProvider("easybroker"), false);
  console.log("  ok  provider vocabulary is closed");
}

function testFirestoreMaterialParsing(): void {
  const parsed = parseTraditionalGuFirestoreMaterial(FAKE_SERVICE_ACCOUNT);
  assert.equal(parsed.config.project_id, "example-project");
  assert.equal(
    parsed.config.client_email,
    "gu-os-selftest@example-project.iam.gserviceaccount.com"
  );
  assert.ok(parsed.secret.private_key.includes("PRIVATE KEY"));
  // Identity metadata is readable without decrypting; the key is not metadata.
  assert.equal(
    Object.prototype.hasOwnProperty.call(parsed.config, "private_key"),
    false
  );

  assert.throws(
    () => parseTraditionalGuFirestoreMaterial({ ...FAKE_SERVICE_ACCOUNT, type: "user" }),
    OrganizationToolSecretValidationError
  );
  assert.throws(
    () =>
      parseTraditionalGuFirestoreMaterial({
        ...FAKE_SERVICE_ACCOUNT,
        private_key: "oops",
      }),
    OrganizationToolSecretValidationError
  );
  assert.throws(
    () => parseTraditionalGuFirestoreMaterial({ ...FAKE_SERVICE_ACCOUNT, project_id: "" }),
    OrganizationToolSecretValidationError
  );
  assert.throws(
    () => parseTraditionalGuFirestoreMaterial("not-an-object"),
    OrganizationToolSecretValidationError
  );

  // A rejection message must describe the shape, never echo the material.
  try {
    parseTraditionalGuFirestoreMaterial({
      ...FAKE_SERVICE_ACCOUNT,
      private_key: "sensitive-looking-garbage",
    });
    assert.fail("expected a validation error");
  } catch (error) {
    assert.ok(error instanceof OrganizationToolSecretValidationError);
    assert.equal(error.message.includes("sensitive-looking-garbage"), false);
  }
  console.log("  ok  firestore material splits config from secret, and rejects bad shapes");
}

function testMongoMaterialParsing(): void {
  const parsed = parseTraditionalGuMongoMaterial({
    uri: FAKE_MONGO_URI,
    database: "bot",
  });
  assert.equal(parsed.config.database, "bot");
  assert.equal(parsed.config.host, "cluster.example.net");
  // The redacted metadata must not carry the credential.
  assert.equal(parsed.config.host.includes("not-a-real-password"), false);
  assert.equal(JSON.stringify(parsed.config).includes("selftest:"), false);
  assert.equal(parsed.secret.uri, FAKE_MONGO_URI);

  assert.throws(
    () => parseTraditionalGuMongoMaterial({ uri: "https://example.net", database: "bot" }),
    OrganizationToolSecretValidationError
  );
  assert.throws(
    () => parseTraditionalGuMongoMaterial({ uri: FAKE_MONGO_URI, database: "" }),
    OrganizationToolSecretValidationError
  );
  console.log("  ok  mongo material validates the scheme and keeps only redacted metadata");
}

async function testStorageProjection(): Promise<void> {
  await withTestEncryptionKey("2".repeat(64), async () => {
  const { db, selects, upserts } = fakeDb({ organization_tool_secrets: [] });
  const material = parseTraditionalGuFirestoreMaterial(FAKE_SERVICE_ACCOUNT);
  const stored = await upsertOrganizationToolSecret(db, {
    organizationId: ORG,
    provider: "traditional_gu_firestore",
    config: material.config as unknown as Record<string, unknown>,
    secret: material.secret as unknown as Record<string, unknown>,
  });

  // New material is never born trusted.
  assert.equal(stored.status, "pending_test");
  assert.equal(upserts[0].options?.onConflict, "organization_id,provider");

  const written = upserts[0].values;
  assert.equal(typeof written.encrypted_secret_jsonb, "string");
  assert.equal(
    (written.encrypted_secret_jsonb as string).includes("TEST-MATERIAL"),
    false,
    "secret material must be stored encrypted, never in the clear"
  );

  // Nothing that reads this table may select the ciphertext column.
  for (const call of selects) {
    assert.equal(
      call.columns.includes("encrypted_secret_jsonb"),
      false,
      `select on ${call.table} leaked the ciphertext column`
    );
  }

  await assert.rejects(() =>
    upsertOrganizationToolSecret(db, {
      organizationId: "",
      provider: "traditional_gu_mongo",
      config: {},
      secret: { uri: FAKE_MONGO_URI },
    })
  );
  await assert.rejects(() =>
    upsertOrganizationToolSecret(db, {
      organizationId: ORG,
      provider: "traditional_gu_mongo",
      config: {},
      secret: {},
    })
  );
  });
  console.log("  ok  storage encrypts, lands pending_test, and never projects ciphertext");
}

async function testTestedTransition(): Promise<void> {
  const { db } = fakeDb({
    organization_tool_secrets: [
      {
        id: "secret-1",
        organization_id: ORG,
        provider: "traditional_gu_mongo",
        config_jsonb: { database: "bot", host: "cluster.example.net" },
        encrypted_secret_jsonb: "ciphertext",
        status: "pending_test",
        last_checked_at: null,
        last_used_at: null,
        last_error: null,
      },
    ],
  });

  const activated = await markOrganizationToolSecretTested(db, {
    organizationId: ORG,
    provider: "traditional_gu_mongo",
    ok: true,
  });
  assert.equal(activated?.status, "active");
  assert.equal(activated?.last_error, null);
  assert.ok(activated?.last_checked_at);

  const failed = await markOrganizationToolSecretTested(db, {
    organizationId: ORG,
    provider: "traditional_gu_mongo",
    ok: false,
    error: "auth failed",
  });
  assert.equal(failed?.status, "invalid");
  assert.equal(failed?.last_error, "auth failed");
  console.log("  ok  pending_test -> active is an explicit, evidence-driven transition");
}

async function testRuntimeResolverFailsClosed(): Promise<void> {
  await withTestEncryptionKey("0".repeat(64), async () => {
    const material = parseTraditionalGuMongoMaterial({
      uri: FAKE_MONGO_URI,
      database: "bot",
    });
    const { db } = fakeDb({ organization_tool_secrets: [] });
    await upsertOrganizationToolSecret(db, {
      organizationId: ORG,
      provider: "traditional_gu_mongo",
      config: material.config as unknown as Record<string, unknown>,
      secret: material.secret as unknown as Record<string, unknown>,
    });

    // Round trip: an adapter can read back exactly what was stored.
    const runtime = await getOrganizationToolSecretForRuntime<
      { uri: string },
      { database: string }
    >(db, { organizationId: ORG, provider: "traditional_gu_mongo" });
    assert.equal(runtime?.secret.uri, FAKE_MONGO_URI);
    assert.equal(runtime?.config.database, "bot");
    assert.equal(runtime?.status, "pending_test");

    // `requireActive` refuses an unproven credential.
    assert.equal(
      await getOrganizationToolSecretForRuntime(db, {
        organizationId: ORG,
        provider: "traditional_gu_mongo",
        requireActive: true,
      }),
      null
    );

    // Another Organization gets nothing, even for the same provider.
    assert.equal(
      await getOrganizationToolSecretForRuntime(db, {
        organizationId: OTHER_ORG,
        provider: "traditional_gu_mongo",
      }),
      null
    );

    // The organization is never inferred.
    await assert.rejects(() =>
      getOrganizationToolSecretForRuntime(db, {
        organizationId: "",
        provider: "traditional_gu_mongo",
      })
    );

    // Retirement leaves no material at rest, and the row stops resolving.
    await disconnectOrganizationToolSecret(db, {
      organizationId: ORG,
      provider: "traditional_gu_mongo",
    });
    assert.equal(
      await getOrganizationToolSecretForRuntime(db, {
        organizationId: ORG,
        provider: "traditional_gu_mongo",
      }),
      null
    );

    const publicRow = await getOrganizationToolSecretPublic(db, {
      organizationId: ORG,
      provider: "traditional_gu_mongo",
    });
    assert.equal(publicRow?.status, "disconnected");
    assert.equal(
      describeOrganizationToolSecret(publicRow as OrganizationToolSecretPublic).includes(
        "not-a-real-password"
      ),
      false
    );
  });
  console.log("  ok  runtime resolver round-trips, scopes by org and fails closed");
}

async function testUndecryptableIsTreatedAsAbsent(): Promise<void> {
  await withTestEncryptionKey("1".repeat(64), async () => {
    const { db } = fakeDb({
      organization_tool_secrets: [
        {
          id: "secret-1",
          organization_id: ORG,
          provider: "traditional_gu_firestore",
          config_jsonb: {},
          encrypted_secret_jsonb: "aa:bb:cc",
          status: "active",
        },
      ],
    });
    assert.equal(
      await getOrganizationToolSecretForRuntime(db, {
        organizationId: ORG,
        provider: "traditional_gu_firestore",
      }),
      null
    );
  });
  console.log("  ok  undecryptable material reads as absent, not as a half-usable credential");
}

async function main(): Promise<void> {
  console.log("organization tool secrets selftest");
  testProviderRegistry();
  testFirestoreMaterialParsing();
  testMongoMaterialParsing();
  await testStorageProjection();
  await testTestedTransition();
  await testRuntimeResolverFailsClosed();
  await testUndecryptableIsTreatedAsAbsent();
  console.log("organization tool secrets selftest ok");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
