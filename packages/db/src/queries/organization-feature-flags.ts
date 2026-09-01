import {
  ORGANIZATION_FLAG_KEYS,
  type LegacyEventIngestionMode,
  type OrganizationFeatureFlag,
  type RelationshipAdmissionMode,
  type RelationshipEffectMode,
  type RuntimeAuthorityTransferMode,
} from "@agents/types";
import type { DbClient } from "../client";

/**
 * Organization-scoped rollout flags (Technical Plan TD-2b).
 *
 * Mirrors `account-feature-flags` in shape, but resolution is deliberately
 * Organization-scoped with NO per-user fallback: these flags gate authority-
 * bearing behavior, and a per-member fallback would let two advisors of the
 * same Organization act under different admission, effect or authority modes.
 *
 * Every resolver below fails closed — a missing row, an unknown value or a
 * disabled flag yields the most conservative mode, never a wider one.
 */

export async function getOrganizationFlag(
  db: DbClient,
  organizationId: string,
  flagKey: string
): Promise<OrganizationFeatureFlag | null> {
  const { data, error } = await db
    .from("organization_feature_flags")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("flag_key", flagKey)
    .maybeSingle();
  if (error) throw error;
  return (data as OrganizationFeatureFlag) ?? null;
}

/** Raw enum-valued read. Returns null when the flag is absent or disabled. */
export async function getOrganizationFlagValue(
  db: DbClient,
  organizationId: string,
  flagKey: string
): Promise<string | null> {
  const flag = await getOrganizationFlag(db, organizationId, flagKey);
  if (!flag || !flag.enabled) return null;
  return flag.value_text;
}

export async function isOrganizationFlagEnabled(
  db: DbClient,
  organizationId: string,
  flagKey: string
): Promise<boolean> {
  const flag = await getOrganizationFlag(db, organizationId, flagKey);
  return flag?.enabled === true;
}

export async function setOrganizationFlag(
  db: DbClient,
  params: {
    organizationId: string;
    flagKey: string;
    enabled: boolean;
    valueText?: string | null;
  }
): Promise<OrganizationFeatureFlag> {
  const { data, error } = await db
    .from("organization_feature_flags")
    .upsert(
      {
        organization_id: params.organizationId,
        flag_key: params.flagKey,
        enabled: params.enabled,
        value_text: params.valueText ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "organization_id,flag_key" }
    )
    .select("*")
    .single();
  if (error) throw error;
  return data as OrganizationFeatureFlag;
}

// ============================================================
// Typed, fail-closed resolvers
// ============================================================

function oneOf<T extends string>(
  value: string | null,
  allowed: readonly T[],
  fallback: T
): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/** Master switch. Everything R1 stays inert while this is off. */
export async function isRelationshipOpsEnabled(
  db: DbClient,
  organizationId: string
): Promise<boolean> {
  return isOrganizationFlagEnabled(
    db,
    organizationId,
    ORGANIZATION_FLAG_KEYS.relationshipOps
  );
}

export async function getRelationshipAdmissionMode(
  db: DbClient,
  organizationId: string
): Promise<RelationshipAdmissionMode> {
  const value = await getOrganizationFlagValue(
    db,
    organizationId,
    ORGANIZATION_FLAG_KEYS.admissionMode
  );
  return oneOf(value, ["shadow", "assisted", "live"] as const, "shadow");
}

export async function getRelationshipSendEffectMode(
  db: DbClient,
  organizationId: string
): Promise<RelationshipEffectMode> {
  const value = await getOrganizationFlagValue(
    db,
    organizationId,
    ORGANIZATION_FLAG_KEYS.sendEffects
  );
  return oneOf(value, ["off", "approval_only", "policy"] as const, "off");
}

export async function getRelationshipAppointmentEffectMode(
  db: DbClient,
  organizationId: string
): Promise<RelationshipEffectMode> {
  const value = await getOrganizationFlagValue(
    db,
    organizationId,
    ORGANIZATION_FLAG_KEYS.appointmentEffects
  );
  return oneOf(value, ["off", "approval_only", "policy"] as const, "off");
}

export async function getRuntimeAuthorityTransferMode(
  db: DbClient,
  organizationId: string
): Promise<RuntimeAuthorityTransferMode> {
  const value = await getOrganizationFlagValue(
    db,
    organizationId,
    ORGANIZATION_FLAG_KEYS.runtimeAuthorityTransfer
  );
  return oneOf(value, ["off", "selected"] as const, "off");
}

export async function getLegacyEventIngestionMode(
  db: DbClient,
  organizationId: string
): Promise<LegacyEventIngestionMode> {
  const value = await getOrganizationFlagValue(
    db,
    organizationId,
    ORGANIZATION_FLAG_KEYS.legacyEventIngestion
  );
  return oneOf(value, ["poll", "webhook"] as const, "poll");
}
