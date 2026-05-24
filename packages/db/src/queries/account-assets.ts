/**
 * Account assets are tenant-specific files required by operational flows:
 * contract templates, watermarks, brand files, etc.
 */
import type { DbClient } from "../client";
import type { AccountAsset } from "@agents/types";

export interface ListAccountAssetsFilter {
  userId: string;
  assetKeys?: string[];
  assetKeyPrefixes?: string[];
}

export async function listAccountAssets(
  db: DbClient,
  filter: ListAccountAssetsFilter
): Promise<AccountAsset[]> {
  let query = db
    .from("account_assets")
    .select("*")
    .eq("user_id", filter.userId)
    .order("updated_at", { ascending: false });
  if (filter.assetKeys?.length && !filter.assetKeyPrefixes?.length) {
    query = query.in("asset_key", filter.assetKeys);
  }
  const { data, error } = await query;
  if (error) throw error;
  const assets = (data ?? []) as AccountAsset[];
  if (!filter.assetKeys?.length && !filter.assetKeyPrefixes?.length) {
    return assets;
  }
  const exactKeys = new Set(filter.assetKeys ?? []);
  const prefixes = filter.assetKeyPrefixes ?? [];
  return assets.filter(
    (asset) =>
      exactKeys.has(asset.asset_key) ||
      prefixes.some((prefix) => asset.asset_key.startsWith(`${prefix}__`))
  );
}

export async function getAccountAssetById(
  db: DbClient,
  assetId: string
): Promise<AccountAsset | null> {
  const { data, error } = await db
    .from("account_assets")
    .select("*")
    .eq("id", assetId)
    .maybeSingle();
  if (error) throw error;
  return (data as AccountAsset | null) ?? null;
}

export async function getAccountAssetByStoragePath(
  db: DbClient,
  input: { storageBucket: string; storagePath: string }
): Promise<AccountAsset | null> {
  const { data, error } = await db
    .from("account_assets")
    .select("*")
    .eq("storage_bucket", input.storageBucket)
    .eq("storage_path", input.storagePath)
    .maybeSingle();
  if (error) throw error;
  return (data as AccountAsset | null) ?? null;
}

export interface UpsertAccountAssetInput {
  userId: string;
  assetKey: string;
  displayName: string;
  description?: string | null;
  storageBucket: string;
  storagePath: string;
  contentType?: string | null;
  fileSizeBytes?: number | null;
  sourceToolId?: string | null;
  caseTypeId?: string | null;
  metadata?: Record<string, unknown>;
}

export async function upsertAccountAsset(
  db: DbClient,
  input: UpsertAccountAssetInput
): Promise<AccountAsset> {
  const now = new Date().toISOString();
  const { data, error } = await db
    .from("account_assets")
    .upsert(
      {
        user_id: input.userId,
        asset_key: input.assetKey,
        display_name: input.displayName,
        description: input.description ?? null,
        storage_bucket: input.storageBucket,
        storage_path: input.storagePath,
        content_type: input.contentType ?? null,
        file_size_bytes: input.fileSizeBytes ?? null,
        source_tool_id: input.sourceToolId ?? null,
        case_type_id: input.caseTypeId ?? null,
        metadata_jsonb: input.metadata ?? {},
        updated_at: now,
      },
      { onConflict: "user_id,asset_key" }
    )
    .select("*")
    .single();
  if (error) throw error;
  return data as AccountAsset;
}

export async function deleteAccountAsset(
  db: DbClient,
  input: { userId: string; assetKey: string }
): Promise<AccountAsset | null> {
  const { data: existing, error: selectError } = await db
    .from("account_assets")
    .select("*")
    .eq("user_id", input.userId)
    .eq("asset_key", input.assetKey)
    .maybeSingle();
  if (selectError) throw selectError;
  if (!existing) return null;

  const { error: deleteError } = await db
    .from("account_assets")
    .delete()
    .eq("user_id", input.userId)
    .eq("asset_key", input.assetKey);
  if (deleteError) throw deleteError;
  return existing as AccountAsset;
}
