import type {
  Organization,
  OrganizationMembership,
  OrganizationRole,
} from "@agents/types";
import type { DbClient } from "../client";

/**
 * Organizations, memberships and the single write-authorization helper
 * (ADR-106 / Technical Plan TD-1, SL-0).
 *
 * Authorization rules this module exists to enforce:
 *   * every Organization-owned write is server-authorized — user JWTs have no
 *     direct write path to Organization business tables in R1 (the database
 *     enforces the same thing, this is the application half);
 *   * identity is not authorization: `authorizeOrgAction` always re-checks
 *     `status = "active"` at action time, and callers persist the returned
 *     actor + role on consequential decisions;
 *   * fail closed: a missing, inactive or unreadable membership never widens
 *     authority.
 */

// ============================================================
// Organizations
// ============================================================

export async function getOrganizationById(
  db: DbClient,
  organizationId: string
): Promise<Organization | null> {
  const { data, error } = await db
    .from("organizations")
    .select("*")
    .eq("id", organizationId)
    .maybeSingle();
  if (error) throw error;
  return (data as Organization) ?? null;
}

/**
 * Idempotent resolve-or-create of an Organization from its legacy identity.
 *
 * Two distinct strings, deliberately separate parameters:
 *   * `legacyOrganizationKey` — the NORMALIZED identity (the bare owner UID).
 *     This is the external routing key and the only thing resolution matches on.
 *   * `rawLegacySource` — the raw representation it was normalized from (e.g.
 *     `users/<uid>`), recorded as provenance in the same statement. It explains
 *     where the key came from; nothing ever routes on it.
 *
 * Inbound WhatsApp routing is a different external identity and binds as
 * `gu_whatsapp_number` — never through this function.
 *
 * Delegates to the SQL function rather than doing select-then-insert here:
 * supabase-js has no transaction API, so only the database can create the
 * Organization, its binding and that provenance atomically. A crash leaves
 * either nothing or a complete record. Re-runs and concurrent runs converge.
 *
 * Creates NO membership. The profile a legacy identity was discovered on does
 * not become a member as a side effect — membership is supplied explicitly,
 * with an explicit role, via `ensureOrganizationMembership`.
 *
 * Service-role only — the function's EXECUTE privilege is restricted.
 */
export async function bootstrapOrganizationFromLegacyKey(
  db: DbClient,
  params: {
    legacyOrganizationKey: string;
    rawLegacySource?: string | null;
    organizationName?: string | null;
  }
): Promise<string> {
  const legacyOrganizationKey = params.legacyOrganizationKey?.trim();
  if (!legacyOrganizationKey) {
    throw new Error(
      "bootstrapOrganizationFromLegacyKey: legacyOrganizationKey is required " +
        "(normalized bare owner UID, not the raw users/<uid> path)"
    );
  }
  const { data, error } = await db.rpc("bootstrap_organization", {
    p_legacy_organization_key: legacyOrganizationKey,
    p_raw_legacy_source: params.rawLegacySource?.trim() || null,
    p_org_name: params.organizationName?.trim() || null,
  });
  if (error) throw error;
  return data as string;
}

// ============================================================
// Memberships
// ============================================================

export async function getActiveMembership(
  db: DbClient,
  organizationId: string,
  userId: string
): Promise<OrganizationMembership | null> {
  const { data, error } = await db
    .from("organization_memberships")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();
  if (error) throw error;
  return (data as OrganizationMembership) ?? null;
}

export async function listOrganizationMemberships(
  db: DbClient,
  organizationId: string,
  options?: { includeInactive?: boolean }
): Promise<OrganizationMembership[]> {
  let query = db
    .from("organization_memberships")
    .select("*")
    .eq("organization_id", organizationId);
  if (!options?.includeInactive) query = query.eq("status", "active");
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as OrganizationMembership[];
}

/** Organizations where this user currently has an ACTIVE membership. */
export async function listActiveOrganizationIdsForUser(
  db: DbClient,
  userId: string
): Promise<string[]> {
  const { data, error } = await db
    .from("organization_memberships")
    .select("organization_id")
    .eq("user_id", userId)
    .eq("status", "active");
  if (error) throw error;
  return ((data ?? []) as Array<{ organization_id: string }>).map(
    (row) => row.organization_id
  );
}

/**
 * Creates a membership if it does not exist, and otherwise changes NOTHING.
 *
 * This is the bootstrap/backfill path, so it is deliberately non-mutating on
 * conflict: re-running it must never revive a membership somebody deactivated,
 * nor overwrite a role an administrator changed. Reactivation and role changes
 * are explicit, separately authorized decisions — see `setMembershipStatus`.
 */
export async function ensureOrganizationMembership(
  db: DbClient,
  params: {
    organizationId: string;
    userId: string;
    role: OrganizationRole;
  }
): Promise<OrganizationMembership | null> {
  const { error } = await db.from("organization_memberships").upsert(
    {
      organization_id: params.organizationId,
      user_id: params.userId,
      role: params.role,
      status: "active",
    },
    { onConflict: "organization_id,user_id", ignoreDuplicates: true }
  );
  if (error) throw error;

  const { data, error: readError } = await db
    .from("organization_memberships")
    .select("*")
    .eq("organization_id", params.organizationId)
    .eq("user_id", params.userId)
    .maybeSingle();
  if (readError) throw readError;
  return (data as OrganizationMembership) ?? null;
}

/**
 * Explicit lifecycle change. Separate from `ensureOrganizationMembership` on
 * purpose: deactivating and reactivating a member is an authority decision that
 * must be made deliberately by a caller, never as a side effect of a backfill.
 */
export async function setMembershipStatus(
  db: DbClient,
  params: {
    organizationId: string;
    userId: string;
    status: "active" | "inactive";
  }
): Promise<OrganizationMembership> {
  const { data, error } = await db
    .from("organization_memberships")
    .update({ status: params.status, updated_at: new Date().toISOString() })
    .eq("organization_id", params.organizationId)
    .eq("user_id", params.userId)
    .select("*")
    .single();
  if (error) throw error;
  return data as OrganizationMembership;
}

// ============================================================
// Write authorization
// ============================================================

/**
 * Action vocabulary for Organization-owned writes. It grows with the slices;
 * an unknown action is refused rather than allowed.
 */
export type OrgAction =
  | "case.write"
  | "case_relationship.write"
  | "organization.manage_members"
  | "organization.manage_flags"
  | "organization.manage_secrets";

const ACTION_ROLES: Record<OrgAction, readonly OrganizationRole[]> = {
  "case.write": ["owner", "org_admin", "advisor"],
  "case_relationship.write": ["owner", "org_admin", "advisor"],
  "organization.manage_members": ["owner", "org_admin"],
  "organization.manage_flags": ["owner", "org_admin"],
  "organization.manage_secrets": ["owner", "org_admin"],
};

export type OrgAuthorizationReason =
  | "active_member"
  | "no_active_membership"
  | "role_not_permitted"
  | "unknown_action";

export interface OrgAuthorizationResult {
  allowed: boolean;
  reason: OrgAuthorizationReason;
  /** Present when an active membership was found; persist actor + role with the decision. */
  membership: OrganizationMembership | null;
}

/**
 * The deterministic gate every server-route mutation on Organization-owned rows
 * must pass before writing. Membership + role, evaluated now — never inherited
 * from a session claim, a binding row or a previous decision.
 */
export async function authorizeOrgAction(
  db: DbClient,
  actorUserId: string,
  organizationId: string,
  action: OrgAction
): Promise<OrgAuthorizationResult> {
  const allowedRoles = ACTION_ROLES[action];
  if (!allowedRoles) {
    return { allowed: false, reason: "unknown_action", membership: null };
  }

  const membership = await getActiveMembership(db, organizationId, actorUserId);
  if (!membership) {
    return { allowed: false, reason: "no_active_membership", membership: null };
  }
  if (!allowedRoles.includes(membership.role)) {
    return { allowed: false, reason: "role_not_permitted", membership };
  }
  return { allowed: true, reason: "active_member", membership };
}

export class OrgAuthorizationError extends Error {
  constructor(
    readonly organizationId: string,
    readonly action: OrgAction,
    readonly reason: OrgAuthorizationReason
  ) {
    super(`Not authorized for ${action} on organization ${organizationId}: ${reason}`);
    this.name = "OrgAuthorizationError";
  }
}

/** Throwing variant for call sites that treat denial as an error path. */
export async function assertOrgAction(
  db: DbClient,
  actorUserId: string,
  organizationId: string,
  action: OrgAction
): Promise<OrganizationMembership> {
  const result = await authorizeOrgAction(db, actorUserId, organizationId, action);
  if (!result.allowed || !result.membership) {
    throw new OrgAuthorizationError(organizationId, action, result.reason);
  }
  return result.membership;
}
