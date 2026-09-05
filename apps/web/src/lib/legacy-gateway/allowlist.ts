/**
 * The collection allowlist, in code (TD-5).
 *
 * Why this file exists at all: the Firestore bootstrap credential is a
 * **project-level reader**. GCP IAM has no per-collection read grant and the
 * Admin SDK bypasses security rules, so the credential can technically read
 * every collection in the project. TD-5 accepts that blast radius as
 * time-boxed and shadow-only *on condition* that Gu OS narrows it itself. This
 * module is that narrowing, and it is the only place a source path may be
 * named.
 *
 * The Mongo credential is read-only but was delivered with a database-level
 * grant on `bot` and `gu2` rather than a collection-level grant on
 * `appointments` (the human-accepted temporary deviation recorded in the R1
 * Slice Plan). The same reasoning applies with more force: the code allowlist
 * is what actually holds the line until that credential retires at C6.
 *
 * Adding an entry is a capability-surface decision. It belongs to a Slice, and
 * it must be traceable to a governing source - never to "the adapter needed it".
 */
import type { LegacyGatewayCapability, LegacySourceStore } from "@agents/types";

export interface AllowedSourcePath {
  store: LegacySourceStore;
  /**
   * Logical path with `{placeholders}`. Firestore paths are collection paths;
   * Mongo paths are `<database>.<collection>`.
   */
  path: string;
  /** Which capabilities may read it. A path with no capability is dead code. */
  capabilities: readonly LegacyGatewayCapability[];
  /** Why this path is in scope, traceable to the audit or the Slice Plan. */
  rationale: string;
}

/**
 * Current provisioning scope, revalidated 2026-09-04 before credential
 * issuance. Physical names are allowed to drift behind the capability
 * contract; when they do, the fix is here plus a fixture update, not a wider
 * credential.
 */
export const ALLOWED_SOURCE_PATHS: readonly AllowedSourcePath[] = [
  {
    store: "firestore",
    path: "leads/{legacyLeadId}",
    capabilities: ["legacy_lead_get_context"],
    rationale:
      "The Traditional Gu lead record. `lead_id` is a composite operational-context key (audit 5.1) and is used opaquely.",
  },
  {
    store: "firestore",
    path: "leads/{legacyLeadId}/wsp_messeges",
    capabilities: ["legacy_lead_get_recent_messages"],
    rationale:
      "Thread-aware conversation store: the Gu-number document plus one `asesor_<phone>` document per linked advisor (audit 10.1), carrying per-item delivery status (audit 15.7).",
  },
  {
    store: "firestore",
    path: "users/{legacyUserId}",
    capabilities: ["legacy_lead_get_context", "property_get_details"],
    rationale:
      "Owner principal resolution only. Read to normalize a record's legacy owner so the Organization containment check can run; never read for user data.",
  },
  {
    store: "firestore",
    path: "properties/{legacyPropertyId}",
    capabilities: ["property_get_details"],
    rationale:
      "Firestore is the authoritative Ungga property record; the Mongo `property_data` copy is a serving mirror and can be incomplete (audit 14.1/14.2, 18).",
  },
  {
    store: "firestore",
    path: "deals/{legacyDealId}/appointments",
    capabilities: ["appointment_get"],
    rationale:
      "The Firestore appointment replica. It is a subcollection of the deal, not a root collection - a scope correction made before credential issuance (Slice Plan 4).",
  },
  {
    store: "mongo",
    path: "gu2.appointments",
    capabilities: ["appointment_get"],
    rationale:
      "Appointment persistence is not atomic across stores (audit 11.3): a Firestore-only read would silently miss appointments that landed only in Mongo. This is the only SL-1 capability that needs Mongo at all. The database is `gu2`, the guv3 runtime database - NOT `bot`, which has no `appointments` collection. Confirmed with the Traditional Gu team on 2026-09-04 after first-hand observation; the pre-issuance scope had assumed `bot`.",
  },
] as const;

/**
 * Paths a reader might reach for and must not. Recorded as data rather than as
 * prose so the exclusions are testable, and so a future contributor sees the
 * reason next to the name.
 */
export const DELIBERATELY_EXCLUDED_PATHS: ReadonlyArray<{
  store: LegacySourceStore;
  path: string;
  reason: string;
}> = [
  {
    store: "mongo",
    path: "property_data",
    reason:
      "Serving/search mirror, not authority (audit 18). An authoritative detail read must not depend on the mirror. It also lives in a different database the delivered identity cannot reach, so the exclusion holds at the credential perimeter too.",
  },
  {
    store: "mongo",
    path: "bot.chats / gu2.chats / gu2.chat_memory",
    reason:
      "Conversation mirrors. SA-1.3's contract is `source` and `delivery_status` per item, and delivery status is written back into the Firestore conversation store (audit 15.7), whose thread model already carries the `gu` and `asesor_*` threads.",
  },
  {
    store: "mongo",
    path: "gu2.users / gu2.deals",
    reason:
      "Lead and deal runtime context (`bypass_bot`, `last_owner_interaction_wba`, assignment mirror) is a conversation-authority signal consumed by SL-6, not by an SL-1 read.",
  },
  {
    store: "firestore",
    path: "users_sellers",
    reason:
      "Dropped before issuance: SL-1 resolves Organization binding through Gu OS `external_identity_bindings`, established at SL-0, so no SL-1 read needs it.",
  },
];

/**
 * Turns a logical path template into a concrete path, substituting only the
 * placeholders the template declares.
 *
 * Values are inserted verbatim because legacy identifiers are opaque, but a
 * value carrying a path separator would let a caller walk out of the
 * allowlisted collection - so that is refused rather than escaped.
 */
export function resolveSourcePath(
  template: string,
  params: Record<string, string>
): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const value = params[key];
    if (value === undefined || value === "") {
      throw new Error(`legacy-gateway: missing path parameter "${key}" for ${template}`);
    }
    if (value.includes("/") || value.includes("..")) {
      throw new Error(
        `legacy-gateway: refusing path parameter "${key}" containing a path separator`
      );
    }
    return value;
  });
}

/**
 * The gate every adapter read passes. Returns the allowlist entry so the caller
 * cannot proceed without one, and throwing is deliberate: an unlisted path is a
 * programming error, not a runtime condition to degrade around.
 */
export function assertAllowedSourcePath(params: {
  store: LegacySourceStore;
  template: string;
  capability: LegacyGatewayCapability;
}): AllowedSourcePath {
  const entry = ALLOWED_SOURCE_PATHS.find(
    (candidate) =>
      candidate.store === params.store && candidate.path === params.template
  );
  if (!entry) {
    throw new Error(
      `legacy-gateway: ${params.store} path "${params.template}" is not on the collection allowlist`
    );
  }
  if (!entry.capabilities.includes(params.capability)) {
    throw new Error(
      `legacy-gateway: capability ${params.capability} may not read ${params.store} path "${params.template}"`
    );
  }
  return entry;
}
