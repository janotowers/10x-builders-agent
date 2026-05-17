/**
 * Queries para account_tool_secrets.
 * Ver migración 00024_account_tool_secrets.sql.
 *
 * Reglas de uso:
 *  - El secreto cifrado (`encrypted_secret_jsonb`) **nunca** debe llegar al
 *    cliente. Las funciones `listAccountToolSecretsPublic` y
 *    `getAccountToolSecretPublic` proyectan sólo metadatos seguros.
 *  - Las funciones `*WithSecret` se usan **sólo server-side** desde el
 *    runtime de tools/adapters, jamás desde API públicas que devuelvan el
 *    valor al browser.
 *  - El cifrado vive en `crypto.ts` (encryptJson/decryptJson) y exige
 *    ENCRYPTION_KEY válido. Para entornos de test sin esa env, los call
 *    sites deben gatear la lectura.
 */
import type { DbClient } from "../client";
import { decryptJson, encryptJson } from "../crypto";
import type {
  AccountToolSecretPublic,
  AccountToolSecretStatus,
} from "@agents/types";

const PUBLIC_COLUMNS =
  "id,user_id,provider,config_jsonb,status,last_checked_at,last_used_at,last_error,created_at,updated_at";

export async function listAccountToolSecretsPublic(
  db: DbClient,
  userId: string
): Promise<AccountToolSecretPublic[]> {
  const { data, error } = await db
    .from("account_tool_secrets")
    .select(PUBLIC_COLUMNS)
    .eq("user_id", userId)
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as AccountToolSecretPublic[];
}

export async function getAccountToolSecretPublic(
  db: DbClient,
  params: { userId: string; provider: string }
): Promise<AccountToolSecretPublic | null> {
  const { data, error } = await db
    .from("account_tool_secrets")
    .select(PUBLIC_COLUMNS)
    .eq("user_id", params.userId)
    .eq("provider", params.provider)
    .maybeSingle();
  if (error) throw error;
  return (data as AccountToolSecretPublic | null) ?? null;
}

export interface UpsertAccountToolSecretInput {
  userId: string;
  provider: string;
  /** Config no sensible, visible para la UI (mappings, defaults, IDs públicos). */
  config: Record<string, unknown>;
  /**
   * Secretos planos antes de cifrar. Forma libre por provider:
   *  - EasyBroker: `{ api_key: string }`
   *  - Ungga: `{ api_base: string, api_token: string }`
   */
  secret: Record<string, unknown>;
  /** Estado inicial. Por defecto `pending_test` para forzar validación. */
  status?: AccountToolSecretStatus;
}

export async function upsertAccountToolSecret(
  db: DbClient,
  input: UpsertAccountToolSecretInput
): Promise<AccountToolSecretPublic> {
  const row = {
    user_id: input.userId,
    provider: input.provider,
    config_jsonb: input.config ?? {},
    encrypted_secret_jsonb: encryptJson(input.secret),
    status: input.status ?? "pending_test",
    // Reset error/last_checked: nuevos secretos exigen revalidar.
    last_error: null,
    last_checked_at: null,
  };
  const { data, error } = await db
    .from("account_tool_secrets")
    .upsert(row, { onConflict: "user_id,provider" })
    .select(PUBLIC_COLUMNS)
    .single();
  if (error) throw error;
  return data as AccountToolSecretPublic;
}

export async function updateAccountToolSecretStatus(
  db: DbClient,
  params: {
    userId: string;
    provider: string;
    status: AccountToolSecretStatus;
    lastError?: string | null;
    markChecked?: boolean;
    markUsed?: boolean;
  }
): Promise<AccountToolSecretPublic | null> {
  const update: Record<string, unknown> = {
    status: params.status,
    last_error: params.lastError ?? null,
  };
  if (params.markChecked) update.last_checked_at = new Date().toISOString();
  if (params.markUsed) update.last_used_at = new Date().toISOString();
  const { data, error } = await db
    .from("account_tool_secrets")
    .update(update)
    .eq("user_id", params.userId)
    .eq("provider", params.provider)
    .select(PUBLIC_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  return (data as AccountToolSecretPublic | null) ?? null;
}

export async function deleteAccountToolSecret(
  db: DbClient,
  params: { userId: string; provider: string }
): Promise<void> {
  const { error } = await db
    .from("account_tool_secrets")
    .delete()
    .eq("user_id", params.userId)
    .eq("provider", params.provider);
  if (error) throw error;
}

/**
 * Soft-delete: marca como `disconnected` y vacía `encrypted_secret_jsonb`
 * para no dejar material cifrado en reposo sin uso. Preserva
 * `config_jsonb` y el resto del historial para auditoría.
 */
export async function softDisconnectAccountToolSecret(
  db: DbClient,
  params: { userId: string; provider: string }
): Promise<AccountToolSecretPublic | null> {
  const { data, error } = await db
    .from("account_tool_secrets")
    .update({
      status: "disconnected",
      encrypted_secret_jsonb: "",
      last_error: null,
    })
    .eq("user_id", params.userId)
    .eq("provider", params.provider)
    .select(PUBLIC_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  return (data as AccountToolSecretPublic | null) ?? null;
}

/**
 * Server-only: devuelve el secreto descifrado para que un adapter pueda
 * llamar a la API externa. Nunca devolver esto al cliente.
 *
 * Devuelve `null` si no hay registro, si el estado es `disconnected`, o si
 * `ENCRYPTION_KEY` no está configurado (modo dev sin secretos cifrables).
 */
export async function getAccountToolSecretForRuntime<T = Record<string, unknown>>(
  db: DbClient,
  params: { userId: string; provider: string }
): Promise<{
  config: Record<string, unknown>;
  secret: T;
  status: AccountToolSecretStatus;
} | null> {
  const { data, error } = await db
    .from("account_tool_secrets")
    .select(
      "config_jsonb,encrypted_secret_jsonb,status"
    )
    .eq("user_id", params.userId)
    .eq("provider", params.provider)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  if (data.status === "disconnected") return null;
  if (!data.encrypted_secret_jsonb) return null;
  let secret: T;
  try {
    secret = decryptJson<T>(data.encrypted_secret_jsonb);
  } catch {
    // Si el cifrado falla (clave rotada, payload corrupto), tratamos el
    // registro como ausente para forzar al usuario a reconfigurar.
    return null;
  }
  return {
    config: (data.config_jsonb ?? {}) as Record<string, unknown>,
    secret,
    status: data.status as AccountToolSecretStatus,
  };
}
