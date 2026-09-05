/**
 * Bounded operational read gateway over Traditional Gu (R1 SL-1 / TD-5).
 *
 * The public entry points below are the whole surface. Each resolves the
 * Organization's credentials, builds the bootstrap readers and runs the
 * capability - so a caller supplies an Organization and an opaque identifier,
 * and receives a normalized result with provenance or a typed refusal.
 *
 * Server-only. Nothing here may be imported into a browser bundle: the
 * credential resolver refuses to run where a `window` exists, and these
 * functions exist to reach systems a browser must never reach directly.
 */
import type {
  LegacyDealAppointments,
  LegacyLeadContext,
  LegacyPropertyDetails,
  LegacyReadResult,
  LegacyRecentMessages,
} from "@agents/types";
import {
  appointmentGet,
  legacyLeadGetContext,
  legacyLeadGetRecentMessages,
  propertyGetDetails,
} from "./capabilities";
import type { GatewayCallerContext } from "./authorization";
import { resolveLegacySourceReaders } from "./runtime";

export type { GatewayCallerContext } from "./authorization";
export { isLegacyGatewayEnvEnabled } from "./authorization";
export {
  LegacyReadRefusal,
  isLegacyReadRefusal,
  type LegacyReadRefusalReason,
} from "./errors";
export {
  registerDriftAlarmSink,
  type DriftAlarm,
  type ContractViolation,
} from "./drift";
export {
  ALLOWED_SOURCE_PATHS,
  DELIBERATELY_EXCLUDED_PATHS,
} from "./allowlist";
/**
 * The bootstrap adapters are exported so the hosted verification run can build
 * readers from an explicitly declared legacy target rather than from the stored
 * credential - which is what lets the evidence state exactly which identity
 * performed the read. Application code should use the entry points below, which
 * resolve credentials per Organization.
 */
export {
  closeLegacySourceConnections,
  createFirestoreReader,
  createMongoReader,
} from "./adapters";
export { SOURCE_CONTRACTS } from "./source-contracts";
export type {
  LegacyFirestoreReader,
  LegacyMongoReader,
  LegacySourceReaders,
  RawDocument,
} from "./source-clients";
export {
  appointmentGet,
  legacyLeadGetContext,
  legacyLeadGetRecentMessages,
  propertyGetDetails,
} from "./capabilities";
/**
 * Exported so a verification run can exercise the PRODUCT credential path -
 * `organization_tool_secrets` -> decrypt -> adapter - rather than supplying a
 * credential of its own. A run that supplies its own credential proves the
 * adapters and proves nothing about credential resolution.
 */
export { resolveLegacySourceReaders } from "./runtime";

export async function readLegacyLeadContext(
  ctx: GatewayCallerContext,
  legacyLeadId: string
): Promise<LegacyReadResult<LegacyLeadContext>> {
  const readers = await resolveLegacySourceReaders({
    db: ctx.db,
    organizationId: ctx.organizationId,
    capability: "legacy_lead_get_context",
    externalId: legacyLeadId,
  });
  return legacyLeadGetContext({ ctx, readers, legacyLeadId });
}

export async function readLegacyLeadRecentMessages(
  ctx: GatewayCallerContext,
  legacyLeadId: string,
  limit?: number
): Promise<LegacyReadResult<LegacyRecentMessages>> {
  const readers = await resolveLegacySourceReaders({
    db: ctx.db,
    organizationId: ctx.organizationId,
    capability: "legacy_lead_get_recent_messages",
    externalId: legacyLeadId,
  });
  return legacyLeadGetRecentMessages({ ctx, readers, legacyLeadId, limit });
}

export async function readLegacyDealAppointments(
  ctx: GatewayCallerContext,
  legacyDealId: string,
  legacyAppointmentId?: string
): Promise<LegacyReadResult<LegacyDealAppointments>> {
  const readers = await resolveLegacySourceReaders({
    db: ctx.db,
    organizationId: ctx.organizationId,
    capability: "appointment_get",
    externalId: legacyDealId,
    needsMongo: true,
  });
  return appointmentGet({ ctx, readers, legacyDealId, legacyAppointmentId });
}

export async function readLegacyPropertyDetails(
  ctx: GatewayCallerContext,
  legacyPropertyId: string
): Promise<LegacyReadResult<LegacyPropertyDetails>> {
  const readers = await resolveLegacySourceReaders({
    db: ctx.db,
    organizationId: ctx.organizationId,
    capability: "property_get_details",
    externalId: legacyPropertyId,
  });
  return propertyGetDetails({ ctx, readers, legacyPropertyId });
}
