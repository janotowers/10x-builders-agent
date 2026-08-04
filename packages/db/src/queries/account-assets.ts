/**
 * Account assets are tenant-specific files required by operational flows:
 * contract templates, watermarks, brand files, etc.
 *
 * Versionado (Slice 3.1, Technical Plan §11 / finding 16): cada reemplazo de
 * contenido crea una fila inmutable en account_asset_versions. Los artefactos
 * generados (artifact_inputs, input_kind=account_asset) referencian la
 * VERSIÓN consumida, nunca el asset mutable — así un cambio de plantilla
 * stalea selectivamente solo a sus dependientes declarados.
 */
import type { DbClient } from "../client";
import type { AccountAsset, AccountAssetVersion } from "@agents/types";

const UNIQUE_VIOLATION = "23505";

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
  /**
   * SHA-256 hex del contenido subido. Los callers que tienen los bytes
   * (upload UI) DEBEN calcularlo; los que solo registran punteros a objetos
   * ya almacenados pueden omitirlo (la versión queda con hash null hasta que
   * el backfill lo compute).
   */
  contentHash?: string | null;
}

export async function upsertAccountAsset(
  db: DbClient,
  input: UpsertAccountAssetInput
): Promise<AccountAsset> {
  const now = new Date().toISOString();

  const { data: priorData, error: priorError } = await db
    .from("account_assets")
    .select("*")
    .eq("user_id", input.userId)
    .eq("asset_key", input.assetKey)
    .maybeSingle();
  if (priorError) throw priorError;
  const prior = (priorData as AccountAsset | null) ?? null;

  // Versionado (Slice 3.1): primer registro o reemplazo de contenido crea la
  // siguiente versión inmutable. Un upsert que no cambia contenido (mismo
  // path y mismo hash) no versiona.
  const contentChanged =
    !prior ||
    prior.storage_path !== input.storagePath ||
    prior.storage_bucket !== input.storageBucket ||
    (input.contentHash != null && prior.content_hash !== input.contentHash);
  // Sin hash nuevo: preservar el vigente solo si el contenido no cambió;
  // si cambió y no hay hash, el hash pasa a desconocido (null).
  const nextContentHash =
    input.contentHash ?? (contentChanged ? null : prior?.content_hash ?? null);

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
        content_hash: nextContentHash,
        updated_at: now,
      },
      { onConflict: "user_id,asset_key" }
    )
    .select("*")
    .single();
  if (error) throw error;
  const asset = data as AccountAsset;
  if (contentChanged) {
    await recordAccountAssetVersion(db, {
      userId: input.userId,
      asset,
      contentHash: input.contentHash ?? null,
    });
  }

  return asset;
}

async function recordAccountAssetVersion(
  db: DbClient,
  input: { userId: string; asset: AccountAsset; contentHash: string | null }
): Promise<AccountAssetVersion> {
  // La unicidad (account_asset_id, version_number) es el árbitro ante dos
  // reemplazos concurrentes; en colisión se relee el máximo y se reintenta.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const latest = await getLatestAccountAssetVersion(
      db,
      input.userId,
      input.asset.id
    );
    const { data, error } = await db
      .from("account_asset_versions")
      .insert({
        account_asset_id: input.asset.id,
        user_id: input.userId,
        version_number: (latest?.version_number ?? 0) + 1,
        asset_key: input.asset.asset_key,
        content_hash: input.contentHash,
        storage_bucket: input.asset.storage_bucket,
        storage_path: input.asset.storage_path,
        content_type: input.asset.content_type,
        file_size_bytes: input.asset.file_size_bytes,
      })
      .select("*")
      .single();
    if (!error) return data as AccountAssetVersion;
    if (error.code !== UNIQUE_VIOLATION) throw error;
  }
  throw new Error(
    `account_asset_versions: could not allocate a version number for asset ${input.asset.id} after 3 attempts`
  );
}

export async function listAccountAssetVersions(
  db: DbClient,
  userId: string,
  accountAssetId: string
): Promise<AccountAssetVersion[]> {
  const { data, error } = await db
    .from("account_asset_versions")
    .select("*")
    .eq("user_id", userId)
    .eq("account_asset_id", accountAssetId)
    .order("version_number", { ascending: false });
  if (error) throw error;
  return (data ?? []) as AccountAssetVersion[];
}

export async function getLatestAccountAssetVersion(
  db: DbClient,
  userId: string,
  accountAssetId: string
): Promise<AccountAssetVersion | null> {
  const { data, error } = await db
    .from("account_asset_versions")
    .select("*")
    .eq("user_id", userId)
    .eq("account_asset_id", accountAssetId)
    .order("version_number", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as AccountAssetVersion | null) ?? null;
}

/**
 * Versión vigente por asset_key (3.2: identidad de assets para el input-hash
 * del motor de impacto). `account_assets` es único por (user_id, asset_key),
 * así que la versión más reciente de la clave es la del asset vigente.
 */
export async function getLatestAccountAssetVersionByKey(
  db: DbClient,
  userId: string,
  assetKey: string
): Promise<AccountAssetVersion | null> {
  const { data, error } = await db
    .from("account_asset_versions")
    .select("*")
    .eq("user_id", userId)
    .eq("asset_key", assetKey)
    .order("created_at", { ascending: false })
    .order("version_number", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as AccountAssetVersion | null) ?? null;
}

export async function getAccountAssetVersionById(
  db: DbClient,
  userId: string,
  versionId: string
): Promise<AccountAssetVersion | null> {
  const { data, error } = await db
    .from("account_asset_versions")
    .select("*")
    .eq("user_id", userId)
    .eq("id", versionId)
    .maybeSingle();
  if (error) throw error;
  return (data as AccountAssetVersion | null) ?? null;
}

/**
 * Backfill v1 (Slice 3.1-5): fija content_hash de una versión existente.
 * Única mutación que el trigger de la tabla permite (null → valor).
 */
export async function fillAccountAssetVersionContentHash(
  db: DbClient,
  input: { userId: string; versionId: string; contentHash: string }
): Promise<AccountAssetVersion | null> {
  const { data, error } = await db
    .from("account_asset_versions")
    .update({ content_hash: input.contentHash })
    .eq("id", input.versionId)
    .eq("user_id", input.userId)
    .is("content_hash", null)
    .select("*");
  if (error) throw error;
  const rows = (data ?? []) as AccountAssetVersion[];
  return rows.length === 1 ? rows[0] : null;
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
