import assert from "node:assert/strict";
import {
  CATALOG_REQUIRED_MODEL_IDS,
  MODEL_PRICE_CATALOG_VERSION,
  estimateCostMicroUsd,
  getCatalogSnapshot,
  getModelPrice,
  listModelPriceCatalogVersions,
} from "./model-price-catalog";
import {
  DEFAULT_BUSINESS_BRAIN_REVIEWER_MODEL_ID,
  DEFAULT_COMPACTION_MODEL_ID,
  DEFAULT_IMAGE_VISION_MODEL_ID,
  DEFAULT_LISTING_COPY_MODEL_ID,
  DEFAULT_MAIN_AGENT_MODEL_ID,
  DEFAULT_OPERATIONAL_CONVERSATION_CLASSIFIER_MODEL_ID,
  DEFAULT_SKILL_SELECTOR_MODEL_ID,
} from "../model";
import { DEFAULT_EMBEDDING_MODEL } from "../embeddings";

function testActiveCatalogCoversDefaults(): void {
  assert.equal(MODEL_PRICE_CATALOG_VERSION, "2026-07-29.2");
  const active = getCatalogSnapshot();
  assert.ok(active);
  assert.equal(active!.version, MODEL_PRICE_CATALOG_VERSION);

  const defaults = [
    DEFAULT_MAIN_AGENT_MODEL_ID,
    DEFAULT_COMPACTION_MODEL_ID,
    DEFAULT_SKILL_SELECTOR_MODEL_ID,
    DEFAULT_BUSINESS_BRAIN_REVIEWER_MODEL_ID,
    DEFAULT_OPERATIONAL_CONVERSATION_CLASSIFIER_MODEL_ID,
    DEFAULT_IMAGE_VISION_MODEL_ID,
    DEFAULT_LISTING_COPY_MODEL_ID,
    DEFAULT_EMBEDDING_MODEL,
  ];
  for (const id of defaults) {
    assert.ok(getModelPrice(id), `missing catalog price for default ${id}`);
  }
  for (const id of CATALOG_REQUIRED_MODEL_IDS) {
    assert.ok(active!.models[id], `required model missing: ${id}`);
  }
}

function testHistoricalSnapshotImmutablePrices(): void {
  const versions = listModelPriceCatalogVersions();
  assert.ok(versions.includes("2026-07-29.1"));
  assert.ok(versions.includes("2026-07-29.2"));

  const old = getCatalogSnapshot("2026-07-29.1")!;
  assert.equal(old.models["openai/gpt-5.4-mini"]!.inputUsdPerMTok, 0.6);
  assert.equal(old.models["openai/gpt-5.4-mini"]!.outputUsdPerMTok, 2.4);

  const neu = getCatalogSnapshot("2026-07-29.2")!;
  assert.equal(neu.models["openai/gpt-5.4-mini"]!.inputUsdPerMTok, 0.75);
  assert.equal(neu.models["openai/gpt-5.4-mini"]!.outputUsdPerMTok, 4.5);

  // Reproduce a historical estimate exactly from its pricing_version.
  assert.equal(
    estimateCostMicroUsd(
      "openai/gpt-5.4-mini",
      { inputTokens: 10_000, outputTokens: 0 },
      "2026-07-29.1"
    ),
    6000
  );
  assert.equal(
    estimateCostMicroUsd(
      "openai/gpt-5.4-mini",
      { inputTokens: 10_000, outputTokens: 0 },
      "2026-07-29.2"
    ),
    7500
  );
}

function testUnknownVersionAndModel(): void {
  assert.equal(getCatalogSnapshot("1999-01-01.1"), null);
  assert.equal(getModelPrice("acme/nope"), null);
  assert.equal(
    estimateCostMicroUsd("openai/gpt-4o-mini", {
      inputTokens: null,
      outputTokens: null,
    }),
    null
  );
}

function main(): void {
  testActiveCatalogCoversDefaults();
  testHistoricalSnapshotImmutablePrices();
  testUnknownVersionAndModel();
  console.log("model-price-catalog.selftest: all 3 cases passed");
}

main();
