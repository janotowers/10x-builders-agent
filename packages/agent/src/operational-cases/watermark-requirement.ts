/**
 * Watermark is required only when the account has a brand watermark asset
 * (or the case already opted into watermarking). Missing asset must not block
 * publication.
 */
import { listAccountAssets, type DbClient } from "@agents/db";
import type { AccountAsset } from "@agents/types";

export const WATERMARK_ASSET_CANDIDATE_KEYS = [
  "listing_photo_watermark",
  "watermark",
  "watermark_png",
  "brand_watermark",
  "alebrixe_watermark",
] as const;

export const WATERMARK_IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/svg+xml",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isWatermarkImageAsset(asset: AccountAsset): boolean {
  return Boolean(asset.content_type && WATERMARK_IMAGE_MIMES.has(asset.content_type));
}

/**
 * Pure context gate: true when watermark must be applied before upload/publish.
 * Explicit `watermark_configured === false` always wins (no asset → no block).
 */
export function contextRequiresWatermark(
  context: Record<string, unknown> | null | undefined
): boolean {
  if (!isRecord(context)) return false;
  if (context.watermark_configured === false) return false;
  if (context.watermark_required === true || context.require_watermark === true) {
    return true;
  }
  if (context.watermark_configured === true) return true;
  const publicationRequirements = isRecord(context.publication_requirements)
    ? context.publication_requirements
    : {};
  if (publicationRequirements.watermark === true) return true;
  // Already started watermarking on this case.
  if (
    Array.isArray(context.watermarked_photos) &&
    context.watermarked_photos.length > 0
  ) {
    return true;
  }
  if (
    Array.isArray(context.watermark_missing) &&
    context.watermark_missing.length > 0
  ) {
    return true;
  }
  return false;
}

/**
 * Resolve whether preflight/upload should require watermarked_path.
 * Prefer durable context flags; when unknown, fall back to account assets.
 */
export async function resolveRequireWatermark(params: {
  db: DbClient;
  userId: string;
  context: Record<string, unknown> | null | undefined;
  assetKey?: string;
}): Promise<{ requireWatermark: boolean; configured: boolean | null }> {
  const context = isRecord(params.context) ? params.context : null;
  if (context?.watermark_configured === false) {
    return { requireWatermark: false, configured: false };
  }
  if (contextRequiresWatermark(context)) {
    return { requireWatermark: true, configured: true };
  }
  if (context?.watermark_configured === true) {
    return { requireWatermark: true, configured: true };
  }
  const asset = await findAccountWatermarkAsset(
    params.db,
    params.userId,
    params.assetKey
  );
  if (asset) {
    return { requireWatermark: true, configured: true };
  }
  return { requireWatermark: false, configured: false };
}

export async function findAccountWatermarkAsset(
  db: DbClient,
  userId: string,
  assetKey?: string
): Promise<AccountAsset | null> {
  const candidateKeys = Array.from(
    new Set(
      [assetKey, ...WATERMARK_ASSET_CANDIDATE_KEYS]
        .map((item) => item?.trim())
        .filter((item): item is string => Boolean(item))
    )
  );
  const directMatches = await listAccountAssets(db, {
    userId,
    assetKeys: candidateKeys,
  });
  for (const key of candidateKeys) {
    const match = directMatches.find((asset) => asset.asset_key === key);
    if (match && isWatermarkImageAsset(match)) return match;
  }

  const accountAssets = await listAccountAssets(db, { userId });
  return (
    accountAssets.find(
      (asset) =>
        asset.source_tool_id === "image_watermark" && isWatermarkImageAsset(asset)
    ) ??
    accountAssets.find(
      (asset) =>
        /watermark|marca.*agua|brand/i.test(
          `${asset.asset_key} ${asset.display_name}`
        ) && isWatermarkImageAsset(asset)
    ) ??
    null
  );
}
