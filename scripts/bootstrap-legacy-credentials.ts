// Stores the Traditional Gu read identities as Organization-scoped credentials
// and proves they work (R1 SL-1 / TD-1, TD-5).
//
// This is the in-Slice half of the credential boundary. The prerequisite
// delivered two external read identities and made their material available to
// an authorized setup path; everything from here - parsing, validation, safe
// storage and the `pending_test -> active` transition - belongs to SL-1,
// because doing it safely depends on code SL-1 itself builds.
//
// What this script does NOT do: create identities, widen a grant, or write
// anything to a legacy store. It reads material the operator already holds,
// stores it encrypted against one Organization, and performs one read per
// provider to prove the credential works.
//
// Usage:
//   npx tsx scripts/bootstrap-legacy-credentials.ts \
//     --env-file .env.staging.local --env staging \
//     --legacy-env stage --organization <uuid> [--apply]
//
// Dry-run is the DEFAULT. Nothing is stored without --apply, because this puts
// credential material at rest under a tenancy boundary.
//
// Re-running is safe and is how a credential is rotated: the row is replaced
// and lands back in `pending_test` until the connection check passes again.

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import {
  getOrganizationById,
  getOrganizationToolSecretPublic,
  markOrganizationToolSecretTested,
  parseTraditionalGuFirestoreMaterial,
  parseTraditionalGuMongoMaterial,
  upsertOrganizationToolSecret,
  type DbClient,
} from "@agents/db";
import { resolveTarget, assertBinding, describeTarget, parseTargetArgs } from "./lib/target-env";
import {
  assertProductionReadAcknowledged,
  describeLegacyTarget,
  parseLegacyArgs,
  resolveLegacyTarget,
} from "./lib/legacy-target";

const require_ = createRequire(import.meta.url);

/**
 * The encryption key is resolved from the DECLARED environment's own file, as
 * `GUOS_<ENV>_ENCRYPTION_KEY`, and never from an ambient `ENCRYPTION_KEY`.
 *
 * This is not ceremony. Material encrypted with a developer's local key would
 * be stored successfully and then fail to decrypt in the environment that has
 * to use it - a credential that looks configured and is not. Binding the key to
 * the target is what makes that impossible.
 */
function resolveEncryptionKey(envFile: string | undefined, envName: string): string {
  const key = `GUOS_${envName.toUpperCase()}_ENCRYPTION_KEY`;
  let fromFile: string | undefined;
  if (envFile) {
    for (const raw of readFileSync(envFile, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const i = line.indexOf("=");
      if (i <= 0) continue;
      if (line.slice(0, i).trim() !== key) continue;
      let value = line.slice(i + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      fromFile = value;
    }
  }
  const resolved = (process.env[key] ?? fromFile ?? "").trim();
  if (!resolved) {
    throw new Error(
      `FAIL CLOSED - ${key} is not set. Credential material is encrypted at rest with the ` +
        `SAME key the "${envName}" runtime decrypts with; an ambient ENCRYPTION_KEY is ` +
        "deliberately not accepted, because material encrypted with the wrong key stores " +
        "cleanly and then fails to decrypt where it is needed."
    );
  }
  if (resolved.length !== 64) {
    throw new Error(`${key} must be 64 hex characters (32 bytes).`);
  }
  return resolved;
}

function parseOrganization(argv: string[]): string {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--organization") return (argv[++i] ?? "").trim();
  }
  return "";
}

/**
 * One narrow read per provider, to prove the credential actually works before
 * it is marked `active`. Deliberately the cheapest possible read: existence of
 * an allowlisted collection, never a document's contents.
 */
async function checkFirestore(
  keyFilePath: string,
  projectId: string
): Promise<{ ok: boolean; detail: string }> {
  try {
    const { Firestore } = require_("@google-cloud/firestore") as typeof import("@google-cloud/firestore");
    const db = new Firestore({ projectId, keyFilename: keyFilePath });
    const snapshot = await db.collection("leads").limit(1).get();
    return { ok: true, detail: `leads readable (${snapshot.size} document sampled)` };
  } catch (error) {
    return { ok: false, detail: (error as Error).message };
  }
}

async function checkMongo(
  uri: string,
  database: string
): Promise<{ ok: boolean; detail: string }> {
  const { MongoClient } = require_("mongodb") as typeof import("mongodb");
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
  try {
    await client.connect();
    const count = await client
      .db(database)
      .collection("appointments")
      .estimatedDocumentCount();
    if (count === 0) {
      // An empty collection is indistinguishable from a missing one here, and
      // `bot` versus `gu2` is exactly the mistake that made this check worth
      // having. Say so rather than reporting a confident success.
      return {
        ok: false,
        detail: `${database}.appointments answered with 0 documents - check the database name`,
      };
    }
    return { ok: true, detail: `${database}.appointments reachable (~${count} documents)` };
  } catch (error) {
    return { ok: false, detail: (error as Error).message };
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const targetArgs = parseTargetArgs(argv);
  const legacyArgs = parseLegacyArgs(argv);
  const organizationId = parseOrganization(argv);
  if (!organizationId) {
    throw new Error("--organization <uuid> is required; it is never inferred.");
  }

  const target = resolveTarget(targetArgs);
  assertBinding(target);
  const legacy = resolveLegacyTarget({
    envFile: legacyArgs.envFile,
    legacyEnv: legacyArgs.legacyEnv,
  });
  assertProductionReadAcknowledged(legacy, legacyArgs.acknowledgeProductionRead);

  console.log(describeTarget(target));
  console.log(describeLegacyTarget(legacy));
  console.log(`organization: ${organizationId}`);
  console.log(targetArgs.apply ? "mode: APPLY\n" : "mode: DRY RUN (pass --apply to store)\n");

  if (!target.serviceRoleKey || !target.supabaseUrl) {
    throw new Error(
      "FAIL CLOSED - this script writes an Organization-owned, service-role-only table " +
        "and needs GUOS_TARGET_SERVICE_ROLE_KEY / _SUPABASE_URL for the declared environment."
    );
  }
  const db = createClient(target.supabaseUrl, target.serviceRoleKey) as unknown as DbClient;

  const organization = await getOrganizationById(db, organizationId);
  if (!organization) {
    throw new Error(
      `organization ${organizationId} does not exist in "${target.name}". Bootstrap it first.`
    );
  }
  console.log(`organization resolved: ${organization.name} (${organization.status})`);

  // ── Firestore ────────────────────────────────────────────────────
  const firestoreMaterial = parseTraditionalGuFirestoreMaterial(
    legacy.firestore.serviceAccount
  );
  console.log(
    `\ntraditional_gu_firestore: project=${firestoreMaterial.config.project_id} ` +
      `identity=${firestoreMaterial.config.client_email}`
  );
  const firestoreCheck = await checkFirestore(
    legacy.firestore.keyFilePath,
    firestoreMaterial.config.project_id
  );
  console.log(`  connection check: ${firestoreCheck.ok ? "PASS" : "FAIL"} - ${firestoreCheck.detail}`);

  // ── Mongo ────────────────────────────────────────────────────────
  let mongoCheck: { ok: boolean; detail: string } | null = null;
  let mongoMaterial: ReturnType<typeof parseTraditionalGuMongoMaterial> | null = null;
  if (legacy.mongo) {
    mongoMaterial = parseTraditionalGuMongoMaterial({
      uri: legacy.mongo.uri,
      database: legacy.mongo.database,
    });
    console.log(
      `\ntraditional_gu_mongo: host=${mongoMaterial.config.host} database=${mongoMaterial.config.database}`
    );
    mongoCheck = await checkMongo(legacy.mongo.uri, legacy.mongo.database);
    console.log(`  connection check: ${mongoCheck.ok ? "PASS" : "FAIL"} - ${mongoCheck.detail}`);
  } else {
    console.log("\ntraditional_gu_mongo: not configured - skipping (only appointment_get needs it)");
  }

  if (!targetArgs.apply) {
    console.log("\ndry run complete. Nothing was stored.");
    return;
  }

  // Bind the encryption key to the declared target. Resolved here rather than
  // up front so a dry run - which validates the material and the connectivity
  // and stores nothing - does not require the deployment key at all.
  process.env.ENCRYPTION_KEY = resolveEncryptionKey(targetArgs.envFile, target.name);

  await upsertOrganizationToolSecret(db, {
    organizationId,
    provider: "traditional_gu_firestore",
    config: firestoreMaterial.config as unknown as Record<string, unknown>,
    secret: firestoreMaterial.secret as unknown as Record<string, unknown>,
  });
  const firestoreRow = await markOrganizationToolSecretTested(db, {
    organizationId,
    provider: "traditional_gu_firestore",
    ok: firestoreCheck.ok,
    error: firestoreCheck.ok ? null : firestoreCheck.detail,
  });
  console.log(`\nstored traditional_gu_firestore -> status ${firestoreRow?.status}`);

  if (mongoMaterial && mongoCheck) {
    await upsertOrganizationToolSecret(db, {
      organizationId,
      provider: "traditional_gu_mongo",
      config: mongoMaterial.config as unknown as Record<string, unknown>,
      secret: mongoMaterial.secret as unknown as Record<string, unknown>,
    });
    const mongoRow = await markOrganizationToolSecretTested(db, {
      organizationId,
      provider: "traditional_gu_mongo",
      ok: mongoCheck.ok,
      error: mongoCheck.ok ? null : mongoCheck.detail,
    });
    console.log(`stored traditional_gu_mongo -> status ${mongoRow?.status}`);
  }

  // Read back through the public projection, which cannot select ciphertext.
  for (const provider of ["traditional_gu_firestore", "traditional_gu_mongo"] as const) {
    const row = await getOrganizationToolSecretPublic(db, { organizationId, provider });
    if (row) {
      console.log(
        `  ${provider}: status=${row.status} checked=${row.last_checked_at ?? "never"}` +
          (row.last_error ? ` error=${row.last_error}` : "")
      );
    }
  }
}

void main().catch((error) => {
  console.error(`bootstrap-legacy-credentials: ${(error as Error).message}`);
  process.exitCode = 1;
});
