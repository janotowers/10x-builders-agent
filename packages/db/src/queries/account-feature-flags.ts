import type { WorkflowEnforcementMode } from "@agents/types";
import type { DbClient } from "../client";

// Slice 1.4 / §X finding 7: per-tenant feature flags. Service-role writes.

export interface AccountFeatureFlag {
  id: string;
  user_id: string;
  flag_key: string;
  enabled: boolean;
  value_text: string | null;
  updated_at: string;
  created_at: string;
}

export async function getAccountFeatureFlag(
  db: DbClient,
  userId: string,
  flagKey: string
): Promise<AccountFeatureFlag | null> {
  const { data, error } = await db
    .from("account_feature_flags")
    .select("*")
    .eq("user_id", userId)
    .eq("flag_key", flagKey)
    .maybeSingle();
  if (error) throw error;
  return (data as AccountFeatureFlag) ?? null;
}

export async function setAccountFeatureFlag(
  db: DbClient,
  params: {
    userId: string;
    flagKey: string;
    enabled: boolean;
    valueText?: string | null;
  }
): Promise<AccountFeatureFlag> {
  const { data, error } = await db
    .from("account_feature_flags")
    .upsert(
      {
        user_id: params.userId,
        flag_key: params.flagKey,
        enabled: params.enabled,
        value_text: params.valueText ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,flag_key" }
    )
    .select("*")
    .single();
  if (error) throw error;
  return data as AccountFeatureFlag;
}

export const WORKFLOW_ENFORCEMENT_MODE_FLAG_KEY = "workflow_enforcement_mode";

/** Slice 2.3: plano de trabajo v2 por tenant. Sin fila = apagado. */
export const WORK_PLANE_V2_FLAG_KEY = "work_plane_v2";

export async function isWorkPlaneV2Enabled(
  db: DbClient,
  userId: string
): Promise<boolean> {
  const flag = await getAccountFeatureFlag(db, userId, WORK_PLANE_V2_FLAG_KEY);
  return flag?.enabled === true;
}

/**
 * Tenants con el work plane v2 habilitado (lectura service-role para el pass
 * del cron). Devuelve solo user_ids; el dispatch por tenant sigue exigiendo
 * userId en cada query (regla 3).
 */
export async function listWorkPlaneV2Tenants(db: DbClient): Promise<string[]> {
  const { data, error } = await db
    .from("account_feature_flags")
    .select("user_id")
    .eq("flag_key", WORK_PLANE_V2_FLAG_KEY)
    .eq("enabled", true);
  if (error) throw error;
  return ((data ?? []) as Array<{ user_id: string }>).map((row) => row.user_id);
}

/**
 * Per-tenant evaluator mode (S1.4). No row (or unknown value) = "advisory":
 * divergences are logged as case events without changing behavior. "off"
 * disables evaluation entirely; "enforcing" rejects illegal proposals (S1.7).
 */
export async function getWorkflowEnforcementMode(
  db: DbClient,
  userId: string
): Promise<WorkflowEnforcementMode> {
  const flag = await getAccountFeatureFlag(
    db,
    userId,
    WORKFLOW_ENFORCEMENT_MODE_FLAG_KEY
  );
  if (!flag) return "advisory";
  if (flag.value_text === "off" || flag.value_text === "enforcing") {
    return flag.value_text;
  }
  return "advisory";
}
