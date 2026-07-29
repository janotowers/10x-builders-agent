#!/usr/bin/env node
/**
 * Optional drift check against live OpenRouter prices.
 *
 * NOT wired into CI (external dependency). Run manually / on a schedule:
 *   node scripts/check-model-price-catalog-drift.mjs
 *
 * Exit 1 when active catalog prices differ from OpenRouter by more than
 * the absolute tolerance (default $0.000001 / 1M tok after rounding).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CATALOG_TS = path.join(
  ROOT,
  "packages",
  "agent",
  "src",
  "usage",
  "model-price-catalog.ts"
);
const CATALOGS_DIR = path.join(
  ROOT,
  "packages",
  "agent",
  "src",
  "usage",
  "catalogs"
);

const TOLERANCE = 1e-6;

function roundPrice(n) {
  return Math.round(n * 1e6) / 1e6;
}

function perTokenToPerMTok(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return roundPrice(n * 1_000_000);
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`);
  return response.json();
}

async function main() {
  const catalogTs = fs.readFileSync(CATALOG_TS, "utf8");
  const activeMatch = catalogTs.match(
    /import catalogActive from "\.\/catalogs\/([^"]+)\.json"/
  );
  if (!activeMatch) {
    console.error("Could not resolve active catalog import");
    process.exit(1);
  }
  const activeVersion = activeMatch[1];
  const active = JSON.parse(
    fs.readFileSync(path.join(CATALOGS_DIR, `${activeVersion}.json`), "utf8")
  );

  const [chat, embeddings] = await Promise.all([
    fetchJson("https://openrouter.ai/api/v1/models"),
    fetchJson("https://openrouter.ai/api/v1/embeddings/models"),
  ]);
  const byId = new Map();
  for (const row of [...(chat.data ?? []), ...(embeddings.data ?? [])]) {
    if (row?.id) byId.set(row.id, row);
  }

  let drifted = 0;
  for (const [modelId, price] of Object.entries(active.models)) {
    const live = byId.get(modelId);
    if (!live) {
      console.log(`MISSING_LIVE ${modelId}`);
      drifted += 1;
      continue;
    }
    const liveInput = perTokenToPerMTok(live.pricing?.prompt);
    const liveOutput = perTokenToPerMTok(live.pricing?.completion ?? 0);
    const checks = [
      ["inputUsdPerMTok", price.inputUsdPerMTok, liveInput],
      ["outputUsdPerMTok", price.outputUsdPerMTok, liveOutput],
    ];
    for (const [field, ours, theirs] of checks) {
      if (theirs == null || Math.abs(ours - theirs) > TOLERANCE) {
        console.log(
          `DRIFT ${modelId}.${field}: catalog=${ours} live=${theirs}`
        );
        drifted += 1;
      }
    }
  }

  if (drifted > 0) {
    console.error(
      `[check-model-price-catalog-drift] ${drifted} drift(s) vs OpenRouter. Generate a new snapshot.`
    );
    process.exit(1);
  }
  console.log(
    `[check-model-price-catalog-drift] ok — active=${activeVersion} matches OpenRouter`
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
