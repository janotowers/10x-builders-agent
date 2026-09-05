// Hosted verification for the bounded Traditional Gu read capabilities
// (R1 SL-1, SA-1.2 and SA-1.3).
//
// This is the fourth verification layer for a source system Gu OS does not own.
// The existing harness (`verify-hosted.ts`) targets Supabase only, so this is
// the legacy-target half the SL-1 Definition of Done says is built inside the
// Slice - bounded to what SA-1.2/SA-1.3 need, not a generic multi-provider
// framework. It follows the same discipline: explicit target, fail closed,
// read-only, evidence written as data.
//
// What it proves that a fixture cannot:
//   SA-1.2  a REAL lead is read from a real environment, and the result carries
//           provenance AND freshness metadata;
//   SA-1.3  that lead's recent messages are read thread-aware, with `source`
//           and `delivery_status` per item.
//
// Read-only throughout. The gateway has no write path, and this script adds
// none.
//
// PRIVACY: the evidence file records shapes, counts, provenance and freshness -
// never message text, never a phone number, never an unredacted identifier.
// Evidence from a real environment must be safe to attach to a PR.
//
// Usage:
//   npx tsx scripts/verify-legacy-reads.ts \
//     --env-file .env.staging.local --env staging \
//     --legacy-env stage --organization <uuid> --lead <legacy lead id> \
//     [--deal <legacy deal id>] [--property <legacy property id>] \
//     [--json evidence.json]

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import {
  deleteOrganizationFlag,
  getOrganizationById,
  getOrganizationFlag,
  getOrganizationToolSecretPublic,
  setOrganizationFlag,
  type DbClient,
} from "@agents/db";
import {
  appointmentGet,
  createFirestoreReader,
  createMongoReader,
  isLegacyReadRefusal,
  legacyLeadGetContext,
  legacyLeadGetRecentMessages,
  propertyGetDetails,
  closeLegacySourceConnections,
  resolveLegacySourceReaders,
} from "../apps/web/src/lib/legacy-gateway";
import {
  resolveTarget,
  assertBinding,
  describeTarget,
  parseTargetArgs,
} from "./lib/target-env";
import {
  LEGACY_FIRESTORE_PROJECTS,
  assertProductionReadAcknowledged,
  describeLegacyTarget,
  parseLegacyArgs,
  resolveLegacyTarget,
} from "./lib/legacy-target";

interface Check {
  assertion: string;
  label: string;
  ok: boolean;
  detail?: string;
}

const checks: Check[] = [];
function record(assertion: string, label: string, ok: boolean, detail?: string): void {
  checks.push({ assertion, label, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  [${assertion}] ${label}${detail ? ` - ${detail}` : ""}`);
}

/** Stable, non-reversible stand-in so evidence can correlate without exposing. */
function redact(value: string | null): string | null {
  if (!value) return null;
  return `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

/**
 * Set once the run has switched a flag on, so a crash restores it too. A
 * bounded activation that only unwinds on the happy path is not bounded.
 */
let pendingFlagRestore: (() => Promise<string>) | null = null;

function parseNamed(argv: string[], flag: string): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === flag) return (argv[++i] ?? "").trim() || undefined;
  }
  return undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const targetArgs = parseTargetArgs(argv);
  const legacyArgs = parseLegacyArgs(argv);
  const organizationId = parseNamed(argv, "--organization");
  // `--lead-file` exists because a legacy lead id embeds three phone numbers.
  // Passing it on a command line puts personal data into shell history and
  // terminal scrollback; reading it from a git-ignored file does not.
  const leadFile = parseNamed(argv, "--lead-file");
  const legacyLeadId =
    parseNamed(argv, "--lead") ??
    (leadFile ? readFileSync(leadFile, "utf8").trim() || undefined : undefined);
  const legacyDealId = parseNamed(argv, "--deal");
  const legacyPropertyId = parseNamed(argv, "--property");
  const jsonPath = parseNamed(argv, "--json");

  if (!organizationId) throw new Error("--organization <uuid> is required.");
  if (!legacyLeadId) {
    throw new Error(
      "--lead <legacy lead id> or --lead-file <path> is required: SA-1.2 asks for a REAL " +
        "lead, and there is no meaningful hosted evidence without one."
    );
  }
  // By DEFAULT this run resolves its readers through the Organization-scoped
  // credential path, because that is the path the product uses and the one the
  // Definition of Done requires evidence for. Reading through the declared
  // legacy target instead bypasses `organization_tool_secrets` entirely, so it
  // proves the adapters and proves nothing about credential resolution - it is
  // available, but only as an explicit declaration.
  const readersFromDeclaredTarget = argv.includes("--readers-from-declared-target");
  const credentialsNotYetStored = argv.includes("--credentials-not-yet-stored");
  if (credentialsNotYetStored && !readersFromDeclaredTarget) {
    throw new Error(
      "--credentials-not-yet-stored requires --readers-from-declared-target: without a " +
        "stored credential there is nothing for the Organization-scoped path to resolve."
    );
  }
  // A bounded activation: the gateway is inert unless `relationship_ops` is on,
  // and the approved Slice does not require the flag to stay on afterwards.
  // With this flag the run switches it on and restores the Organization to
  // exactly the state it found - including removing a row that did not exist.
  const activateFlagForRun = argv.includes("--activate-flag-for-run");

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
  console.log(`lead: ${redact(legacyLeadId)} (identifier redacted in output)\n`);

  if (!target.serviceRoleKey || !target.supabaseUrl) {
    throw new Error(
      "FAIL CLOSED - the gateway resolves Organization-scoped credentials from a " +
        "service-role-only table and needs GUOS_TARGET_SERVICE_ROLE_KEY / _SUPABASE_URL."
    );
  }
  const db = createClient(target.supabaseUrl, target.serviceRoleKey) as unknown as DbClient;

  const organization = await getOrganizationById(db, organizationId);
  record(
    "setup",
    "Organization resolves in the declared Gu OS environment",
    Boolean(organization),
    organization ? `${organization.name} (${organization.status})` : "not found"
  );
  const credential = await getOrganizationToolSecretPublic(db, {
    organizationId,
    provider: "traditional_gu_firestore",
  });
  if (credentialsNotYetStored) {
    record(
      "declared-incomplete",
      "Organization-scoped credential storage is declared NOT yet configured",
      credential?.status !== "active",
      `status ${credential?.status ?? "absent"} - this run reads through the declared ` +
        "legacy target and therefore evidences the adapters, NOT credential resolution"
    );
  } else {
    record(
      "setup",
      "Organization holds an active traditional_gu_firestore credential",
      credential?.status === "active",
      `status ${credential?.status ?? "absent"}` +
        (credential?.last_checked_at
          ? `, connection-checked ${credential.last_checked_at}`
          : ", never connection-checked")
    );
  }

  // ── Bounded flag activation ──────────────────────────────────────
  // Recorded before anything changes, so restoration is against an observed
  // prior state rather than an assumed one.
  const priorFlag = await getOrganizationFlag(db, organizationId, "relationship_ops");
  const priorFlagState = priorFlag
    ? { present: true, enabled: priorFlag.enabled }
    : { present: false, enabled: false };
  let flagActivatedByThisRun = false;
  if (activateFlagForRun && !priorFlagState.enabled) {
    await setOrganizationFlag(db, {
      organizationId,
      flagKey: "relationship_ops",
      enabled: true,
    });
    flagActivatedByThisRun = true;
    pendingFlagRestore = () => restoreFlag();
    console.log(
      `  NOTE  relationship_ops activated for this run only (prior: ` +
        `${priorFlagState.present ? `present, enabled=${priorFlagState.enabled}` : "absent"})`
    );
  }

  const restoreFlag = async (): Promise<string> => {
    if (!flagActivatedByThisRun) return "not touched by this run";
    if (!priorFlagState.present) {
      await deleteOrganizationFlag(db, { organizationId, flagKey: "relationship_ops" });
      return "row removed - restored to absent, exactly as found";
    }
    await setOrganizationFlag(db, {
      organizationId,
      flagKey: "relationship_ops",
      enabled: priorFlagState.enabled,
    });
    return `restored to enabled=${priorFlagState.enabled}`;
  };

  const ctx = { db, organizationId };
  const env = { LEGACY_GATEWAY_ENABLED: "true" };
  const evidence: Record<string, unknown> = {};

  // ── Reader source ────────────────────────────────────────────────
  let readers;
  if (readersFromDeclaredTarget) {
    readers = {
      firestore: createFirestoreReader({
        organizationId,
        credentials: {
          projectId: legacy.firestore.projectId,
          clientEmail: legacy.firestore.clientEmail,
          privateKey: String(legacy.firestore.serviceAccount.private_key ?? ""),
        },
      }),
      mongo: legacy.mongo
        ? createMongoReader({
            organizationId,
            credentials: { uri: legacy.mongo.uri, database: legacy.mongo.database },
          })
        : null,
    };
    record(
      "declared-incomplete",
      "readers built from the DECLARED legacy target, bypassing credential resolution",
      true,
      "explicitly declared; this run makes no claim about organization_tool_secrets"
    );
  } else {
    // The product path: credentials resolved per Organization out of
    // `organization_tool_secrets`, decrypted server-side, adapters built from
    // what comes back. Nothing here supplies a credential.
    readers = await resolveLegacySourceReaders({
      db,
      organizationId,
      capability: "legacy_lead_get_context",
      externalId: legacyLeadId,
      needsMongo: Boolean(legacyDealId),
    });
    record(
      "SA-1.2",
      "readers resolved through the Organization-scoped credential path",
      true,
      "organization_tool_secrets -> decrypt -> adapter; no credential supplied by this run"
    );
    // The stored credential must be the identity the run declares it is. A
    // mismatch would produce evidence labelled with the wrong environment.
    const storedProject = (credential?.config_jsonb as { project_id?: string } | undefined)
      ?.project_id;
    record(
      "SA-1.2",
      "the stored credential binds to the declared legacy environment",
      storedProject === LEGACY_FIRESTORE_PROJECTS[legacy.environment],
      `stored project ${storedProject ?? "unknown"}, declared ${legacy.environment} ` +
        `= ${LEGACY_FIRESTORE_PROJECTS[legacy.environment]}`
    );
  }
  const readerSource = readersFromDeclaredTarget
    ? "declared_target"
    : "organization_credential";

  // ── SA-1.2 ───────────────────────────────────────────────────────
  try {
    const lead = await legacyLeadGetContext({ ctx, readers, legacyLeadId, env });
    record("SA-1.2", "a real lead is read through the capability", true);
    record(
      "SA-1.2",
      "the result carries provenance",
      Boolean(
        lead.provenance.sourceSystem &&
          lead.provenance.store &&
          lead.provenance.sourcePath &&
          lead.provenance.capability &&
          lead.provenance.adapter &&
          lead.provenance.organizationId
      ),
      `${lead.provenance.store}:${lead.provenance.capability} via ${lead.provenance.adapter}`
    );
    record(
      "SA-1.2",
      "the result carries freshness metadata",
      Boolean(lead.provenance.freshness.readAt) &&
        lead.provenance.freshness.sourceUpdatedAt !== null &&
        lead.provenance.freshness.ageSeconds !== null,
      `field ${lead.provenance.freshness.sourceUpdatedAtField}, age ${lead.provenance.freshness.ageSeconds}s`
    );
    record(
      "SA-1.2",
      "the read was contained to this Organization",
      Boolean(lead.value.ownerLegacyUserId),
      `owner resolved through external_identity_bindings`
    );
    evidence.leadContext = {
      legacyLeadId: redact(lead.value.legacyLeadId),
      ownerLegacyUserId: redact(lead.value.ownerLegacyUserId),
      status: lead.value.status,
      clientType: lead.value.clientType,
      originLabel: lead.value.originLabel,
      fieldsPresent: Object.entries(lead.value)
        .filter(([, value]) => value !== null)
        .map(([key]) => key),
      provenance: {
        ...lead.provenance,
        externalId: redact(lead.provenance.externalId),
        sourcePath: lead.provenance.sourcePath.replace(legacyLeadId, "<lead>"),
      },
    };
  } catch (error) {
    record(
      "SA-1.2",
      "a real lead is read through the capability",
      false,
      isLegacyReadRefusal(error) ? `refused: ${error.reason}` : (error as Error).message
    );
  }

  // ── SA-1.3 ───────────────────────────────────────────────────────
  try {
    const messages = await legacyLeadGetRecentMessages({
      ctx,
      readers,
      legacyLeadId,
      limit: 50,
      env,
    });
    const threadKinds = new Set(messages.value.threads.map((thread) => thread.kind));
    record(
      "SA-1.3",
      "recent messages are read for the same real lead",
      messages.value.items.length > 0,
      `${messages.value.items.length} items across ${messages.value.threads.length} thread(s)`
    );
    record(
      "SA-1.3",
      "every item names its thread",
      messages.value.items.every((item) => Boolean(item.thread.threadId))
    );
    record(
      "SA-1.3",
      "every item carries a delivery status (unknown is a value, not a gap)",
      messages.value.items.every((item) => Boolean(item.deliveryStatus))
    );
    record(
      "SA-1.3",
      "the thread dimension is modelled (gu / advisor)",
      threadKinds.size > 0,
      `kinds observed: ${[...threadKinds].join(", ") || "none"}`
    );
    const statusCounts: Record<string, number> = {};
    const sourceCounts: Record<string, number> = {};
    for (const item of messages.value.items) {
      statusCounts[item.deliveryStatus] = (statusCounts[item.deliveryStatus] ?? 0) + 1;
      const key = item.source ?? "(none)";
      sourceCounts[key] = (sourceCounts[key] ?? 0) + 1;
    }
    evidence.recentMessages = {
      threads: messages.value.threads.map((thread) => ({
        kind: thread.kind,
        threadId: redact(thread.threadId),
        advisorEndpoint: thread.advisorEndpoint ? "present" : null,
      })),
      itemCount: messages.value.items.length,
      truncated: messages.value.truncated,
      deliveryStatusCounts: statusCounts,
      sourceCounts,
      directionCounts: messages.value.items.reduce<Record<string, number>>(
        (acc, item) => {
          acc[item.direction] = (acc[item.direction] ?? 0) + 1;
          return acc;
        },
        {}
      ),
      withWamid: messages.value.items.filter((item) => item.wamid).length,
      provenance: {
        ...messages.provenance,
        externalId: redact(messages.provenance.externalId),
        sourcePath: messages.provenance.sourcePath.replace(legacyLeadId, "<lead>"),
      },
    };
  } catch (error) {
    record(
      "SA-1.3",
      "recent messages are read for the same real lead",
      false,
      isLegacyReadRefusal(error) ? `refused: ${error.reason}` : (error as Error).message
    );
  }

  // ── Optional: the two capabilities the approved DoD does NOT require
  //    against real hosted data. Run only when an id is supplied, and reported
  //    separately so the evidence never overstates what SL-1 claims. ─────────
  if (legacyDealId) {
    try {
      const appointments = await appointmentGet({ ctx, readers, legacyDealId, env });
      record(
        "optional",
        "appointment_get answers for a real deal",
        true,
        `${appointments.value.entries.length} entr(ies); stores consulted: ` +
          `firestore=${appointments.value.storesConsulted.firestore} mongo=${appointments.value.storesConsulted.mongo}`
      );
      evidence.appointments = {
        legacyDealId: redact(legacyDealId),
        storesConsulted: appointments.value.storesConsulted,
        entries: appointments.value.entries.map((entry) => ({
          presence: entry.presence,
          storesDisagree: entry.storesDisagree,
          disagreements: entry.disagreements,
          firestoreStatus: entry.firestore?.status ?? null,
          mongoStatus: entry.mongo?.status ?? null,
        })),
      };
    } catch (error) {
      record(
        "optional",
        "appointment_get answers for a real deal",
        false,
        isLegacyReadRefusal(error) ? `refused: ${error.reason}` : (error as Error).message
      );
    }
  }

  if (legacyPropertyId) {
    try {
      const property = await propertyGetDetails({ ctx, readers, legacyPropertyId, env });
      record("optional", "property_get_details answers for a real property", true);
      evidence.property = {
        legacyPropertyId: redact(legacyPropertyId),
        fieldsPresent: Object.entries(property.value)
          .filter(([, value]) => value !== null)
          .map(([key]) => key),
        freshness: property.provenance.freshness,
      };
    } catch (error) {
      record(
        "optional",
        "property_get_details answers for a real property",
        false,
        isLegacyReadRefusal(error) ? `refused: ${error.reason}` : (error as Error).message
      );
    }
  }

  const flagRestoration = await restoreFlag();
  pendingFlagRestore = null;
  if (flagActivatedByThisRun) {
    record(
      "setup",
      "relationship_ops restored to its pre-run state",
      true,
      flagRestoration
    );
  }

  await closeLegacySourceConnections();

  const required = checks.filter(
    (check) => check.assertion !== "optional" && check.assertion !== "declared-incomplete"
  );
  const failed = required.filter((check) => !check.ok);
  const report = {
    slice: "SL-1",
    guOsEnvironment: target.name,
    guOsProjectRef: target.projectRef,
    legacyEnvironment: legacy.environment,
    legacyFirestoreProject: legacy.firestore.projectId,
    legacyReadIdentity: legacy.firestore.clientEmail,
    organizationId,
    ranAt: new Date().toISOString(),
    // Where each moving part actually lives, because "staging" alone is
    // ambiguous across four different things in this run.
    topology: {
      verifierProcess: "operator workstation (this machine)",
      guOsHostedState: `Gu OS ${target.name} (Supabase project ${target.projectRef}) - the only place this run mutates anything`,
      legacySource: `Traditional Gu ${legacy.environment} (${legacy.firestore.projectId}) - READ ONLY`,
      legacyMongo: legacy.mongo
        ? "single Atlas cluster, production by construction - READ ONLY"
        : "not configured for this run",
      guOsApplicationRuntime:
        "none deployed in this environment; the gateway code runs in this verifier process",
    },
    readerSource,
    relationshipOpsFlag: {
      priorState: priorFlagState.present
        ? `present, enabled=${priorFlagState.enabled}`
        : "absent",
      activatedByThisRun: flagActivatedByThisRun,
      restoration: flagRestoration,
    },
    required: { total: required.length, passed: required.length - failed.length },
    optional: checks.filter((check) => check.assertion === "optional"),
    checks,
    evidence,
    declaredIncomplete: checks.filter((c) => c.assertion === "declared-incomplete"),
    notExercised: [
      readersFromDeclaredTarget
        ? "the Organization-scoped credential path (organization_tool_secrets) - this run read through the declared legacy target instead"
        : null,
      legacyDealId ? null : "appointment_get against real hosted data",
      legacyPropertyId ? null : "property_get_details against real hosted data",
    ].filter(Boolean),
  };

  if (jsonPath) {
    writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`\nevidence written to ${jsonPath}`);
  }
  console.log(
    `\nverify-legacy-reads: ${report.required.passed}/${report.required.total} required checks passed ` +
      `on Gu OS "${target.name}" against legacy "${legacy.environment}"`
  );
  if (failed.length > 0) process.exitCode = 1;
}

void main().catch(async (error) => {
  if (pendingFlagRestore) {
    // The run failed after switching a flag on. Restoring it is not optional.
    try {
      console.error(`verify-legacy-reads: restoring relationship_ops - ${await pendingFlagRestore()}`);
    } catch (restoreError) {
      console.error(
        "verify-legacy-reads: COULD NOT RESTORE relationship_ops - restore it manually:",
        (restoreError as Error).message
      );
    }
  }
  await closeLegacySourceConnections().catch(() => undefined);
  console.error(`verify-legacy-reads: ${(error as Error).message}`);
  process.exitCode = 1;
});
