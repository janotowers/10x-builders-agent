#!/usr/bin/env node
/**
 * CI validator for immutable OpenRouter price catalog snapshots.
 *
 * Checks:
 * - every catalogs/*.json has version === filename stem
 * - active catalog import target exists and covers required model ids
 * - model-price-catalog.ts MODEL_PRICE_CATALOG_VERSION matches active file
 * - default model constants in model.ts / embeddings.ts are covered
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CATALOGS_DIR = path.join(
  ROOT,
  "packages",
  "agent",
  "src",
  "usage",
  "catalogs"
);
const CATALOG_TS = path.join(
  ROOT,
  "packages",
  "agent",
  "src",
  "usage",
  "model-price-catalog.ts"
);
const MODEL_TS = path.join(ROOT, "packages", "agent", "src", "model.ts");
const EMBEDDINGS_TS = path.join(
  ROOT,
  "packages",
  "agent",
  "src",
  "embeddings.ts"
);

const REQUIRED_FALLBACK_IDS = [
  "openai/gpt-5.4-mini",
  "openai/gpt-4.1-mini",
  "openai/gpt-4o-mini",
  "anthropic/claude-haiku-4.5",
  "anthropic/claude-opus-5",
  "google/gemini-embedding-001",
];

function fail(message) {
  console.error(`[validate-model-price-catalog] ${message}`);
  process.exitCode = 1;
}

function read(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function extractDefaultModelIds(source) {
  const ids = new Set();
  // Allow multiline: `export const DEFAULT_FOO =\n  "model/id";`
  const re =
    /export const DEFAULT_[A-Z0-9_]+\s*=\s*"([^"]+)"/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    ids.add(match[1]);
  }
  return [...ids];
}

function main() {
  if (!fs.existsSync(CATALOGS_DIR)) {
    fail(`missing catalogs dir: ${CATALOGS_DIR}`);
    return;
  }

  const files = fs
    .readdirSync(CATALOGS_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort();
  if (files.length === 0) {
    fail("no catalog snapshots found");
    return;
  }

  /** @type {Map<string, any>} */
  const snapshots = new Map();
  for (const name of files) {
    const full = path.join(CATALOGS_DIR, name);
    let json;
    try {
      json = JSON.parse(read(full));
    } catch (error) {
      fail(`${name}: invalid JSON (${error.message})`);
      continue;
    }
    const stem = name.replace(/\.json$/, "");
    if (json.version !== stem) {
      fail(`${name}: version "${json.version}" !== filename stem "${stem}"`);
    }
    if (!json.source_url || !json.retrieved_at || !json.models) {
      fail(`${name}: missing source_url / retrieved_at / models`);
    }
    if (typeof json.models !== "object" || Array.isArray(json.models)) {
      fail(`${name}: models must be an object`);
      continue;
    }
    for (const [modelId, price] of Object.entries(json.models)) {
      if (
        typeof price?.inputUsdPerMTok !== "number" ||
        typeof price?.outputUsdPerMTok !== "number" ||
        !Number.isFinite(price.inputUsdPerMTok) ||
        !Number.isFinite(price.outputUsdPerMTok) ||
        price.inputUsdPerMTok < 0 ||
        price.outputUsdPerMTok < 0
      ) {
        fail(`${name}: invalid prices for ${modelId}`);
      }
    }
    snapshots.set(stem, json);
  }

  const catalogTs = read(CATALOG_TS);
  const activeMatch = catalogTs.match(
    /import catalogActive from "\.\/catalogs\/([^"]+)\.json"/
  );
  if (!activeMatch) {
    fail("model-price-catalog.ts: missing catalogActive import");
    return;
  }
  const activeVersion = activeMatch[1];
  const active = snapshots.get(activeVersion);
  if (!active) {
    fail(`active catalog ${activeVersion}.json not found`);
    return;
  }

  const versionConst = catalogTs.match(
    /export const MODEL_PRICE_CATALOG_VERSION(?:: string)?\s*=\s*catalogActive\.version/
  );
  if (!versionConst) {
    fail(
      "MODEL_PRICE_CATALOG_VERSION must be bound to catalogActive.version (no hardcoded string)"
    );
  }

  for (const id of REQUIRED_FALLBACK_IDS) {
    if (!active.models[id]) {
      fail(`active catalog ${activeVersion} missing required model ${id}`);
    }
  }

  const defaultIds = [
    ...extractDefaultModelIds(read(MODEL_TS)),
    ...extractDefaultModelIds(read(EMBEDDINGS_TS)),
  ];
  for (const id of defaultIds) {
    if (!active.models[id]) {
      fail(
        `default model "${id}" is not covered by active catalog ${activeVersion}`
      );
    }
  }

  // Historical snapshot used by early Slice 0.4 rows must remain readable.
  if (!snapshots.has("2026-07-29.1")) {
    fail("historical snapshot 2026-07-29.1.json is required (append-only audit)");
  }

  if (process.exitCode) {
    console.error("[validate-model-price-catalog] FAILED");
    process.exit(process.exitCode);
  }
  console.log(
    `[validate-model-price-catalog] ok — ${files.length} snapshots, active=${activeVersion}, defaults=${defaultIds.length}`
  );
}

main();
