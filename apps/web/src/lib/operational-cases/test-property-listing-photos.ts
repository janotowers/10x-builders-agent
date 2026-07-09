/**
 * Activos de prueba compartidos para fotos de listing (N1 analyze/watermark/EasyBroker
 * y semillas N3/N4 de package_ready).
 */
import { listAccountAssets, type DbClient } from "@agents/db";
import type { AccountAsset } from "@agents/types";

export const TEST_PROPERTY_LISTING_PHOTOS_ASSET_KEY = "test_property_listing_photos";
export const TEST_PROPERTY_LISTING_PHOTOS_PACKAGE_READY_MIN = 5;
export const TEST_PROPERTY_LISTING_PHOTOS_ANALYZE_MIN = 2;
/** Máximo de fotos en el fixture de prueba (UI N1 y semillas N3/N4). El adapter de analyze usa hasta 8 por llamada de visión. */
export const TEST_PROPERTY_LISTING_PHOTOS_MAX = 30;

const PACKAGE_READY_PHOTO_N4_SCENARIOS = new Set([
  "package_ready_description_review_requested",
  "package_ready_description_approved",
  "package_ready_easybroker_approval_requested",
  "package_ready_easybroker_published",
  "package_ready_completed_summary_sent",
]);

export class MissingTestPropertyListingPhotosError extends Error {
  readonly minimumRequired: number;

  constructor(minimumRequired: number) {
    super("missing_test_property_listing_photos");
    this.name = "MissingTestPropertyListingPhotosError";
    this.minimumRequired = minimumRequired;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function accountAssetToStorageRef(asset: {
  storage_bucket: string;
  storage_path: string;
}): string {
  return `${asset.storage_bucket}:${asset.storage_path}`;
}

export function sortListingPhotoTestAssets(assets: AccountAsset[]): AccountAsset[] {
  const exact = assets.filter(
    (asset) => asset.asset_key === TEST_PROPERTY_LISTING_PHOTOS_ASSET_KEY
  );
  const prefixed = assets.filter((asset) =>
    asset.asset_key.startsWith(`${TEST_PROPERTY_LISTING_PHOTOS_ASSET_KEY}__`)
  );
  return [...exact, ...prefixed].sort((a, b) =>
    a.asset_key.localeCompare(b.asset_key)
  );
}

/** Normaliza `raw_photos` (strings u objetos de caso) a refs `bucket:path` para tools. */
export function resolveImagePathsFromRawPhotos(
  rawPhotos: unknown,
  maxCount = TEST_PROPERTY_LISTING_PHOTOS_MAX
): string[] {
  if (!Array.isArray(rawPhotos)) return [];
  const paths: string[] = [];
  for (const item of rawPhotos) {
    if (typeof item === "string") {
      const trimmed = item.trim();
      if (trimmed) paths.push(trimmed);
    } else if (isRecord(item)) {
      const bucket =
        typeof item.storage_bucket === "string" ? item.storage_bucket.trim() : "";
      const storagePath =
        typeof item.storage_path === "string" ? item.storage_path.trim() : "";
      if (bucket && storagePath) {
        paths.push(`${bucket}:${storagePath}`);
      }
    }
    if (paths.length >= maxCount) break;
  }
  return paths;
}

export function rawPhotoEntriesFromAccountAssets(
  assets: AccountAsset[]
): Record<string, unknown>[] {
  return sortListingPhotoTestAssets(assets).map((asset) => ({
    storage_bucket: asset.storage_bucket,
    storage_path: asset.storage_path,
    original_name: asset.display_name?.trim() || asset.asset_key,
    content_type: asset.content_type ?? "image/jpeg",
    source: "settings_test",
    uploaded_at: new Date().toISOString(),
  }));
}

export async function listTestPropertyListingPhotoAssets(
  db: DbClient,
  userId: string
): Promise<AccountAsset[]> {
  const assets = await listAccountAssets(db, {
    userId,
    assetKeys: [TEST_PROPERTY_LISTING_PHOTOS_ASSET_KEY],
    assetKeyPrefixes: [TEST_PROPERTY_LISTING_PHOTOS_ASSET_KEY],
  });
  return sortListingPhotoTestAssets(assets);
}

export async function resolveTestPropertyListingPhotoPaths(
  db: DbClient,
  userId: string,
  options?: { minCount?: number; maxCount?: number }
): Promise<string[]> {
  const assets = await listTestPropertyListingPhotoAssets(db, userId);
  const maxCount = options?.maxCount ?? TEST_PROPERTY_LISTING_PHOTOS_MAX;
  const minCount = options?.minCount ?? 1;
  const paths = assets
    .slice(0, maxCount)
    .filter(
      (asset) =>
        typeof asset.storage_bucket === "string" &&
        asset.storage_bucket &&
        typeof asset.storage_path === "string" &&
        asset.storage_path
    )
    .map((asset) => accountAssetToStorageRef(asset));
  if (paths.length < minCount) {
    throw new MissingTestPropertyListingPhotosError(minCount);
  }
  return paths;
}

export async function resolveTestPropertyListingPhotoSeedEntries(
  db: DbClient,
  userId: string,
  options?: { minCount?: number; maxCount?: number }
): Promise<Record<string, unknown>[]> {
  const assets = await listTestPropertyListingPhotoAssets(db, userId);
  const maxCount = options?.maxCount ?? TEST_PROPERTY_LISTING_PHOTOS_MAX;
  const minCount = options?.minCount ?? 1;
  const selected = assets.slice(0, maxCount);
  if (selected.length < minCount) {
    throw new MissingTestPropertyListingPhotosError(minCount);
  }
  return rawPhotoEntriesFromAccountAssets(selected);
}

export async function hydratePackageReadyListingPhotosInContext(
  db: DbClient,
  userId: string,
  context: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const existingCount = resolveImagePathsFromRawPhotos(context.raw_photos).length;
  if (existingCount >= TEST_PROPERTY_LISTING_PHOTOS_PACKAGE_READY_MIN) {
    return context;
  }
  const rawPhotos = await resolveTestPropertyListingPhotoSeedEntries(db, userId, {
    minCount: TEST_PROPERTY_LISTING_PHOTOS_PACKAGE_READY_MIN,
  });
  return {
    ...context,
    raw_photos: rawPhotos,
  };
}

export function packageReadyN4ScenarioNeedsListingPhotos(scenarioId: string): boolean {
  return PACKAGE_READY_PHOTO_N4_SCENARIOS.has(scenarioId);
}

export function missingListingPhotosHint(minCount: number): string {
  return `Sube al menos ${minCount} foto(s) en Activos de prueba (${TEST_PROPERTY_LISTING_PHOTOS_ASSET_KEY}) antes de ejecutar este escenario.`;
}
