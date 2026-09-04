/**
 * Recorded source contracts for the four SL-1 capabilities (TD-5).
 *
 * These are not guesses from documentation. Every field name, kind and
 * required/optional decision below was taken first-hand from the live
 * Traditional Gu stores on 2026-09-04, through the read identities issued for
 * this Slice, with the sample sizes recorded per contract.
 *
 * How `required` was decided, because it is the whole difference between a
 * useful alarm and one operators learn to ignore:
 *
 *   * a field is **required** only where the observed sample had it on
 *     **every** document AND the normalizer depends on it. Its absence then
 *     genuinely indicates the shape moved.
 *   * a field the capability uses but that is only *usually* present (the lead
 *     `Asesor` reference at 147/150, `users.organization_id` at 112/120) is
 *     **optional**. Its absence is ordinary data variance, and the capability
 *     handles it by refusing the read on containment grounds - not by paging
 *     an operator.
 *   * every declared field is kind-checked when present. A field that changes
 *     representation - a `DocumentReference` becoming a string, `conversation`
 *     becoming an object - is exactly the drift these contracts exist to catch.
 */
import type { SourceContract } from "./drift";

/**
 * `leads/{legacyLeadId}` - sample n=150 (stage project, 2026-09-04).
 *
 * Coverage: created_time 149, phone_number 149, Asesor 147, edited_time 147,
 * etapa 142, client_type 141, source 75. Nothing reached 150/150, so nothing is
 * required: this collection genuinely carries heterogeneous documents, and
 * requiring a 98%-present field would alarm on ordinary rows.
 */
export const LEAD_CONTRACT: SourceContract = {
  id: "firestore.leads.v1",
  store: "firestore",
  path: "leads/{legacyLeadId}",
  fields: {
    Asesor: {
      kinds: ["reference"],
      required: false,
      note: "Advisor principal. The first hop of the Organization containment chain: Asesor -> users/{uid} -> organization_id. Absent on ~2% of leads, which refuses the read rather than alarming.",
    },
    created_time: { kinds: ["timestamp"], required: false },
    edited_time: {
      kinds: ["timestamp"],
      required: false,
      note: "Source-side freshness for the lead read.",
    },
    etapa: { kinds: ["string"], required: false, note: "Legacy stage label." },
    client_type: { kinds: ["string"], required: false },
    phone_number: { kinds: ["string"], required: false },
    source: { kinds: ["string"], required: false, note: "Legacy origin label - evidence, not Gu OS admission semantics." },
    assignment_type: { kinds: ["string"], required: false },
    assigned: { kinds: ["boolean"], required: false },
    new_assignment: { kinds: ["boolean"], required: false },
  },
};

/**
 * `users/{legacyUserId}` - sample n=120. Read for one purpose only: resolving a
 * record's legacy owner so containment can be checked.
 *
 * `organization_id` is a `DocumentReference` into `users` on 112/120 documents
 * and absent on the rest - the "mixed representations" the audit records at
 * 4.2, and the same normalized-vs-raw split SL-0 resolved for the Organization
 * key.
 */
export const USER_CONTRACT: SourceContract = {
  id: "firestore.users.v1",
  store: "firestore",
  path: "users/{legacyUserId}",
  fields: {
    organization_id: {
      kinds: ["reference", "string"],
      required: false,
      note: "Legacy organization/principal bridge. Normalizes to the bare owner uid, which is the `legacy_organization_key` binding SL-0 established.",
    },
    uid: { kinds: ["string"], required: false },
    email: { kinds: ["string"], required: false },
    role_user: { kinds: ["string"], required: false },
  },
};

/**
 * `leads/{legacyLeadId}/wsp_messeges/{threadId}` - sample n=100 thread
 * documents. Every one carried `conversation` as an array (including empty
 * arrays), so that field is required: if it stopped being an array, the whole
 * capability would silently return no messages.
 */
export const CONVERSATION_THREAD_CONTRACT: SourceContract = {
  id: "firestore.wsp_messeges.v1",
  store: "firestore",
  path: "leads/{legacyLeadId}/wsp_messeges",
  fields: {
    conversation: {
      kinds: ["array"],
      required: true,
      note: "100/100 thread documents. The thread's items; an empty array is normal.",
    },
  },
};

/**
 * A single conversation item - sample n=1215 items across 100 threads.
 *
 * `message` and `time` were present on every item; `author` on 1213/1215.
 * `source`, `wamid`, `delivery_status` and `delivery_error_code` are declared
 * and kind-checked but optional: the stage dataset carries none of them, while
 * the audit records them in the production conversation store (10.1, 15.7).
 * Marking them required would alarm on every stage read; omitting them entirely
 * would leave the fields that carry SA-1.3's delivery evidence unchecked.
 */
export const CONVERSATION_ITEM_CONTRACT: SourceContract = {
  id: "firestore.wsp_messeges.item.v1",
  store: "firestore",
  path: "leads/{legacyLeadId}/wsp_messeges",
  fields: {
    message: {
      kinds: ["string", "array"],
      required: true,
      note: "1215/1215. Stored as a string, and as a single-element array on some items.",
    },
    time: { kinds: ["timestamp"], required: true, note: "1215/1215." },
    author: { kinds: ["string"], required: false, note: "1213/1215." },
    source: {
      kinds: ["string"],
      required: false,
      note: "`advisor_wa` marks an advisor's own-WhatsApp item (audit 9.1/10.1).",
    },
    wamid: { kinds: ["string"], required: false },
    delivery_status: { kinds: ["string"], required: false, note: "Audit 15.7 writeback." },
    delivery_error_code: { kinds: ["string", "number"], required: false },
  },
};

/**
 * `properties/{legacyPropertyId}` - sample n=150.
 *
 * `user_owner` is the only field present on all 150, which is fitting: it is
 * the one this capability cannot work without, because it is the containment
 * path. Everything else - title, price, address - is descriptive and optional.
 */
export const PROPERTY_CONTRACT: SourceContract = {
  id: "firestore.properties.v1",
  store: "firestore",
  path: "properties/{legacyPropertyId}",
  fields: {
    user_owner: {
      kinds: ["reference", "string"],
      required: true,
      note: "150/150. A DocumentReference to users/{uid} in current inventory; part of the imported inventory stores the same thing as text. Both normalize to the bare uid.",
    },
    title: { kinds: ["string"], required: false },
    ad_status: { kinds: ["string"], required: false },
    address: { kinds: ["string"], required: false },
    price_display: { kinds: ["string"], required: false },
    prices_types: { kinds: ["array"], required: false },
    currency: { kinds: ["string"], required: false },
    currency_display: { kinds: ["string"], required: false },
    monetization_type_display: { kinds: ["string"], required: false },
    created_time: { kinds: ["timestamp"], required: false },
    updated_at: { kinds: ["timestamp"], required: false },
  },
};

/**
 * `deals/{legacyDealId}/appointments/{autoId}` - sample n=126 across 200 deals.
 *
 * Seven fields were present on all 126 and the capability depends on each:
 * status and schedule are the comparison surface, and `user_owner` is the
 * containment path. `appointment_id` is present on only 63/126 - the Firestore
 * document id is the reliable identifier, not that field.
 */
export const FIRESTORE_APPOINTMENT_CONTRACT: SourceContract = {
  id: "firestore.deal_appointments.v1",
  store: "firestore",
  path: "deals/{legacyDealId}/appointments",
  fields: {
    status: { kinds: ["string"], required: true, note: "126/126." },
    date: { kinds: ["string"], required: true, note: "126/126." },
    created_time: { kinds: ["timestamp"], required: true, note: "126/126." },
    title: { kinds: ["string"], required: true, note: "126/126." },
    lead_ref: { kinds: ["reference"], required: true, note: "126/126." },
    property_ref: { kinds: ["reference"], required: true, note: "126/126." },
    user_owner: {
      kinds: ["reference", "string"],
      required: true,
      note: "126/126. Containment path for this capability.",
    },
    hour: { kinds: ["string"], required: false, note: "70/126." },
    appointment_id: {
      kinds: ["string"],
      required: false,
      note: "63/126 - NOT the document id, and never equal to it in the observed sample.",
    },
    google_event_id: { kinds: ["string"], required: false, note: "38/126, null elsewhere. Audit 11.4 orphan-Calendar risk." },
    front_date: { kinds: ["string"], required: false },
    front_hour: { kinds: ["string"], required: false },
  },
};

/**
 * `gu2.appointments` - sample n=50, collection size ~9.4k.
 *
 * Eleven fields present on every sampled document. Post-visit evidence fields
 * (`property_was_visited`, `appointment_qualification`, `want_to_acquire`,
 * `owner_appointment_status`) appear on ~4% and are deliberately NOT declared
 * here: they are SL-8's visit-evidence contract, not SL-1's appointment read,
 * and declaring them would imply this capability interprets them.
 */
export const MONGO_APPOINTMENT_CONTRACT: SourceContract = {
  id: "mongo.gu2.appointments.v1",
  store: "mongo",
  path: "gu2.appointments",
  fields: {
    _id: { kinds: ["object", "string"], required: true, note: "50/50. ObjectId." },
    status: { kinds: ["string"], required: true, note: "50/50." },
    date: { kinds: ["string"], required: true, note: "50/50." },
    hour: { kinds: ["string"], required: true, note: "50/50." },
    created_time: { kinds: ["string"], required: true, note: "50/50. A string here, a Timestamp in Firestore." },
    deal_id: { kinds: ["string"], required: true, note: "50/50. The only key shape shared with the Firestore replica." },
    lead_id: { kinds: ["string"], required: true, note: "50/50." },
    property_id: { kinds: ["string"], required: true, note: "50/50." },
    user_owner: { kinds: ["string"], required: true, note: "50/50. Bare uid; containment path." },
    title: { kinds: ["string"], required: true, note: "50/50." },
    finished: { kinds: ["boolean"], required: true, note: "50/50." },
  },
};

export const SOURCE_CONTRACTS = {
  lead: LEAD_CONTRACT,
  user: USER_CONTRACT,
  conversationThread: CONVERSATION_THREAD_CONTRACT,
  conversationItem: CONVERSATION_ITEM_CONTRACT,
  property: PROPERTY_CONTRACT,
  firestoreAppointment: FIRESTORE_APPOINTMENT_CONTRACT,
  mongoAppointment: MONGO_APPOINTMENT_CONTRACT,
} as const;
