// Slice 3.1-5 backfill: hashea los objetos ya almacenados de account_assets
// como versión 1. La migración 00070 creó las filas de account_asset_versions
// con content_hash null (SQL no puede leer Storage); este script descarga
// cada objeto, calcula SHA-256 y fija el hash (única mutación que el trigger
// de la tabla permite: null → valor). Idempotente: re-correrlo solo procesa
// las versiones que sigan sin hash.
//
// Usage: npx tsx scripts/backfill-account-asset-content-hashes.ts [--dry-run]
// Reads SUPABASE creds from apps/web/.env.local.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = resolve(__dirname, "..", ".env.local");

function loadEnv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return out;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

interface PendingVersion {
  id: string;
  account_asset_id: string;
  user_id: string;
  version_number: number;
  asset_key: string;
  storage_bucket: string;
  storage_path: string;
}

async function main() {
  const env = loadEnv(ENV_PATH);
  const url = env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.log(
      "backfill-account-asset-content-hashes: no Supabase creds (.env.local); skipping."
    );
    return;
  }
  const dryRun = process.argv.includes("--dry-run");
  const db = createClient(url, key);

  const { data, error } = await db
    .from("account_asset_versions")
    .select(
      "id, account_asset_id, user_id, version_number, asset_key, storage_bucket, storage_path"
    )
    .is("content_hash", null)
    .order("created_at", { ascending: true });
  if (error) throw error;
  const pending = (data ?? []) as PendingVersion[];
  console.log(`Versions without content_hash: ${pending.length}`);

  let hashed = 0;
  let missing = 0;
  let failed = 0;
  for (const version of pending) {
    const label = `${version.asset_key} v${version.version_number} (${version.storage_bucket}/${version.storage_path})`;
    const { data: blob, error: downloadError } = await db.storage
      .from(version.storage_bucket)
      .download(version.storage_path);
    if (downloadError || !blob) {
      // Objeto ausente (asset borrado de Storage sin borrar la fila, o path
      // histórico): se deja el hash en null y se reporta; no es fatal.
      console.warn(`  MISSING ${label}: ${downloadError?.message ?? "no blob"}`);
      missing += 1;
      continue;
    }
    const bytes = Buffer.from(await blob.arrayBuffer());
    const contentHash = createHash("sha256").update(bytes).digest("hex");
    if (dryRun) {
      console.log(`  DRY ${label} → ${contentHash.slice(0, 16)}…`);
      hashed += 1;
      continue;
    }

    const { data: updated, error: updateError } = await db
      .from("account_asset_versions")
      .update({ content_hash: contentHash })
      .eq("id", version.id)
      .is("content_hash", null)
      .select("id");
    if (updateError) {
      console.warn(`  FAILED ${label}: ${updateError.message}`);
      failed += 1;
      continue;
    }
    if (((updated ?? []) as Array<{ id: string }>).length !== 1) {
      console.warn(`  SKIPPED ${label}: hash ya fijado por otra corrida`);
      continue;
    }

    // Reflejar el hash vigente en el asset padre solo si su contenido actual
    // sigue siendo el de esta versión y aún no tiene hash.
    const { error: assetError } = await db
      .from("account_assets")
      .update({ content_hash: contentHash })
      .eq("id", version.account_asset_id)
      .eq("storage_bucket", version.storage_bucket)
      .eq("storage_path", version.storage_path)
      .is("content_hash", null);
    if (assetError) {
      console.warn(`  parent update failed for ${label}: ${assetError.message}`);
    }
    console.log(`  OK ${label} → ${contentHash.slice(0, 16)}…`);
    hashed += 1;
  }

  console.log(
    `Done. hashed=${hashed} missing=${missing} failed=${failed}${dryRun ? " (dry-run)" : ""}`
  );
}

main().catch((err) => {
  console.error("backfill-account-asset-content-hashes failed:", err);
  process.exit(1);
});
