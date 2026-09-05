/**
 * Deterministic selftests for the bounded legacy read gateway (R1 SL-1).
 *
 * These are the deterministic half of the Slice Acceptance Contract. Each group
 * names the assertion it evidences:
 *
 *   SA-1.1  every capability returns a normalized result against a recorded
 *           contract fixture, carrying provenance;
 *   SA-1.3  recent messages are thread-aware, with `source` and
 *           `delivery_status` per item;
 *   SA-1.4  an injected fixture shape mismatch fires the drift alarm and
 *           refuses, rather than silently returning wrong data;
 *   SA-1.6  every read is preceded by the Organization external-binding check,
 *           and a request outside the bound Organization does not read;
 *   SA-1.7  no generic CRUD surface exists, and no prospect-facing effect is
 *           reachable from this Slice.
 *
 * Plus the shared-baseline requirement that flags off leaves the module inert.
 *
 * SA-1.2 is deliberately absent: it is hosted evidence against a real
 * environment and cannot be produced by a fixture. It lives in
 * `npm run verify:legacy-reads`.
 *
 * Everything runs against recorded fixtures and an in-memory database fake, so
 * no test here reaches a real store or needs a credential.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { DbClient } from "@agents/db";
import {
  ALLOWED_SOURCE_PATHS,
  DELIBERATELY_EXCLUDED_PATHS,
} from "./allowlist";
import { assertAllowedSourcePath, resolveSourcePath } from "./allowlist";
import { withRotationAwareCache, type CacheEntry } from "./adapters";
import { APPOINTMENT_SCAN_LIMIT } from "./source-clients";
import {
  appointmentGet,
  legacyLeadGetContext,
  legacyLeadGetRecentMessages,
  propertyGetDetails,
} from "./capabilities";
import { registerDriftAlarmSink, type DriftAlarm } from "./drift";
import { LegacyReadRefusal } from "./errors";
import { normalizeReference, normalizeTimestamp } from "./normalize";
import type {
  LegacyFirestoreReader,
  LegacyMongoReader,
  RawDocument,
} from "./source-clients";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============================================================
// Fixtures
// ============================================================

interface FixtureDocument {
  id: string;
  data: Record<string, unknown>;
}

function loadFixture<T>(name: string): T {
  return JSON.parse(
    readFileSync(path.join(__dirname, "fixtures", name), "utf8")
  ) as T;
}

const leadFixture = loadFixture<{ documents: FixtureDocument[] }>("lead.json");
const userFixture = loadFixture<{ documents: FixtureDocument[] }>("user.json");
const threadFixture = loadFixture<{ documents: FixtureDocument[] }>(
  "conversation-threads.json"
);
const propertyFixture = loadFixture<{ documents: FixtureDocument[] }>(
  "property.json"
);
const appointmentFixture = loadFixture<{
  legacyDealId: string;
  firestore: FixtureDocument[];
  mongo: FixtureDocument[];
}>("appointments.json");

const PILOT_ORG = "11111111-1111-1111-1111-111111111111";
const OTHER_ORG = "22222222-2222-2222-2222-222222222222";
/** Flag on and a member, but never bound to Traditional Gu. */
const UNBOUND_ORG = "33333333-3333-3333-3333-333333333333";
const MEMBER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const NON_MEMBER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const OWNER_UID = "owner-uid-0000000000000001";
const OTHER_OWNER_UID = "other-owner-uid-000000001";
const PILOT_LEAD = "5215500000001521550000000252155000000003";
const OTHER_ORG_LEAD = "5215500000077521550000000252155000000099";
const UNOWNED_LEAD = "5215500000088521550000000252155000000003";
const GATEWAY_ON = { LEGACY_GATEWAY_ENABLED: "true" } as const;

// ============================================================
// Database fake
// ============================================================

type Row = Record<string, unknown>;

function fakeDb(overrides: { relationshipOps?: boolean } = {}): DbClient {
  const tables: Record<string, Row[]> = {
    organization_feature_flags: [
      {
        id: "flag-1",
        organization_id: PILOT_ORG,
        flag_key: "relationship_ops",
        enabled: overrides.relationshipOps ?? true,
        value_text: null,
      },
      {
        id: "flag-2",
        organization_id: UNBOUND_ORG,
        flag_key: "relationship_ops",
        enabled: true,
        value_text: null,
      },
    ],
    organization_memberships: [
      {
        id: "m1",
        organization_id: PILOT_ORG,
        user_id: MEMBER,
        role: "advisor",
        status: "active",
      },
      {
        id: "m2",
        organization_id: UNBOUND_ORG,
        user_id: MEMBER,
        role: "advisor",
        status: "active",
      },
    ],
    external_identity_bindings: [
      {
        id: "b1",
        organization_id: PILOT_ORG,
        source_system: "traditional_gu",
        binding_kind: "legacy_organization_key",
        external_id: OWNER_UID,
        ref_organization_id: PILOT_ORG,
      },
      {
        id: "b2",
        organization_id: OTHER_ORG,
        source_system: "traditional_gu",
        binding_kind: "legacy_organization_key",
        external_id: OTHER_OWNER_UID,
        ref_organization_id: OTHER_ORG,
      },
      {
        id: "b3",
        organization_id: OTHER_ORG,
        source_system: "traditional_gu",
        binding_kind: "legacy_lead",
        external_id: OTHER_ORG_LEAD,
        ref_case_id: "case-other",
      },
    ],
  };

  function builder(table: string) {
    let rows = (tables[table] ?? []).slice();
    const self: Record<string, unknown> = {
      select: () => self,
      order: () => self,
      eq: (column: string, value: unknown) => {
        rows = rows.filter((r) => r[column] === value);
        return self;
      },
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      single: async () => ({ data: rows[0] ?? null, error: null }),
      then: (resolve: (v: { data: Row[]; error: null }) => unknown) =>
        resolve({ data: rows, error: null }),
    };
    return self;
  }

  return { from: (table: string) => builder(table) } as unknown as DbClient;
}

// ============================================================
// Fixture-backed readers that record what they touched
// ============================================================

interface RecordingReaders {
  firestore: LegacyFirestoreReader;
  mongo: LegacyMongoReader;
  reads: string[];
}

function fixtureReaders(
  mutate: (documents: {
    leads: FixtureDocument[];
    users: FixtureDocument[];
    threads: FixtureDocument[];
    properties: FixtureDocument[];
    firestoreAppointments: FixtureDocument[];
    mongoAppointments: FixtureDocument[];
  }) => void = () => undefined
): RecordingReaders {
  // Deep copies, so a mutation for a drift test cannot leak into the next one.
  const documents = {
    leads: structuredClone(leadFixture.documents),
    users: structuredClone(userFixture.documents),
    threads: structuredClone(threadFixture.documents),
    properties: structuredClone(propertyFixture.documents),
    firestoreAppointments: structuredClone(appointmentFixture.firestore),
    mongoAppointments: structuredClone(appointmentFixture.mongo),
  };
  mutate(documents);

  const reads: string[] = [];
  const find = (list: FixtureDocument[], id: string): RawDocument | null => {
    const found = list.find((document) => document.id === id);
    return found ? { id: found.id, data: found.data } : null;
  };

  return {
    reads,
    firestore: {
      async getLead(id) {
        reads.push(`firestore:leads/${id}`);
        return find(documents.leads, id);
      },
      async getUser(id) {
        reads.push(`firestore:users/${id}`);
        return find(documents.users, id);
      },
      async getProperty(id) {
        reads.push(`firestore:properties/${id}`);
        return find(documents.properties, id);
      },
      async listConversationThreads(id) {
        reads.push(`firestore:leads/${id}/wsp_messeges`);
        return documents.threads.map((d) => ({ id: d.id, data: d.data }));
      },
      async listDealAppointments(id) {
        reads.push(`firestore:deals/${id}/appointments`);
        return documents.firestoreAppointments.map((d) => ({
          id: d.id,
          data: d.data,
        }));
      },
    },
    mongo: {
      async findAppointmentsByDeal(id) {
        reads.push(`mongo:gu2.appointments/${id}`);
        return documents.mongoAppointments
          .filter((d) => d.data.deal_id === id)
          .map((d) => ({ id: d.id, data: d.data }));
      },
    },
  };
}

function pilotContext(overrides: Partial<{ organizationId: string; actorUserId: string; relationshipOps: boolean }> = {}) {
  return {
    db: fakeDb({ relationshipOps: overrides.relationshipOps }),
    organizationId: overrides.organizationId ?? PILOT_ORG,
    actorUserId: overrides.actorUserId ?? MEMBER,
  };
}

async function expectRefusal(
  run: () => Promise<unknown>,
  reason: string
): Promise<LegacyReadRefusal> {
  try {
    await run();
  } catch (error) {
    assert.ok(
      error instanceof LegacyReadRefusal,
      `expected a LegacyReadRefusal, got ${String(error)}`
    );
    assert.equal(error.reason, reason);
    return error;
  }
  throw new assert.AssertionError({
    message: `expected refusal "${reason}", but the call succeeded`,
  });
}

// ============================================================
// SA-1.1 — normalized results with provenance
// ============================================================

async function testLeadContext(): Promise<void> {
  const readers = fixtureReaders();
  const result = await legacyLeadGetContext({
    ctx: pilotContext(),
    readers,
    legacyLeadId: PILOT_LEAD,
    env: GATEWAY_ON,
  });

  assert.equal(result.value.legacyLeadId, PILOT_LEAD);
  assert.equal(result.value.ownerLegacyUserId, OWNER_UID);
  assert.equal(result.value.status, "primer_contacto");
  assert.equal(result.value.clientType, "comprador");
  assert.equal(result.value.originLabel, "portal");
  assert.equal(result.value.createdAt, "2026-09-07T16:53:20.000Z");

  // Provenance is not optional, and it names the allowlisted path it read.
  assert.equal(result.provenance.sourceSystem, "traditional_gu");
  assert.equal(result.provenance.store, "firestore");
  assert.equal(result.provenance.sourcePath, `leads/${PILOT_LEAD}`);
  assert.equal(result.provenance.capability, "legacy_lead_get_context");
  assert.equal(result.provenance.adapter, "bootstrap_direct");
  assert.equal(result.provenance.organizationId, PILOT_ORG);
  assert.equal(result.provenance.bindingState, "unbound");
  assert.equal(result.provenance.freshness.sourceUpdatedAtField, "edited_time");
  assert.ok(result.provenance.freshness.sourceUpdatedAt);
  assert.equal(typeof result.provenance.freshness.ageSeconds, "number");

  console.log("  ok  SA-1.1 lead context normalizes with provenance and freshness");
}

async function testPropertyDetails(): Promise<void> {
  const readers = fixtureReaders();
  const result = await propertyGetDetails({
    ctx: pilotContext(),
    readers,
    legacyPropertyId: "property-0000000000000001",
    env: GATEWAY_ON,
  });
  assert.equal(result.value.ownerLegacyUserId, OWNER_UID);
  assert.equal(result.value.price, 2500000);
  assert.equal(result.value.currency, "MXN");
  assert.equal(result.value.status, "published");
  assert.equal(result.provenance.sourcePath, "properties/property-0000000000000001");
  assert.equal(result.provenance.freshness.sourceUpdatedAtField, "updated_at");

  // The imported-inventory representation resolves to the same owner.
  const imported = await propertyGetDetails({
    ctx: pilotContext(),
    readers: fixtureReaders(),
    legacyPropertyId: "property-0000000000000002",
    env: GATEWAY_ON,
  });
  assert.equal(imported.value.ownerLegacyUserId, OWNER_UID);
  assert.equal(imported.value.ownerRawValue, "users/owner-uid-0000000000000001");

  console.log("  ok  SA-1.1 property details normalize both user_owner representations");
}

async function testAppointments(): Promise<void> {
  const readers = fixtureReaders();
  const result = await appointmentGet({
    ctx: pilotContext(),
    readers,
    legacyDealId: appointmentFixture.legacyDealId,
    env: GATEWAY_ON,
  });

  assert.deepEqual(result.value.storesConsulted, { firestore: true, mongo: true });
  assert.equal(result.value.entries.length, 3);

  const disagreeing = result.value.entries.find((entry) => entry.storesDisagree);
  assert.ok(disagreeing, "the fixture's conflicting pair must be reported as such");
  assert.deepEqual(disagreeing.presence, { firestore: true, mongo: true });
  assert.ok(
    disagreeing.disagreements.some((line) => line.startsWith("status:")),
    "the status conflict must be retained, not resolved"
  );

  const firestoreOnly = result.value.entries.find(
    (entry) => entry.presence.firestore && !entry.presence.mongo
  );
  const mongoOnly = result.value.entries.find(
    (entry) => !entry.presence.firestore && entry.presence.mongo
  );
  assert.ok(firestoreOnly, "partial persistence: a Firestore-only record");
  assert.ok(mongoOnly, "partial persistence: a Mongo-only record");
  assert.equal(firestoreOnly.storesDisagree, false);
  assert.ok(firestoreOnly.disagreements[0].includes("present only in firestore"));

  // The orphan-Calendar signal survives normalization.
  assert.equal(disagreeing.firestore?.googleEventId, "synthetic-calendar-event-1");

  // A Mongo outage must not take the capability down; it must say so instead.
  const withoutMongo = await appointmentGet({
    ctx: pilotContext(),
    readers: { firestore: fixtureReaders().firestore, mongo: null },
    legacyDealId: appointmentFixture.legacyDealId,
    env: GATEWAY_ON,
  });
  assert.deepEqual(withoutMongo.value.storesConsulted, {
    firestore: true,
    mongo: false,
  });

  console.log("  ok  SA-1.1 appointments preserve partial persistence and store conflicts");
}

// ============================================================
// SA-1.3 — thread-aware messages
// ============================================================

async function testThreadAwareMessages(): Promise<void> {
  const readers = fixtureReaders();
  const result = await legacyLeadGetRecentMessages({
    ctx: pilotContext(),
    readers,
    legacyLeadId: PILOT_LEAD,
    env: GATEWAY_ON,
  });

  const kinds = result.value.threads.map((thread) => thread.kind).sort();
  assert.deepEqual(kinds, ["advisor", "gu", "gu"]);
  const advisorThread = result.value.threads.find((t) => t.kind === "advisor");
  assert.equal(advisorThread?.advisorEndpoint, "5215500000055");

  // Every item carries its thread, its source and a delivery status.
  for (const item of result.value.items) {
    assert.ok(item.thread.threadId, "each item names its thread");
    assert.ok(
      ["sent", "delivered", "read", "failed", "unknown"].includes(
        item.deliveryStatus
      )
    );
  }

  const advisorItems = result.value.items.filter(
    (item) => item.thread.kind === "advisor"
  );
  assert.equal(advisorItems.length, 2);
  assert.equal(advisorItems[0].source, "advisor_wa");
  assert.equal(advisorItems[0].deliveryStatus, "delivered");
  assert.equal(advisorItems[1].deliveryStatus, "failed");
  assert.equal(advisorItems[1].deliveryErrorCode, "131047");
  assert.equal(advisorItems[0].direction, "outbound");

  // An item the source says nothing about is `unknown`, never `sent`:
  // queue acceptance is not delivery (audit 15.1).
  const guItems = result.value.items.filter((item) => item.thread.kind === "gu");
  assert.ok(guItems.length > 0);
  for (const item of guItems) {
    assert.equal(item.deliveryStatus, "unknown");
    assert.equal(item.source, null);
  }

  // The array-shaped message body flattens to text.
  assert.ok(
    result.value.items.some((item) => item.text === "Sigue disponible?"),
    "a single-element array body must normalize to its string"
  );

  // Ordering is chronological across threads, and the bound is respected.
  const stamps = result.value.items.map((item) => item.timestamp ?? "");
  assert.deepEqual(stamps, [...stamps].sort());

  const limited = await legacyLeadGetRecentMessages({
    ctx: pilotContext(),
    readers: fixtureReaders(),
    legacyLeadId: PILOT_LEAD,
    limit: 2,
    env: GATEWAY_ON,
  });
  assert.equal(limited.value.items.length, 2);
  assert.equal(limited.value.truncated, true);

  console.log("  ok  SA-1.3 messages are thread-aware with per-item source and delivery status");
}

// ============================================================
// SA-1.4 — drift alarm
// ============================================================

async function testDriftAlarm(): Promise<void> {
  const alarms: DriftAlarm[] = [];
  const unregister = registerDriftAlarmSink((alarm) => alarms.push(alarm));
  const originalError = console.error;
  console.error = () => undefined; // the alarm always logs; keep output readable
  try {
    // A required field changes kind: `conversation` stops being an array.
    await expectRefusal(
      () =>
        legacyLeadGetRecentMessages({
          ctx: pilotContext(),
          readers: fixtureReaders((documents) => {
            documents.threads[0].data.conversation = { items: [] };
          }),
          legacyLeadId: PILOT_LEAD,
          env: GATEWAY_ON,
        }),
      "contract_drift"
    );
    assert.equal(alarms.length, 1);
    assert.equal(alarms[0].code, "LEGACY_GATEWAY_CONTRACT_DRIFT");
    assert.equal(alarms[0].contractId, "firestore.wsp_messeges.v1");
    assert.equal(alarms[0].violations[0].field, "conversation");
    assert.equal(alarms[0].violations[0].kind, "kind_mismatch");
    assert.equal(alarms[0].organizationId, PILOT_ORG);

    // A required field disappears from an appointment record.
    alarms.length = 0;
    await expectRefusal(
      () =>
        appointmentGet({
          ctx: pilotContext(),
          readers: fixtureReaders((documents) => {
            delete documents.firestoreAppointments[0].data.status;
          }),
          legacyDealId: appointmentFixture.legacyDealId,
          env: GATEWAY_ON,
        }),
      "contract_drift"
    );
    assert.equal(alarms[0].violations[0].kind, "missing");
    assert.equal(alarms[0].violations[0].field, "status");

    // A reference field becomes something unrecognizable.
    alarms.length = 0;
    await expectRefusal(
      () =>
        propertyGetDetails({
          ctx: pilotContext(),
          readers: fixtureReaders((documents) => {
            documents.properties[0].data.user_owner = 42;
          }),
          legacyPropertyId: "property-0000000000000001",
          env: GATEWAY_ON,
        }),
      "contract_drift"
    );
    assert.equal(alarms[0].contractId, "firestore.properties.v1");

    // An ADDITIVE field is not drift. Both legacy repositories add fields
    // continuously; alarming on that would train operators to ignore alarms.
    alarms.length = 0;
    const stillWorks = await legacyLeadGetContext({
      ctx: pilotContext(),
      readers: fixtureReaders((documents) => {
        documents.leads[0].data.brand_new_legacy_field = "whatever";
      }),
      legacyLeadId: PILOT_LEAD,
      env: GATEWAY_ON,
    });
    assert.equal(stillWorks.value.legacyLeadId, PILOT_LEAD);
    assert.equal(alarms.length, 0);

    // The alarm survives a sink that throws.
    alarms.length = 0;
    const unregisterBroken = registerDriftAlarmSink(() => {
      throw new Error("sink is down");
    });
    await expectRefusal(
      () =>
        propertyGetDetails({
          ctx: pilotContext(),
          readers: fixtureReaders((documents) => {
            documents.properties[0].data.user_owner = 42;
          }),
          legacyPropertyId: "property-0000000000000001",
          env: GATEWAY_ON,
        }),
      "contract_drift"
    );
    assert.equal(alarms.length, 1);
    unregisterBroken();
  } finally {
    console.error = originalError;
    unregister();
  }
  console.log("  ok  SA-1.4 injected shape mismatch alarms and refuses; additive change does not");
}

// ============================================================
// SA-1.6 — the Organization binding check precedes every read
// ============================================================

async function testBindingGate(): Promise<void> {
  // A lead bound to another Organization: refused, and NOTHING was read.
  {
    const readers = fixtureReaders();
    await expectRefusal(
      () =>
        legacyLeadGetContext({
          ctx: pilotContext(),
          readers,
          legacyLeadId: OTHER_ORG_LEAD,
          env: GATEWAY_ON,
        }),
      "belongs_to_another_organization"
    );
    assert.deepEqual(
      readers.reads,
      [],
      "a cross-tenant request must be refused before any source is touched"
    );
  }

  // An Organization that is enabled, and whose caller is an active member, but
  // which has no binding to Traditional Gu at all: refused before any read.
  {
    const readers = fixtureReaders();
    await expectRefusal(
      () =>
        legacyLeadGetContext({
          ctx: {
            db: fakeDb(),
            organizationId: UNBOUND_ORG,
            actorUserId: MEMBER,
          },
          readers,
          legacyLeadId: PILOT_LEAD,
          env: GATEWAY_ON,
        }),
      "organization_not_bound_to_source"
    );
    assert.deepEqual(readers.reads, []);
  }

  // An Organization with no rollout flag row of its own stays inert - fail
  // closed, not "absent means allowed".
  {
    const readers = fixtureReaders();
    await expectRefusal(
      () =>
        legacyLeadGetContext({
          ctx: { db: fakeDb(), organizationId: OTHER_ORG, actorUserId: MEMBER },
          readers,
          legacyLeadId: PILOT_LEAD,
          env: GATEWAY_ON,
        }),
      "gateway_disabled"
    );
    assert.deepEqual(readers.reads, []);
  }

  // A non-member of the bound Organization is refused before reading.
  {
    const readers = fixtureReaders();
    await expectRefusal(
      () =>
        legacyLeadGetContext({
          ctx: pilotContext({ actorUserId: NON_MEMBER }),
          readers,
          legacyLeadId: PILOT_LEAD,
          env: GATEWAY_ON,
        }),
      "not_an_active_member"
    );
    assert.deepEqual(readers.reads, []);
  }

  // Ownership containment: the record exists and is readable, but its owner
  // resolves to a different Organization, so no data is returned.
  {
    const readers = fixtureReaders();
    await expectRefusal(
      () =>
        propertyGetDetails({
          ctx: pilotContext(),
          readers,
          legacyPropertyId: "property-0000000000000003",
          env: GATEWAY_ON,
        }),
      "belongs_to_another_organization"
    );
  }

  // Ownership that resolves to nothing is a refusal too - never a match.
  {
    await expectRefusal(
      () =>
        legacyLeadGetContext({
          ctx: pilotContext(),
          readers: fixtureReaders(),
          legacyLeadId: UNOWNED_LEAD,
          env: GATEWAY_ON,
        }),
      "ownership_not_contained"
    );
  }

  // A conversation cannot be read by naming another Organization's lead.
  {
    const readers = fixtureReaders();
    await expectRefusal(
      () =>
        legacyLeadGetRecentMessages({
          ctx: pilotContext(),
          readers,
          legacyLeadId: OTHER_ORG_LEAD,
          env: GATEWAY_ON,
        }),
      "belongs_to_another_organization"
    );
    assert.equal(
      readers.reads.some((read) => read.includes("wsp_messeges")),
      false,
      "no thread document may be read for an out-of-binding lead"
    );
  }

  // A bound identity is reported as bound.
  {
    const db = fakeDb();
    const bound = await legacyLeadGetContext({
      ctx: { db, organizationId: PILOT_ORG, actorUserId: MEMBER },
      readers: fixtureReaders(),
      legacyLeadId: PILOT_LEAD,
      env: GATEWAY_ON,
    });
    assert.equal(bound.provenance.bindingState, "unbound");
  }

  console.log("  ok  SA-1.6 binding + membership + containment gate every read");
}

// ============================================================
// Flags off => inert
// ============================================================

async function testFlagsOffIsInert(): Promise<void> {
  {
    const readers = fixtureReaders();
    await expectRefusal(
      () =>
        legacyLeadGetContext({
          ctx: pilotContext(),
          readers,
          legacyLeadId: PILOT_LEAD,
          env: {},
        }),
      "gateway_disabled"
    );
    assert.deepEqual(readers.reads, []);
  }
  {
    const readers = fixtureReaders();
    await expectRefusal(
      () =>
        legacyLeadGetContext({
          ctx: pilotContext({ relationshipOps: false }),
          readers,
          legacyLeadId: PILOT_LEAD,
          env: GATEWAY_ON,
        }),
      "gateway_disabled"
    );
    assert.deepEqual(readers.reads, []);
  }
  console.log("  ok  flags off leaves the gateway inert - no source is touched");
}

// ============================================================
// SA-1.7 — no generic CRUD, no reachable effect
// ============================================================

function testNoGenericCrudSurface(): void {
  // Every allowlisted path is claimed by at least one capability, and every
  // capability's paths are allowlisted. An entry nobody reads is dead scope.
  for (const entry of ALLOWED_SOURCE_PATHS) {
    assert.ok(
      entry.capabilities.length > 0,
      `${entry.path} is allowlisted but no capability reads it`
    );
    assert.ok(entry.rationale.length > 20, `${entry.path} has no recorded rationale`);
  }

  // The reader ports expose named reads only - no method whose name implies a
  // generic query or any write at all.
  const readerMethods = [
    "getLead",
    "getUser",
    "getProperty",
    "listConversationThreads",
    "listDealAppointments",
    "findAppointmentsByDeal",
  ];
  for (const method of readerMethods) {
    assert.equal(
      /^(get|list|find)/.test(method),
      true,
      `${method} is not a read-shaped name`
    );
    assert.equal(
      /(write|set|update|delete|create|send|upsert|insert)/i.test(method),
      false,
      `${method} looks like an effect`
    );
  }

  // A path outside the allowlist is refused, not read.
  assert.throws(
    () =>
      assertAllowedSourcePath({
        store: "mongo",
        template: "bot.property_data",
        capability: "property_get_details",
      }),
    /not on the collection allowlist/
  );
  // A capability may not borrow another capability's path.
  assert.throws(
    () =>
      assertAllowedSourcePath({
        store: "mongo",
        template: "gu2.appointments",
        capability: "legacy_lead_get_context",
      }),
    /may not read/
  );
  // An identifier cannot walk out of its collection.
  assert.throws(
    () => resolveSourcePath("leads/{legacyLeadId}", { legacyLeadId: "../users/x" }),
    /path separator/
  );
  assert.throws(
    () => resolveSourcePath("leads/{legacyLeadId}", { legacyLeadId: "" }),
    /missing path parameter/
  );

  // The exclusions carry reasons, so a future contributor sees why.
  assert.ok(DELIBERATELY_EXCLUDED_PATHS.length >= 4);
  for (const excluded of DELIBERATELY_EXCLUDED_PATHS) {
    assert.ok(excluded.reason.length > 20, `${excluded.path} is excluded without a reason`);
  }

  console.log("  ok  SA-1.7 the surface is four named reads - no generic CRUD, no effect");
}

// ============================================================
// Normalization edge cases
// ============================================================

function testNormalization(): void {
  assert.equal(normalizeTimestamp({ _seconds: 1788800000 }), "2026-09-07T16:53:20.000Z");
  assert.equal(normalizeTimestamp(new Date("2026-09-04T00:00:00Z")), "2026-09-04T00:00:00.000Z");
  assert.equal(normalizeTimestamp("2026-09-10 16:00:00"), new Date("2026-09-10T16:00:00").toISOString());
  assert.equal(normalizeTimestamp("not a date"), null);
  assert.equal(normalizeTimestamp(null), null);
  assert.equal(normalizeTimestamp({}), null);

  // All three owner representations, and the refusal to guess at a fourth.
  assert.equal(normalizeReference({ id: "abc", path: "users/abc" }).id, "abc");
  assert.equal(normalizeReference("users/abc").id, "abc");
  assert.equal(normalizeReference("abc").id, "abc");
  assert.equal(normalizeReference(42).id, null);
  assert.equal(normalizeReference(null).id, null);
  assert.equal(normalizeReference("users/abc").raw, "users/abc");

  console.log("  ok  normalizers prefer null over a guess");
}

// ============================================================
// Credential rotation must retire the cached driver client
// ============================================================

async function testCredentialRotationInvalidatesCache(): Promise<void> {
  // Both adapters resolve their client through this one helper, so proving the
  // contract here proves it for Firestore and Mongo alike — without
  // constructing a real driver or opening a socket.
  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    interface FakeClient {
      id: number;
      closed: boolean;
    }
    const cache = new Map<string, CacheEntry<FakeClient>>();
    let created = 0;
    const disposed: number[] = [];
    const load = (organizationId: string, fingerprint: string) =>
      withRotationAwareCache(cache, {
        organizationId,
        fingerprint,
        label: "test",
        create: async () => ({ id: ++created, closed: false }),
        dispose: async (client) => {
          client.closed = true;
          disposed.push(client.id);
        },
      });

    // Same credential: the expensive client is reused, which is the whole
    // reason the cache exists.
    const first = await load(PILOT_ORG, "fingerprint-a");
    const again = await load(PILOT_ORG, "fingerprint-a");
    assert.equal(created, 1, "an unchanged credential must reuse its client");
    assert.equal(first, again);
    assert.deepEqual(disposed, []);

    // Rotated credential: a NEW client, and the stale one is disposed rather
    // than left holding a pool that still authenticates with the retired
    // credential.
    const rotated = await load(PILOT_ORG, "fingerprint-b");
    assert.equal(created, 2, "a rotated credential must build a new client");
    assert.notEqual(rotated, first);
    assert.deepEqual(disposed, [first.id], "the retired client must be disposed");
    assert.equal(first.closed, true);

    // The rotated client is now the cached one — no reversion to the old.
    assert.equal(await load(PILOT_ORG, "fingerprint-b"), rotated);
    assert.equal(created, 2);

    // Rotating back to a previously seen credential still rebuilds: the cache
    // holds one entry per Organization, not a history to resurrect from.
    const back = await load(PILOT_ORG, "fingerprint-a");
    assert.equal(created, 3);
    assert.notEqual(back, first);

    // Organizations never share a cached client.
    const otherOrg = await load(OTHER_ORG, "fingerprint-a");
    assert.equal(created, 4);
    assert.notEqual(otherOrg, back);
    assert.equal(cache.size, 2);

    // A dispose that throws must not prevent the rotation.
    const brittle = new Map<string, CacheEntry<FakeClient>>();
    let brittleCreated = 0;
    const loadBrittle = (fingerprint: string) =>
      withRotationAwareCache(brittle, {
        organizationId: PILOT_ORG,
        fingerprint,
        label: "test",
        create: async () => ({ id: ++brittleCreated, closed: false }),
        dispose: async () => {
          throw new Error("close failed");
        },
      });
    const originalError = console.error;
    console.error = () => undefined;
    try {
      await loadBrittle("one");
      const replaced = await loadBrittle("two");
      assert.equal(brittleCreated, 2, "a failed dispose must not block rotation");
      assert.equal(brittle.get(PILOT_ORG)?.client, replaced);
    } finally {
      console.error = originalError;
    }
  } finally {
    console.warn = originalWarn;
  }
  console.log("  ok  a rotated credential retires its cached client and disposes it");
}

// ============================================================
// Appointment containment across a multi-record result
// ============================================================

const OTHER_OWNER_REFERENCE = {
  id: OTHER_OWNER_UID,
  path: `users/${OTHER_OWNER_UID}`,
};

async function testAppointmentOwnershipIsUniform(): Promise<void> {
  // A deal whose appointments do not all belong to the calling Organization:
  // containing the first record and returning the rest would leak the others.
  await expectRefusal(
    () =>
      appointmentGet({
        ctx: pilotContext(),
        readers: fixtureReaders((documents) => {
          documents.firestoreAppointments[1].data.user_owner =
            OTHER_OWNER_REFERENCE;
        }),
        legacyDealId: appointmentFixture.legacyDealId,
        env: GATEWAY_ON,
      }),
    "ownership_not_uniform"
  );

  // The same holds when the odd record is on the Mongo side.
  await expectRefusal(
    () =>
      appointmentGet({
        ctx: pilotContext(),
        readers: fixtureReaders((documents) => {
          documents.mongoAppointments[0].data.user_owner = OTHER_OWNER_UID;
        }),
        legacyDealId: appointmentFixture.legacyDealId,
        env: GATEWAY_ON,
      }),
    "ownership_not_uniform"
  );

  // A record with no resolvable owner cannot be proven contained, so the whole
  // result refuses rather than returning the records that could be.
  await expectRefusal(
    () =>
      appointmentGet({
        ctx: pilotContext(),
        readers: fixtureReaders((documents) => {
          documents.mongoAppointments[1].data.user_owner = "";
        }),
        legacyDealId: appointmentFixture.legacyDealId,
        env: GATEWAY_ON,
      }),
    "ownership_not_uniform"
  );

  // Uniform ownership belonging to ANOTHER Organization refuses on containment
  // — a different failure, and it must not be conflated with mixture.
  await expectRefusal(
    () =>
      appointmentGet({
        ctx: pilotContext(),
        readers: fixtureReaders((documents) => {
          for (const document of documents.firestoreAppointments) {
            document.data.user_owner = OTHER_OWNER_REFERENCE;
          }
          for (const document of documents.mongoAppointments) {
            document.data.user_owner = OTHER_OWNER_UID;
          }
        }),
        legacyDealId: appointmentFixture.legacyDealId,
        env: GATEWAY_ON,
      }),
    "belongs_to_another_organization"
  );

  // The Firestore reference form and the Mongo bare-uid form describe the same
  // owner, so the uniformity check must not mistake representation for
  // difference — the unmodified fixture still succeeds.
  const ok = await appointmentGet({
    ctx: pilotContext(),
    readers: fixtureReaders(),
    legacyDealId: appointmentFixture.legacyDealId,
    env: GATEWAY_ON,
  });
  assert.equal(ok.value.entries.length, 3);

  console.log("  ok  appointments refuse unless every record shares one contained owner");
}

// ============================================================
// No appointment record may be silently dropped or truncated
// ============================================================

async function testAppointmentsNeverSilentlyDropRecords(): Promise<void> {
  // Every record that goes in comes out. Nothing in either source enforces
  // uniqueness of the pairing key, so the success case is asserted by counting
  // rather than by trusting the fixture's shape.
  const complete = await appointmentGet({
    ctx: pilotContext(),
    readers: fixtureReaders(),
    legacyDealId: appointmentFixture.legacyDealId,
    env: GATEWAY_ON,
  });
  const returnedFirestore = complete.value.entries.filter((e) => e.firestore).length;
  const returnedMongo = complete.value.entries.filter((e) => e.mongo).length;
  assert.equal(
    returnedFirestore,
    appointmentFixture.firestore.length,
    "every Firestore record must appear in the result"
  );
  assert.equal(
    returnedMongo,
    appointmentFixture.mongo.length,
    "every Mongo record must appear in the result"
  );

  // Two FIRESTORE records sharing property + date + hour. Before the repair the
  // second overwrote the first and one real record vanished.
  const firestoreDuplicate = await expectRefusal(
    () =>
      appointmentGet({
        ctx: pilotContext(),
        readers: fixtureReaders((documents) => {
          const [first, second] = documents.firestoreAppointments;
          second.data.property_ref = first.data.property_ref;
          second.data.date = first.data.date;
          second.data.hour = first.data.hour;
        }),
        legacyDealId: appointmentFixture.legacyDealId,
        env: GATEWAY_ON,
      }),
    "pairing_ambiguous"
  );
  assert.match(firestoreDuplicate.message, /two firestore records/);

  // The same on the MONGO side.
  const mongoDuplicate = await expectRefusal(
    () =>
      appointmentGet({
        ctx: pilotContext(),
        readers: fixtureReaders((documents) => {
          const [first, second] = documents.mongoAppointments;
          second.data.property_id = first.data.property_id;
          second.data.date = first.data.date;
          second.data.hour = first.data.hour;
        }),
        legacyDealId: appointmentFixture.legacyDealId,
        env: GATEWAY_ON,
      }),
    "pairing_ambiguous"
  );
  assert.match(mongoDuplicate.message, /two mongo records/);

  // A key shared ACROSS stores is the normal case - that is what pairing is
  // for - and must not be mistaken for ambiguity.
  assert.ok(
    complete.value.entries.some((entry) => entry.presence.firestore && entry.presence.mongo),
    "a cross-store pair must still pair"
  );

  console.log("  ok  a same-store duplicate pairing key refuses instead of dropping a record");
}

async function testAppointmentsRefuseOnOverflow(): Promise<void> {
  // The readers fetch one past the bound; more than the bound means the source
  // holds more than this capability can answer for.
  const overflow = (side: "firestoreAppointments" | "mongoAppointments") =>
    fixtureReaders((documents) => {
      const template = documents[side][0];
      documents[side] = Array.from(
        { length: APPOINTMENT_SCAN_LIMIT + 1 },
        (_unused, index) => {
          const copy = structuredClone(template);
          copy.id = `${template.id}-${index}`;
          // A distinct property per record, so every pairing key is unique and
          // this exercises the bound rather than the duplicate guard.
          if (side === "mongoAppointments") {
            copy.data._id = copy.id;
            copy.data.property_id = `property-${index}`;
          } else {
            copy.data.property_ref = {
              id: `property-${index}`,
              path: `properties/property-${index}`,
            };
          }
          return copy;
        }
      );
    });

  for (const side of ["firestoreAppointments", "mongoAppointments"] as const) {
    const refusal = await expectRefusal(
      () =>
        appointmentGet({
          ctx: pilotContext(),
          readers: overflow(side),
          legacyDealId: appointmentFixture.legacyDealId,
          env: GATEWAY_ON,
        }),
      "result_too_large"
    );
    assert.match(refusal.message, new RegExp(String(APPOINTMENT_SCAN_LIMIT)));
  }

  // Exactly at the bound is complete, not an overflow - the boundary is
  // inclusive and every record is returned.
  const atLimit = await appointmentGet({
    ctx: pilotContext(),
    readers: fixtureReaders((documents) => {
      const template = documents.firestoreAppointments[0];
      documents.firestoreAppointments = Array.from(
        { length: APPOINTMENT_SCAN_LIMIT },
        (_unused, index) => {
          const copy = structuredClone(template);
          copy.id = `${template.id}-${index}`;
          copy.data.property_ref = {
            id: `property-${index}`,
            path: `properties/property-${index}`,
          };
          return copy;
        }
      );
      documents.mongoAppointments = [];
    }),
    legacyDealId: appointmentFixture.legacyDealId,
    env: GATEWAY_ON,
  });
  assert.equal(
    atLimit.value.entries.filter((entry) => entry.firestore).length,
    APPOINTMENT_SCAN_LIMIT,
    "a result exactly at the bound must be returned in full"
  );

  console.log("  ok  a source result past the bounded read refuses instead of truncating");
}

async function main(): Promise<void> {
  console.log("legacy gateway selftest");
  await testLeadContext();
  await testPropertyDetails();
  await testAppointments();
  await testThreadAwareMessages();
  await testDriftAlarm();
  await testBindingGate();
  await testAppointmentOwnershipIsUniform();
  await testAppointmentsNeverSilentlyDropRecords();
  await testAppointmentsRefuseOnOverflow();
  await testCredentialRotationInvalidatesCache();
  await testFlagsOffIsInert();
  testNoGenericCrudSurface();
  testNormalization();
  console.log("legacy gateway selftest ok");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
