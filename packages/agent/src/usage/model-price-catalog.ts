/**
 * Versioned model-price catalog (flexible-workflows plan, Slice 0.4 / 0.4.1).
 *
 * Estimates are a FALLBACK / comparison reference — never billing. Prefer
 * OpenRouter `usage.cost` when present. Each estimate is stamped with
 * `pricing_version` so historical rows stay reproducible against immutable
 * snapshot files under `./catalogs/`.
 *
 * Maintenance:
 * - Never edit an existing snapshot.
 * - Generate a new version: `node scripts/generate-model-price-catalog.mjs --version YYYY-MM-DD.N`
 * - CI validates structure + default-model coverage via
 *   `scripts/validate-model-price-catalog.mjs`.
 */
import catalogActive from "./catalogs/2026-07-29.2.json";
import catalog202607291 from "./catalogs/2026-07-29.1.json";

export interface ModelPrice {
  /** USD per 1M input tokens (uncached). */
  inputUsdPerMTok: number;
  /** USD per 1M output tokens. */
  outputUsdPerMTok: number;
  /** USD per 1M cached-input / cache-read tokens, when known. */
  cacheReadUsdPerMTok?: number;
  /** USD per 1M cache-write tokens, when known. */
  cacheWriteUsdPerMTok?: number;
}

export interface ModelPriceCatalogSnapshot {
  version: string;
  source_url: string;
  retrieved_at: string;
  notes?: string;
  models: Record<string, ModelPrice>;
}

const SNAPSHOTS: Record<string, ModelPriceCatalogSnapshot> = {
  [catalog202607291.version]: catalog202607291 as ModelPriceCatalogSnapshot,
  [catalogActive.version]: catalogActive as ModelPriceCatalogSnapshot,
};

/** Active catalog version written onto new estimated rows. */
export const MODEL_PRICE_CATALOG_VERSION: string = catalogActive.version;

export function listModelPriceCatalogVersions(): string[] {
  return Object.keys(SNAPSHOTS).sort();
}

export function getCatalogSnapshot(
  version: string = MODEL_PRICE_CATALOG_VERSION
): ModelPriceCatalogSnapshot | null {
  return SNAPSHOTS[version] ?? null;
}

export function getModelPrice(
  modelId: string,
  version: string = MODEL_PRICE_CATALOG_VERSION
): ModelPrice | null {
  return getCatalogSnapshot(version)?.models[modelId] ?? null;
}

/**
 * Estimated cost in integer micro-USD, or `null` when the model is not in
 * the catalog or no token counts are available.
 *
 * When `cachedInputTokens` and a cache-read price are available, cached
 * tokens are billed at the cache-read rate and the remainder at input.
 */
export function estimateCostMicroUsd(
  modelId: string,
  tokens: {
    inputTokens?: number | null;
    outputTokens?: number | null;
    cachedInputTokens?: number | null;
  },
  version: string = MODEL_PRICE_CATALOG_VERSION
): number | null {
  const price = getModelPrice(modelId, version);
  if (!price) return null;
  const input = tokens.inputTokens ?? null;
  const output = tokens.outputTokens ?? null;
  if (input == null && output == null) return null;

  const cachedRaw = tokens.cachedInputTokens ?? null;
  const cached =
    cachedRaw != null &&
    input != null &&
    price.cacheReadUsdPerMTok != null &&
    Number.isFinite(price.cacheReadUsdPerMTok)
      ? Math.min(Math.max(0, cachedRaw), input)
      : 0;
  const uncachedInput = Math.max(0, (input ?? 0) - cached);

  const usd =
    (uncachedInput * price.inputUsdPerMTok +
      cached * (price.cacheReadUsdPerMTok ?? price.inputUsdPerMTok) +
      (output ?? 0) * price.outputUsdPerMTok) /
    1_000_000;
  return Math.round(usd * 1_000_000);
}

/** Default model ids that MUST appear in the active catalog (CI guard). */
export const CATALOG_REQUIRED_MODEL_IDS = [
  "openai/gpt-5.4-mini",
  "openai/gpt-4.1-mini",
  "openai/gpt-4o-mini",
  "anthropic/claude-haiku-4.5",
  "google/gemini-embedding-001",
] as const;
