#!/usr/bin/env node
/**
 * Generate an immutable model-price catalog snapshot from OpenRouter's
 * public model APIs (chat + embeddings).
 *
 * Usage:
 *   node scripts/generate-model-price-catalog.mjs --version 2026-07-30.1
 *   node scripts/generate-model-price-catalog.mjs --version 2026-07-30.1 --dry-run
 *
 * OpenRouter returns per-token USD prices; we store USD per 1M tokens.
 * Never edit an existing snapshot — always bump --version.
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

const REQUIRED_MODEL_IDS = [
  "openai/gpt-5.4-mini",
  "openai/gpt-4.1-mini",
  "openai/gpt-4o-mini",
  "anthropic/claude-haiku-4.5",
  "anthropic/claude-opus-5",
  "google/gemini-embedding-001",
];

function parseArgs(argv) {
  let version = null;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--version") {
      version = argv[++i];
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: node scripts/generate-model-price-catalog.mjs --version YYYY-MM-DD.N [--dry-run]"
      );
      process.exit(0);
    }
  }
  if (!version || !/^\d{4}-\d{2}-\d{2}\.\d+$/.test(version)) {
    console.error(
      "Missing/invalid --version. Expected YYYY-MM-DD.N (e.g. 2026-07-29.2)"
    );
    process.exit(1);
  }
  return { version, dryRun };
}

function roundPrice(n) {
  // Avoid IEEE noise like 0.39999999999999997 while keeping useful precision.
  return Math.round(n * 1e6) / 1e6;
}

function perTokenToPerMTok(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return roundPrice(n * 1_000_000);
}

function modelEntry(pricing) {
  const input = perTokenToPerMTok(pricing?.prompt);
  const output = perTokenToPerMTok(pricing?.completion ?? 0);
  if (input == null || output == null) return null;
  const entry = {
    inputUsdPerMTok: input,
    outputUsdPerMTok: output,
  };
  const cacheRead = perTokenToPerMTok(pricing?.input_cache_read);
  const cacheWrite = perTokenToPerMTok(pricing?.input_cache_write);
  if (cacheRead != null) entry.cacheReadUsdPerMTok = cacheRead;
  if (cacheWrite != null) entry.cacheWriteUsdPerMTok = cacheWrite;
  return entry;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} → HTTP ${response.status}`);
  }
  return response.json();
}

async function main() {
  const { version, dryRun } = parseArgs(process.argv.slice(2));
  const outPath = path.join(CATALOGS_DIR, `${version}.json`);
  if (fs.existsSync(outPath) && !dryRun) {
    console.error(
      `Refusing to overwrite existing snapshot ${outPath}. Bump --version.`
    );
    process.exit(1);
  }

  const [chat, embeddings] = await Promise.all([
    fetchJson("https://openrouter.ai/api/v1/models"),
    fetchJson("https://openrouter.ai/api/v1/embeddings/models"),
  ]);
  const byId = new Map();
  for (const row of [...(chat.data ?? []), ...(embeddings.data ?? [])]) {
    if (row?.id) byId.set(row.id, row);
  }

  const models = {};
  const missing = [];
  for (const id of REQUIRED_MODEL_IDS) {
    const row = byId.get(id);
    const entry = row ? modelEntry(row.pricing) : null;
    if (!entry) {
      missing.push(id);
      continue;
    }
    models[id] = entry;
  }
  if (missing.length > 0) {
    console.error("Missing required models/prices:", missing.join(", "));
    process.exit(1);
  }

  const snapshot = {
    version,
    source_url:
      "https://openrouter.ai/api/v1/models + https://openrouter.ai/api/v1/embeddings/models",
    retrieved_at: new Date().toISOString(),
    notes:
      "Generated from OpenRouter public model APIs. Prices are USD per 1M tokens. Immutable — bump version for any change.",
    models,
  };

  const body = `${JSON.stringify(snapshot, null, 2)}\n`;
  if (dryRun) {
    process.stdout.write(body);
    return;
  }
  fs.mkdirSync(CATALOGS_DIR, { recursive: true });
  fs.writeFileSync(outPath, body, "utf8");
  console.log(`Wrote ${outPath}`);
  console.log(
    "Remember: set MODEL_PRICE_CATALOG_VERSION / import the new snapshot in model-price-catalog.ts"
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
