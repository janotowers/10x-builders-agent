/**
 * Typed refusals for the bounded legacy read gateway (R1 SL-1).
 *
 * Every refusal reason is a distinct value, because "the gateway returned
 * nothing" has several very different meanings and collapsing them would hide
 * the one that matters: a cross-tenant attempt looks identical to a missing
 * record unless the code says otherwise.
 *
 * A refusal never carries source data - only the reason and the opaque
 * identifier that was asked for.
 */
import type { LegacyGatewayCapability } from "@agents/types";

export type LegacyReadRefusalReason =
  /** `LEGACY_GATEWAY_ENABLED` is off, or the Organization's `relationship_ops` flag is off. */
  | "gateway_disabled"
  /** The caller is not an active member of the Organization it asked to read for. */
  | "not_an_active_member"
  /** The Organization has no verified binding to the legacy source system. */
  | "organization_not_bound_to_source"
  /** The requested identity is bound to a DIFFERENT Organization. */
  | "belongs_to_another_organization"
  /** The record's legacy owner does not resolve to the calling Organization. */
  | "ownership_not_contained"
  /** No usable credential for the provider this capability needs. */
  | "no_usable_credential"
  /** The record does not exist in any allowlisted store. */
  | "not_found"
  /** A source document no longer matches its recorded contract fixture. */
  | "contract_drift"
  /** The source could not be reached. Transient by nature; never cached as absence. */
  | "source_unavailable";

/**
 * Refusals that mean "you may not read this", as opposed to "there is nothing
 * to read" or "the source is having a bad day". Kept as data so a caller can
 * treat authority failures differently from availability failures without
 * re-deriving the classification.
 */
export const AUTHORITY_REFUSALS: readonly LegacyReadRefusalReason[] = [
  "gateway_disabled",
  "not_an_active_member",
  "organization_not_bound_to_source",
  "belongs_to_another_organization",
  "ownership_not_contained",
];

export class LegacyReadRefusal extends Error {
  readonly name = "LegacyReadRefusal";

  constructor(
    readonly reason: LegacyReadRefusalReason,
    readonly capability: LegacyGatewayCapability,
    readonly externalId: string,
    readonly detail?: string
  ) {
    super(
      `legacy-gateway refused ${capability} for "${externalId}": ${reason}` +
        (detail ? ` (${detail})` : "")
    );
  }

  get isAuthorityRefusal(): boolean {
    return AUTHORITY_REFUSALS.includes(this.reason);
  }
}

export function isLegacyReadRefusal(value: unknown): value is LegacyReadRefusal {
  return value instanceof LegacyReadRefusal;
}
