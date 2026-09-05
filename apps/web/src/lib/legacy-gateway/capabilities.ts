/**
 * The four bounded read capabilities (TD-5, AC-1 6.2 Option C).
 *
 * Every one of them follows the same five steps, in this order, and the order
 * is the contract:
 *
 *   1. pre-read gate   - flags, membership, Organization source binding, and a
 *                        cross-tenant identity check (nothing has been read yet);
 *   2. read            - through the allowlisted path only;
 *   3. contract check  - shape drift raises the alarm and refuses;
 *   4. containment     - the record's legacy owner must resolve to the calling
 *                        Organization, or nothing is returned;
 *   5. normalize       - and wrap in provenance.
 *
 * There is no capability that returns a raw document, no capability that takes
 * a collection name, and no path from a capability to a write. That is what
 * "no generic CRUD tool, ever" means in code.
 */
import type {
  LegacyAppointmentPair,
  LegacyAppointmentView,
  LegacyConversationItem,
  LegacyDealAppointments,
  LegacyDeliveryStatus,
  LegacyLeadContext,
  LegacyMessageDirection,
  LegacyMessageThread,
  LegacyPropertyDetails,
  LegacyReadResult,
  LegacyRecentMessages,
} from "@agents/types";
import {
  assertOwnershipContained,
  assertPreReadGate,
  type GatewayCallerContext,
  type GatewayEnv,
} from "./authorization";
import { assertAllowedSourcePath, resolveSourcePath } from "./allowlist";
import { checkSourceContract } from "./drift";
import { LegacyReadRefusal } from "./errors";
import {
  normalizeBoolean,
  normalizeMessageBody,
  normalizeNumber,
  normalizeReference,
  normalizeString,
  normalizeTimestamp,
} from "./normalize";
import { buildFreshness, buildProvenance, withProvenance } from "./provenance";
import type { LegacySourceReaders } from "./source-clients";
import {
  CONVERSATION_ITEM_CONTRACT,
  CONVERSATION_THREAD_CONTRACT,
  FIRESTORE_APPOINTMENT_CONTRACT,
  LEAD_CONTRACT,
  MONGO_APPOINTMENT_CONTRACT,
  PROPERTY_CONTRACT,
} from "./source-contracts";

export interface CapabilityInput {
  ctx: GatewayCallerContext;
  readers: LegacySourceReaders;
  /** Injected for tests; production reads `process.env`. */
  env?: GatewayEnv;
}

const DEFAULT_MESSAGE_LIMIT = 30;
const MAX_MESSAGE_LIMIT = 200;

// ============================================================
// legacy_lead_get_context
// ============================================================

export async function legacyLeadGetContext(
  input: CapabilityInput & { legacyLeadId: string }
): Promise<LegacyReadResult<LegacyLeadContext>> {
  const capability = "legacy_lead_get_context" as const;
  const { legacyLeadId } = input;

  const gate = await assertPreReadGate({
    ctx: input.ctx,
    capability,
    externalId: legacyLeadId,
    bindingKind: "legacy_lead",
    env: input.env,
  });

  const allowed = assertAllowedSourcePath({
    store: "firestore",
    template: "leads/{legacyLeadId}",
    capability,
  });
  const sourcePath = resolveSourcePath(allowed.path, { legacyLeadId });

  const document = await input.readers.firestore.getLead(legacyLeadId);
  if (!document) {
    throw new LegacyReadRefusal("not_found", capability, legacyLeadId);
  }

  const violations = checkSourceContract({
    contract: LEAD_CONTRACT,
    document: document.data,
    capability,
    organizationId: input.ctx.organizationId,
    externalId: legacyLeadId,
  });
  if (violations.length > 0) {
    throw new LegacyReadRefusal(
      "contract_drift",
      capability,
      legacyLeadId,
      `${violations.length} contract violation(s)`
    );
  }

  const owner = await assertOwnershipContained({
    ctx: input.ctx,
    capability,
    externalId: legacyLeadId,
    ownerReference: document.data.Asesor,
    firestore: input.readers.firestore,
  });

  const readAt = new Date().toISOString();
  const value: LegacyLeadContext = {
    legacyLeadId,
    ownerLegacyUserId: owner.ownerLegacyUserId,
    ownerRawValue: owner.ownerRawValue,
    assignedAdvisorLabel: normalizeReference(document.data.Asesor).id,
    assignmentType: normalizeString(document.data.assignment_type),
    clientType: normalizeString(document.data.client_type),
    originLabel: normalizeString(document.data.source),
    status: normalizeString(document.data.etapa),
    createdAt: normalizeTimestamp(document.data.created_time),
    updatedAt: normalizeTimestamp(document.data.edited_time),
  };

  return withProvenance(
    value,
    buildProvenance({
      store: "firestore",
      sourcePath,
      externalId: legacyLeadId,
      capability,
      organizationId: input.ctx.organizationId,
      bindingState: gate.bindingState,
      freshness: buildFreshness(readAt, {
        candidates: [
          { field: "edited_time", value: document.data.edited_time },
          { field: "created_time", value: document.data.created_time },
        ],
      }),
    })
  );
}

// ============================================================
// legacy_lead_get_recent_messages
// ============================================================

function describeThread(threadId: string): LegacyMessageThread {
  // `asesor_<phone>` documents are an advisor's own-WhatsApp thread (audit
  // 9.1/10.1); every other document is the Gu-number conversation.
  if (threadId.startsWith("asesor_")) {
    return {
      kind: "advisor",
      threadId,
      advisorEndpoint: threadId.slice("asesor_".length) || null,
    };
  }
  return { kind: "gu", threadId, advisorEndpoint: null };
}

function normalizeDeliveryStatus(value: unknown): LegacyDeliveryStatus {
  const raw = normalizeString(value)?.toLowerCase();
  switch (raw) {
    case "sent":
    case "delivered":
    case "read":
    case "failed":
      return raw;
    default:
      // Includes "the source recorded nothing". Queue acceptance is not
      // delivery (audit 15.1), so absence must never read as `sent`.
      return "unknown";
  }
}

function normalizeDirection(
  author: string | null,
  source: string | null
): LegacyMessageDirection {
  if (source === "advisor_wa") return "outbound";
  switch (author?.toLowerCase()) {
    case "gu":
    case "bot":
    case "asesor":
    case "advisor":
      return "outbound";
    case "user":
    case "client":
    case "cliente":
    case "prospect":
      return "inbound";
    default:
      return "unknown";
  }
}

export async function legacyLeadGetRecentMessages(
  input: CapabilityInput & { legacyLeadId: string; limit?: number }
): Promise<LegacyReadResult<LegacyRecentMessages>> {
  const capability = "legacy_lead_get_recent_messages" as const;
  const { legacyLeadId } = input;
  const limit = Math.min(
    Math.max(1, input.limit ?? DEFAULT_MESSAGE_LIMIT),
    MAX_MESSAGE_LIMIT
  );

  const gate = await assertPreReadGate({
    ctx: input.ctx,
    capability,
    externalId: legacyLeadId,
    bindingKind: "legacy_lead",
    env: input.env,
  });

  const allowedLead = assertAllowedSourcePath({
    store: "firestore",
    template: "leads/{legacyLeadId}",
    capability: "legacy_lead_get_context",
  });
  const allowedThreads = assertAllowedSourcePath({
    store: "firestore",
    template: "leads/{legacyLeadId}/wsp_messeges",
    capability,
  });
  const sourcePath = resolveSourcePath(allowedThreads.path, { legacyLeadId });

  // Containment for a thread is inherited from its lead, so the lead is read
  // and contained first. A caller must not be able to read a conversation by
  // naming a lead id whose owner is another Organization.
  const lead = await input.readers.firestore.getLead(legacyLeadId);
  if (!lead) {
    throw new LegacyReadRefusal("not_found", capability, legacyLeadId);
  }
  void resolveSourcePath(allowedLead.path, { legacyLeadId });
  await assertOwnershipContained({
    ctx: input.ctx,
    capability,
    externalId: legacyLeadId,
    ownerReference: lead.data.Asesor,
    firestore: input.readers.firestore,
  });

  const threadDocuments =
    await input.readers.firestore.listConversationThreads(legacyLeadId);

  const threads: LegacyMessageThread[] = [];
  const collected: Array<{ item: LegacyConversationItem; sortKey: number }> = [];

  for (const document of threadDocuments) {
    const violations = checkSourceContract({
      contract: CONVERSATION_THREAD_CONTRACT,
      document: document.data,
      capability,
      organizationId: input.ctx.organizationId,
      externalId: legacyLeadId,
    });
    if (violations.length > 0) {
      throw new LegacyReadRefusal(
        "contract_drift",
        capability,
        legacyLeadId,
        `thread ${document.id}: ${violations.length} contract violation(s)`
      );
    }
    const thread = describeThread(document.id);
    threads.push(thread);

    const conversation = document.data.conversation as unknown[];
    for (const raw of conversation) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const entry = raw as Record<string, unknown>;
      const itemViolations = checkSourceContract({
        contract: CONVERSATION_ITEM_CONTRACT,
        document: entry,
        capability,
        organizationId: input.ctx.organizationId,
        externalId: legacyLeadId,
      });
      if (itemViolations.length > 0) {
        throw new LegacyReadRefusal(
          "contract_drift",
          capability,
          legacyLeadId,
          `thread ${document.id} item: ${itemViolations.length} contract violation(s)`
        );
      }
      const timestamp = normalizeTimestamp(entry.time);
      const author = normalizeString(entry.author);
      const source = normalizeString(entry.source);
      collected.push({
        sortKey: timestamp ? Date.parse(timestamp) : 0,
        item: {
          thread,
          wamid: normalizeString(entry.wamid),
          direction: normalizeDirection(author, source),
          source,
          authorLabel: author,
          text: normalizeMessageBody(entry.message),
          timestamp,
          deliveryStatus: normalizeDeliveryStatus(entry.delivery_status),
          deliveryErrorCode: normalizeString(entry.delivery_error_code),
        },
      });
    }
  }

  collected.sort((a, b) => a.sortKey - b.sortKey);
  const truncated = collected.length > limit;
  const items = collected.slice(-limit).map((entry) => entry.item);

  const readAt = new Date().toISOString();
  const newest = items.length > 0 ? items[items.length - 1].timestamp : null;

  return withProvenance(
    {
      legacyLeadId,
      threads,
      items,
      truncated,
    } satisfies LegacyRecentMessages,
    buildProvenance({
      store: "firestore",
      sourcePath,
      externalId: legacyLeadId,
      capability,
      organizationId: input.ctx.organizationId,
      bindingState: gate.bindingState,
      freshness: buildFreshness(readAt, {
        candidates: [
          { field: "conversation[last].time", value: newest },
          { field: "leads.edited_time", value: lead.data.edited_time },
        ],
      }),
    })
  );
}

// ============================================================
// appointment_get
// ============================================================

function pairingKey(view: LegacyAppointmentView): string {
  return [
    view.legacyPropertyId ?? "-",
    view.rawDate ?? "-",
    view.rawHour ?? "-",
  ].join("|");
}

function firestoreAppointmentView(
  legacyDealId: string,
  document: { id: string; data: Record<string, unknown> }
): LegacyAppointmentView {
  const date = normalizeString(document.data.date);
  const hour = normalizeString(document.data.hour);
  return {
    legacyAppointmentId: document.id,
    store: "firestore",
    legacyDealId,
    legacyLeadId: normalizeReference(document.data.lead_ref).id,
    legacyPropertyId: normalizeReference(document.data.property_ref).id,
    status: normalizeString(document.data.status),
    scheduledAt: normalizeTimestamp(date && hour && date.length <= 10 ? `${date} ${hour}` : date),
    rawDate: date,
    rawHour: hour,
    createdAt: normalizeTimestamp(document.data.created_time),
    finished: normalizeBoolean(document.data.finished),
    googleEventId: normalizeString(document.data.google_event_id),
  };
}

function mongoAppointmentView(
  document: { id: string; data: Record<string, unknown> }
): LegacyAppointmentView {
  const date = normalizeString(document.data.date);
  const hour = normalizeString(document.data.hour);
  return {
    legacyAppointmentId: document.id,
    store: "mongo",
    legacyDealId: normalizeString(document.data.deal_id),
    legacyLeadId: normalizeString(document.data.lead_id),
    legacyPropertyId: normalizeString(document.data.property_id),
    status: normalizeString(document.data.status),
    scheduledAt: normalizeTimestamp(date && hour && date.length <= 10 ? `${date} ${hour}` : date),
    rawDate: date,
    rawHour: hour,
    createdAt: normalizeTimestamp(document.data.created_time),
    finished: normalizeBoolean(document.data.finished),
    googleEventId: null,
  };
}

function comparePair(
  firestore: LegacyAppointmentView | null,
  mongo: LegacyAppointmentView | null
): { storesDisagree: boolean; disagreements: string[] } {
  if (!firestore && !mongo) return { storesDisagree: false, disagreements: [] };
  if (!firestore) {
    return {
      storesDisagree: false,
      disagreements: ["present only in mongo (audit 11.3 partial persistence)"],
    };
  }
  if (!mongo) {
    return {
      storesDisagree: false,
      disagreements: [
        "present only in firestore (audit 11.3 partial persistence)",
      ],
    };
  }
  const disagreements: string[] = [];
  if (firestore.status !== mongo.status) {
    disagreements.push(`status: firestore=${firestore.status} mongo=${mongo.status}`);
  }
  if (firestore.scheduledAt !== mongo.scheduledAt) {
    disagreements.push(
      `scheduledAt: firestore=${firestore.scheduledAt} mongo=${mongo.scheduledAt}`
    );
  }
  if (firestore.legacyLeadId !== mongo.legacyLeadId) {
    disagreements.push("legacyLeadId differs between stores");
  }
  return { storesDisagree: disagreements.length > 0, disagreements };
}

/**
 * Reads a deal's appointments from both stores.
 *
 * Keyed on the deal rather than on an appointment because the deal id is the
 * only identifier the two stores share - established first-hand, not assumed.
 * A single appointment is selected with `legacyAppointmentId`, which matches
 * whichever store holds that id.
 */
export async function appointmentGet(
  input: CapabilityInput & { legacyDealId: string; legacyAppointmentId?: string }
): Promise<LegacyReadResult<LegacyDealAppointments>> {
  const capability = "appointment_get" as const;
  const { legacyDealId } = input;

  const gate = await assertPreReadGate({
    ctx: input.ctx,
    capability,
    externalId: legacyDealId,
    // Gu OS binds no deal identity today, so containment - not a binding - is
    // what proves this deal belongs to the calling Organization.
    bindingKind: null,
    env: input.env,
  });

  const allowedFirestore = assertAllowedSourcePath({
    store: "firestore",
    template: "deals/{legacyDealId}/appointments",
    capability,
  });
  const sourcePath = resolveSourcePath(allowedFirestore.path, { legacyDealId });

  const firestoreDocuments =
    await input.readers.firestore.listDealAppointments(legacyDealId);

  let mongoDocuments: Array<{ id: string; data: Record<string, unknown> }> = [];
  const mongoConsulted = input.readers.mongo !== null;
  if (input.readers.mongo) {
    assertAllowedSourcePath({
      store: "mongo",
      template: "gu2.appointments",
      capability,
    });
    mongoDocuments = await input.readers.mongo.findAppointmentsByDeal(legacyDealId);
  }

  if (firestoreDocuments.length === 0 && mongoDocuments.length === 0) {
    throw new LegacyReadRefusal("not_found", capability, legacyDealId);
  }

  // Contract-check both stores before anything is normalized or compared.
  for (const document of firestoreDocuments) {
    const violations = checkSourceContract({
      contract: FIRESTORE_APPOINTMENT_CONTRACT,
      document: document.data,
      capability,
      organizationId: input.ctx.organizationId,
      externalId: legacyDealId,
    });
    if (violations.length > 0) {
      throw new LegacyReadRefusal(
        "contract_drift",
        capability,
        legacyDealId,
        `firestore appointment ${document.id}: ${violations.length} contract violation(s)`
      );
    }
  }
  for (const document of mongoDocuments) {
    const violations = checkSourceContract({
      contract: MONGO_APPOINTMENT_CONTRACT,
      document: document.data,
      capability,
      organizationId: input.ctx.organizationId,
      externalId: legacyDealId,
    });
    if (violations.length > 0) {
      throw new LegacyReadRefusal(
        "contract_drift",
        capability,
        legacyDealId,
        `mongo appointment ${document.id}: ${violations.length} contract violation(s)`
      );
    }
  }

  // Containment for a MULTI-RECORD result.
  //
  // This capability returns every appointment on a deal, so containing the
  // first record and returning the rest would leak another Organization's rows
  // the moment a deal ever carried mixed ownership. Nothing in the source
  // guarantees it cannot: `user_owner` is a per-record field, not a property of
  // the deal. So the contract is stronger and stated as a proof obligation -
  // **every returned record must carry one identical, resolvable owner, and
  // that owner must contain to the calling Organization**, or nothing is
  // returned at all.
  const ownerReferences = [...firestoreDocuments, ...mongoDocuments].map(
    (document) => document.data.user_owner
  );
  const ownerIds = new Set<string>();
  for (const reference of ownerReferences) {
    const normalized = normalizeReference(reference);
    if (!normalized.id) {
      // A record whose owner cannot be established cannot be proven contained,
      // and a partial answer is not an option here.
      throw new LegacyReadRefusal(
        "ownership_not_uniform",
        capability,
        legacyDealId,
        "an appointment record carries no resolvable owner"
      );
    }
    ownerIds.add(normalized.id);
  }
  if (ownerIds.size !== 1) {
    throw new LegacyReadRefusal(
      "ownership_not_uniform",
      capability,
      legacyDealId,
      `appointment records carry ${ownerIds.size} distinct owners`
    );
  }
  await assertOwnershipContained({
    ctx: input.ctx,
    capability,
    externalId: legacyDealId,
    ownerReference: ownerReferences[0],
    firestore: input.readers.firestore,
  });

  const firestoreViews = firestoreDocuments.map((document) =>
    firestoreAppointmentView(legacyDealId, document)
  );
  const mongoViews = mongoDocuments.map(mongoAppointmentView);

  const byKey = new Map<string, LegacyAppointmentPair>();
  const ensure = (key: string): LegacyAppointmentPair => {
    const existing = byKey.get(key);
    if (existing) return existing;
    const created: LegacyAppointmentPair = {
      key,
      firestore: null,
      mongo: null,
      presence: { firestore: false, mongo: false },
      storesDisagree: false,
      disagreements: [],
    };
    byKey.set(key, created);
    return created;
  };
  for (const view of firestoreViews) {
    const pair = ensure(pairingKey(view));
    pair.firestore = view;
    pair.presence.firestore = true;
  }
  for (const view of mongoViews) {
    const pair = ensure(pairingKey(view));
    pair.mongo = view;
    pair.presence.mongo = true;
  }
  for (const pair of byKey.values()) {
    const compared = comparePair(pair.firestore, pair.mongo);
    pair.storesDisagree = compared.storesDisagree;
    pair.disagreements = compared.disagreements;
  }

  let entries = [...byKey.values()];
  if (input.legacyAppointmentId) {
    entries = entries.filter(
      (pair) =>
        pair.firestore?.legacyAppointmentId === input.legacyAppointmentId ||
        pair.mongo?.legacyAppointmentId === input.legacyAppointmentId
    );
    if (entries.length === 0) {
      throw new LegacyReadRefusal(
        "not_found",
        capability,
        input.legacyAppointmentId
      );
    }
  }

  const readAt = new Date().toISOString();
  const newestCreatedAt = entries
    .flatMap((pair) => [pair.firestore?.createdAt, pair.mongo?.createdAt])
    .filter((value): value is string => Boolean(value))
    .sort()
    .pop() ?? null;

  return withProvenance(
    {
      legacyDealId,
      storesConsulted: { firestore: true, mongo: mongoConsulted },
      entries,
    } satisfies LegacyDealAppointments,
    buildProvenance({
      store: "firestore",
      sourcePath,
      externalId: legacyDealId,
      capability,
      organizationId: input.ctx.organizationId,
      bindingState: gate.bindingState,
      freshness: buildFreshness(readAt, {
        candidates: [{ field: "appointments.created_time", value: newestCreatedAt }],
      }),
    })
  );
}

// ============================================================
// property_get_details
// ============================================================

function firstNumber(value: unknown): number | null {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const parsed = normalizeNumber(entry);
      if (parsed !== null) return parsed;
    }
    return null;
  }
  return normalizeNumber(value);
}

export async function propertyGetDetails(
  input: CapabilityInput & { legacyPropertyId: string }
): Promise<LegacyReadResult<LegacyPropertyDetails>> {
  const capability = "property_get_details" as const;
  const { legacyPropertyId } = input;

  const gate = await assertPreReadGate({
    ctx: input.ctx,
    capability,
    externalId: legacyPropertyId,
    bindingKind: null,
    env: input.env,
  });

  const allowed = assertAllowedSourcePath({
    store: "firestore",
    template: "properties/{legacyPropertyId}",
    capability,
  });
  const sourcePath = resolveSourcePath(allowed.path, { legacyPropertyId });

  const document = await input.readers.firestore.getProperty(legacyPropertyId);
  if (!document) {
    throw new LegacyReadRefusal("not_found", capability, legacyPropertyId);
  }

  const violations = checkSourceContract({
    contract: PROPERTY_CONTRACT,
    document: document.data,
    capability,
    organizationId: input.ctx.organizationId,
    externalId: legacyPropertyId,
  });
  if (violations.length > 0) {
    throw new LegacyReadRefusal(
      "contract_drift",
      capability,
      legacyPropertyId,
      `${violations.length} contract violation(s)`
    );
  }

  const owner = await assertOwnershipContained({
    ctx: input.ctx,
    capability,
    externalId: legacyPropertyId,
    ownerReference: document.data.user_owner,
    firestore: input.readers.firestore,
  });

  const readAt = new Date().toISOString();
  const value: LegacyPropertyDetails = {
    legacyPropertyId,
    title: normalizeString(document.data.title),
    ownerLegacyUserId: owner.ownerLegacyUserId,
    ownerRawValue: owner.ownerRawValue,
    operationType: normalizeString(document.data.monetization_type_display),
    status: normalizeString(document.data.ad_status),
    price: firstNumber(document.data.prices_types ?? document.data.price_display),
    currency: normalizeString(
      document.data.currency ?? document.data.currency_display
    ),
    addressLabel: normalizeString(document.data.address),
    createdAt: normalizeTimestamp(document.data.created_time),
    updatedAt: normalizeTimestamp(document.data.updated_at),
  };

  return withProvenance(
    value,
    buildProvenance({
      store: "firestore",
      sourcePath,
      externalId: legacyPropertyId,
      capability,
      organizationId: input.ctx.organizationId,
      bindingState: gate.bindingState,
      freshness: buildFreshness(readAt, {
        candidates: [
          { field: "updated_at", value: document.data.updated_at },
          { field: "created_time", value: document.data.created_time },
        ],
      }),
    })
  );
}
