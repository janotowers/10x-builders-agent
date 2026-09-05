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
import { writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import {
  getOrganizationById,
  getOrganizationToolSecretPublic,
  markOrganizationToolSecretTested,
  parseTraditionalGuFirestoreMaterial,
  parseTraditionalGuMongoMaterial,
  upsertOrganizationToolSecret,
  type DbClient,
  type OrganizationToolSecretPublic,
} from "@agents/db";
import {
  resolveTarget,
  assertBinding,
  describeTarget,
  parseTargetArgs,
  resolveEncryptionKeyForTarget,
} from "./lib/target-env";
import {
  assertProductionReadAcknowledged,
  describeLegacyTarget,
  parseLegacyArgs,
  resolveLegacyTarget,
} from "./lib/legacy-target";

const require_ = createRequire(import.meta.url);

function parseOrganization(argv: string[]): string {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--organization") return (argv[++i] ?? "").trim();
  }
  return "";
}

function parseNamed(argv: string[], flag: string): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === flag) return (argv[++i] ?? "").trim() || undefined;
  }
  return undefined;
}

/**
 * The outcome of a connection check, in three states rather than two.
 *
 * `unreachable` exists because "the provider rejected this credential" and
 * "this machine could not reach the provider" are different facts with
 * different consequences, and collapsing them would record a perfectly good
 * credential as `invalid` because of a local network condition. Only `failed`
 * marks a credential invalid; `unreachable` leaves it `pending_test`, which is
 * exactly what it is - unproven.
 */
type CheckOutcome = {
  outcome: "passed" | "failed" | "unreachable";
  detail: string;
};

/** Network-shaped failures that happen before any credential is evaluated. */
function looksUnreachable(message: string): boolean {
  return /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|querySrv|getaddrinfo|ETIMEDOUT|ENETUNREACH|socket hang up/i.test(
    message
  );
}

/**
 * One narrow read per provider, to prove the credential actually works before
 * it is marked `active`. Deliberately the cheapest possible read: existence of
 * an allowlisted collection, never a document's contents.
 */
async function checkFirestore(
  keyFilePath: string,
  projectId: string
): Promise<CheckOutcome> {
  try {
    const { Firestore } = require_("@google-cloud/firestore") as typeof import("@google-cloud/firestore");
    const db = new Firestore({ projectId, keyFilename: keyFilePath });
    const snapshot = await db.collection("leads").limit(1).get();
    return {
      outcome: "passed",
      detail: `leads readable (${snapshot.size} document sampled)`,
    };
  } catch (error) {
    const message = (error as Error).message;
    return {
      outcome: looksUnreachable(message) ? "unreachable" : "failed",
      detail: message,
    };
  }
}

async function checkMongo(uri: string, database: string): Promise<CheckOutcome> {
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
      // the database name is exactly the thing that was wrong before. Say so
      // rather than reporting a confident success.
      return {
        outcome: "failed",
        detail: `${database}.appointments answered with 0 documents - check the database name`,
      };
    }
    return {
      outcome: "passed",
      detail: `${database}.appointments reachable (~${count} documents)`,
    };
  } catch (error) {
    const message = (error as Error).message;
    return {
      outcome: looksUnreachable(message) ? "unreachable" : "failed",
      detail: message,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

/**
 * Turns a check outcome into the credential's lifecycle state.
 *
 *   passed      -> active
 *   failed      -> invalid, with the reason
 *   unreachable -> left at `pending_test`. It is unproven, not broken, and
 *                  calling it invalid would be a claim the check cannot make.
 */
async function applyCheckOutcome(
  db: DbClient,
  organizationId: string,
  provider: "traditional_gu_firestore" | "traditional_gu_mongo",
  check: CheckOutcome
): Promise<OrganizationToolSecretPublic | null> {
  if (check.outcome === "unreachable") {
    console.log(
      `  leaving ${provider} at pending_test: the provider could not be reached from here, ` +
        "which is not evidence that the credential is invalid"
    );
    return getOrganizationToolSecretPublic(db, { organizationId, provider });
  }
  return markOrganizationToolSecretTested(db, {
    organizationId,
    provider,
    ok: check.outcome === "passed",
    error: check.outcome === "passed" ? null : check.detail,
  });
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
  console.log(
    `  connection check: ${firestoreCheck.outcome.toUpperCase()} - ${firestoreCheck.detail}`
  );

  // ── Mongo ────────────────────────────────────────────────────────
  let mongoCheck: CheckOutcome | null = null;
  let mongoMaterial: ReturnType<typeof parseTraditionalGuMongoMaterial> | null = null;
  if (legacy.mongo) {
    mongoMaterial = parseTraditionalGuMongoMaterial({
      uri: legacy.mongo.uri,
      database: legacy.mongo.database,
    });
    console.log(
      `\ntraditional_gu_mongo: host=${mongoMaterial.config.host} database=${mongoMaterial.config.database}`
    );
    // The check may use a resolver-independent connection form; what gets
    // STORED is always the configured (portable) URI.
    mongoCheck = await checkMongo(
      legacy.mongo.checkUri ?? legacy.mongo.uri,
      legacy.mongo.database
    );
    console.log(
      `  connection check: ${mongoCheck.outcome.toUpperCase()} - ${mongoCheck.detail}` +
        (legacy.mongo.checkUri ? " [via the resolver-independent check form]" : "")
    );
  } else {
    console.log("\ntraditional_gu_mongo: not configured - skipping (only appointment_get needs it)");
  }

  if (!targetArgs.apply) {
    console.log("\ndry run complete. Nothing was stored.");
    return;
  }

  // Status observed immediately after storage, before any transition, so the
  // lifecycle is evidenced as a transition rather than inferred from its end
  // state.
  const lifecycleObserved: Record<string, { afterUpsert: string | null }> = {};

  // Bind the encryption key to the declared target. Resolved here rather than
  // up front so a dry run - which validates the material and the connectivity
  // and stores nothing - does not require the deployment key at all.
  process.env.ENCRYPTION_KEY = resolveEncryptionKeyForTarget(
    targetArgs.envFile,
    target.name
  );

  await upsertOrganizationToolSecret(db, {
    organizationId,
    provider: "traditional_gu_firestore",
    config: firestoreMaterial.config as unknown as Record<string, unknown>,
    secret: firestoreMaterial.secret as unknown as Record<string, unknown>,
  });
  const firestoreAfterUpsert = await getOrganizationToolSecretPublic(db, {
    organizationId,
    provider: "traditional_gu_firestore",
  });
  lifecycleObserved.traditional_gu_firestore = {
    afterUpsert: firestoreAfterUpsert?.status ?? null,
  };
  console.log(
    `\nafter upsert  traditional_gu_firestore -> status ${firestoreAfterUpsert?.status}`
  );
  const firestoreRow = await applyCheckOutcome(
    db,
    organizationId,
    "traditional_gu_firestore",
    firestoreCheck
  );
  console.log(`after check   traditional_gu_firestore -> status ${firestoreRow?.status}`);

  if (mongoMaterial && mongoCheck) {
    await upsertOrganizationToolSecret(db, {
      organizationId,
      provider: "traditional_gu_mongo",
      config: mongoMaterial.config as unknown as Record<string, unknown>,
      secret: mongoMaterial.secret as unknown as Record<string, unknown>,
    });
    const mongoAfterUpsert = await getOrganizationToolSecretPublic(db, {
      organizationId,
      provider: "traditional_gu_mongo",
    });
    lifecycleObserved.traditional_gu_mongo = {
      afterUpsert: mongoAfterUpsert?.status ?? null,
    };
    console.log(`after upsert  traditional_gu_mongo -> status ${mongoAfterUpsert?.status}`);
    const mongoRow = await applyCheckOutcome(
      db,
      organizationId,
      "traditional_gu_mongo",
      mongoCheck
    );
    console.log(`after check   traditional_gu_mongo -> status ${mongoRow?.status}`);
  }

  // Read back through the public projection, which cannot select ciphertext.
  // This read-back is the evidence that the `pending_test -> active` transition
  // actually landed, rather than that the update call returned without error.
  const stored: Record<string, unknown> = {};
  for (const provider of ["traditional_gu_firestore", "traditional_gu_mongo"] as const) {
    const row = await getOrganizationToolSecretPublic(db, { organizationId, provider });
    if (row) {
      console.log(
        `  ${provider}: status=${row.status} checked=${row.last_checked_at ?? "never"}` +
          (row.last_error ? ` error=${row.last_error}` : "")
      );
      stored[provider] = {
        status: row.status,
        lastCheckedAt: row.last_checked_at,
        lastError: row.last_error,
        // Identity metadata only. The ciphertext column is not selectable here.
        config: row.config_jsonb,
      };
    }
  }

  const jsonPath = parseNamed(argv, "--json");
  if (jsonPath) {
    writeFileSync(
      jsonPath,
      `${JSON.stringify(
        {
          slice: "SL-1",
          step: "organization-scoped credential storage",
          guOsEnvironment: target.name,
          guOsProjectRef: target.projectRef,
          legacyEnvironment: legacy.environment,
          legacyFirestoreProject: legacy.firestore.projectId,
          organizationId,
          ranAt: new Date().toISOString(),
          lifecycle:
            "every stored credential lands `pending_test`; a real connection check per provider then flips it to `active`, records `invalid`, or - when the provider could not be reached at all - leaves it `pending_test` as unproven rather than broken",
          lifecycleObserved,
          connectionChecks: {
            traditional_gu_firestore: firestoreCheck,
            traditional_gu_mongo: mongoCheck,
          },
          stored,
        },
        null,
        2
      )}
`,
      "utf8"
    );
    console.log(`
evidence written to ${jsonPath}`);
  }
}

void main().catch((error) => {
  console.error(`bootstrap-legacy-credentials: ${(error as Error).message}`);
  process.exitCode = 1;
});
