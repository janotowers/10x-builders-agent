/**
 * The gate every gateway read passes before a byte of source data is returned
 * (Technical Plan 6: "gateway checks org external-binding before every legacy
 * read"; ADR-106; SA-1.6).
 *
 * It has two halves, and both are load-bearing:
 *
 * **Before the read** - the calling Organization must be bound to Traditional
 * Gu at all, the caller must be an active member of it, and the flags must be
 * on. If the requested external identity is already bound to a *different*
 * Organization, the read stops here: that is a cross-tenant attempt and it must
 * never reach a source.
 *
 * **After the fetch, before returning** - the record's own legacy owner is
 * resolved through Gu OS bindings and must land on the calling Organization.
 * This is what makes discovery reads safe. SL-2 admission legitimately reads a
 * lead that has no Gu OS binding yet, so a binding-only check would either
 * refuse the case the gateway exists to serve, or wave through any lead id a
 * caller could name. Ownership containment answers it from the data itself.
 *
 * The containment chain, verified first-hand against the source on 2026-09-04:
 *
 *     lead.Asesor      -> users/{advisorUid}.organization_id -> bare ownerUid
 *     property.user_owner -> users/{ownerUid}.organization_id -> bare ownerUid
 *     appointment.user_owner -> same
 *
 * and that bare owner uid is exactly the `legacy_organization_key` binding SL-0
 * established for the pilot Organization.
 */
import {
  getActiveMembership,
  isRelationshipOpsEnabled,
  listOrganizationBindingsOfKind,
  resolveOrganizationByExternalId,
  type DbClient,
} from "@agents/db";
import type {
  ExternalBindingKind,
  LegacyBindingState,
  LegacyGatewayCapability,
} from "@agents/types";
import { LegacyReadRefusal } from "./errors";
import { normalizeReference } from "./normalize";
import type { LegacyFirestoreReader } from "./source-clients";
import { USER_CONTRACT } from "./source-contracts";
import { checkSourceContract } from "./drift";

const SOURCE_SYSTEM = "traditional_gu" as const;

/**
 * Only the variables this module reads. Narrower than `NodeJS.ProcessEnv` on
 * purpose: it makes the environment dependency explicit and lets a test pass a
 * literal instead of a whole process environment.
 */
export type GatewayEnv = Record<string, string | undefined>;

/** Global kill-switch. Absent or anything but `true` means off. */
export function isLegacyGatewayEnvEnabled(
  env: GatewayEnv = process.env
): boolean {
  return env.LEGACY_GATEWAY_ENABLED === "true";
}

export interface GatewayCallerContext {
  db: DbClient;
  /** Never inferred. The Organization the read is authorized against. */
  organizationId: string;
  /**
   * The acting user, when there is one. Server-initiated reads (the admission
   * pipeline, a scheduled reconciliation) legitimately have no human actor;
   * they still carry the Organization, which is what authorizes the read.
   */
  actorUserId?: string;
}

export interface PreReadGateResult {
  bindingState: LegacyBindingState;
}

/**
 * Runs everything that can be decided before touching a source.
 *
 * Throws `LegacyReadRefusal` rather than returning a flag: a caller that
 * forgets to check a boolean would proceed to read, and this is the one place
 * where that mistake is unrecoverable.
 */
export async function assertPreReadGate(params: {
  ctx: GatewayCallerContext;
  capability: LegacyGatewayCapability;
  /** The opaque identity being requested. */
  externalId: string;
  /**
   * Binding kind the identity would carry if it were bound. `null` for
   * identities Gu OS does not bind at all (a deal id, a property id), where
   * containment is the only available check.
   */
  bindingKind: ExternalBindingKind | null;
  env?: GatewayEnv;
}): Promise<PreReadGateResult> {
  const { ctx, capability, externalId } = params;
  const refuse = (
    reason: ConstructorParameters<typeof LegacyReadRefusal>[0],
    detail?: string
  ): never => {
    throw new LegacyReadRefusal(reason, capability, externalId, detail);
  };

  if (!ctx.organizationId?.trim()) {
    throw new Error(
      "legacy-gateway: organizationId is required on every read (never inferred)"
    );
  }
  if (!externalId?.trim()) {
    throw new Error("legacy-gateway: an external identifier is required");
  }

  // 1. Flags. Env kill-switch first, then the Organization's own rollout flag:
  //    either one off means the gateway is inert for this Organization.
  if (!isLegacyGatewayEnvEnabled(params.env)) {
    refuse("gateway_disabled", "LEGACY_GATEWAY_ENABLED is not true");
  }
  if (!(await isRelationshipOpsEnabled(ctx.db, ctx.organizationId))) {
    refuse("gateway_disabled", "relationship_ops is off for this Organization");
  }

  // 2. Membership, re-checked now. Identity is not authorization (ADR-106), and
  //    a read is exactly where an inactive member must stop.
  if (ctx.actorUserId) {
    const membership = await getActiveMembership(
      ctx.db,
      ctx.organizationId,
      ctx.actorUserId
    );
    if (!membership) refuse("not_an_active_member");
  }

  // 3. The Organization must be bound to Traditional Gu at all.
  const organizationBindings = await listOrganizationBindingsOfKind(ctx.db, {
    organizationId: ctx.organizationId,
    sourceSystem: SOURCE_SYSTEM,
    bindingKind: "legacy_organization_key",
  });
  if (organizationBindings.length === 0) {
    refuse(
      "organization_not_bound_to_source",
      "no legacy_organization_key binding"
    );
  }

  // 4. If the requested identity is bound anywhere, it must be bound here.
  let bindingState: LegacyBindingState = "unbound";
  if (params.bindingKind) {
    const existing = await resolveOrganizationByExternalId(ctx.db, {
      sourceSystem: SOURCE_SYSTEM,
      bindingKind: params.bindingKind,
      externalId,
    });
    if (existing) {
      if (existing.organization_id !== ctx.organizationId) {
        refuse("belongs_to_another_organization");
      }
      bindingState = "bound";
    }
  }

  return { bindingState };
}

/**
 * Resolves a record's legacy owner to a Gu OS Organization.
 *
 * `ownerReference` is whatever the record carried - a `DocumentReference`, a
 * text path or a bare uid. When it points at a `users/{uid}` document, that
 * document's `organization_id` is the legacy organization/principal bridge and
 * is followed one hop; when the reference is already the owner principal, it
 * resolves directly. Both forms end at a bare uid, which is the
 * `legacy_organization_key` SL-0 bound.
 *
 * Returns the resolved Organization id, or null when ownership cannot be
 * established - which callers treat as a refusal, never as a match.
 */
export async function resolveOwningOrganization(params: {
  ctx: GatewayCallerContext;
  capability: LegacyGatewayCapability;
  externalId: string;
  ownerReference: unknown;
  firestore: LegacyFirestoreReader;
}): Promise<{ organizationId: string | null; ownerLegacyUserId: string | null; ownerRawValue: string | null }> {
  const owner = normalizeReference(params.ownerReference);
  if (!owner.id) {
    return { organizationId: null, ownerLegacyUserId: null, ownerRawValue: owner.raw };
  }

  // The uid may itself be the owner principal the Organization is bound to.
  const direct = await resolveOrganizationByExternalId(params.ctx.db, {
    sourceSystem: SOURCE_SYSTEM,
    bindingKind: "legacy_organization_key",
    externalId: owner.id,
  });
  if (direct) {
    return {
      organizationId: direct.organization_id,
      ownerLegacyUserId: owner.id,
      ownerRawValue: owner.raw,
    };
  }

  // Otherwise follow the one legacy hop: users/{uid}.organization_id.
  const userDocument = await params.firestore.getUser(owner.id);
  if (!userDocument) {
    return { organizationId: null, ownerLegacyUserId: owner.id, ownerRawValue: owner.raw };
  }
  checkSourceContract({
    contract: USER_CONTRACT,
    document: userDocument.data,
    capability: params.capability,
    organizationId: params.ctx.organizationId,
    externalId: params.externalId,
  });
  const organizationReference = normalizeReference(
    userDocument.data.organization_id
  );
  if (!organizationReference.id) {
    return { organizationId: null, ownerLegacyUserId: owner.id, ownerRawValue: owner.raw };
  }
  const binding = await resolveOrganizationByExternalId(params.ctx.db, {
    sourceSystem: SOURCE_SYSTEM,
    bindingKind: "legacy_organization_key",
    externalId: organizationReference.id,
  });
  return {
    organizationId: binding?.organization_id ?? null,
    ownerLegacyUserId: organizationReference.id,
    ownerRawValue: organizationReference.raw ?? owner.raw,
  };
}

/**
 * Ownership containment: the fetched record must belong to the calling
 * Organization, or nothing is returned.
 *
 * A drift alarm is deliberately NOT raised when ownership is merely absent -
 * that is ordinary data variance (the lead `Asesor` reference is missing on
 * about 2% of documents). It is a refusal, not a shape change.
 */
export async function assertOwnershipContained(params: {
  ctx: GatewayCallerContext;
  capability: LegacyGatewayCapability;
  externalId: string;
  ownerReference: unknown;
  firestore: LegacyFirestoreReader;
}): Promise<{ ownerLegacyUserId: string | null; ownerRawValue: string | null }> {
  const resolved = await resolveOwningOrganization(params);
  if (resolved.organizationId !== params.ctx.organizationId) {
    throw new LegacyReadRefusal(
      resolved.organizationId === null
        ? "ownership_not_contained"
        : "belongs_to_another_organization",
      params.capability,
      params.externalId,
      resolved.organizationId === null
        ? "record owner does not resolve to any bound Organization"
        : "record owner resolves to a different Organization"
    );
  }
  return {
    ownerLegacyUserId: resolved.ownerLegacyUserId,
    ownerRawValue: resolved.ownerRawValue,
  };
}
