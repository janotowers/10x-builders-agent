// Fija workflow_enforcement_mode para todos los tenants que tienen casos
// operativos. Advisory solo registra divergencias; nunca bloquea.
//
// Uso: npx tsx apps/web/scripts/set-workflow-enforcement.ts --mode advisory
//      npx tsx apps/web/scripts/set-workflow-enforcement.ts --mode enforcing
//      npx tsx apps/web/scripts/set-workflow-enforcement.ts --mode off

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const MODES = ["off", "advisory", "enforcing"] as const;

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
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[line.slice(0, idx).trim()] = value;
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const modeArg = args.indexOf("--mode");
  const mode = modeArg >= 0 ? args[modeArg + 1] : undefined;
  if (!mode || !MODES.includes(mode as (typeof MODES)[number])) {
    console.log(`Uso: --mode <${MODES.join("|")}>`);
    process.exit(1);
  }

  const env = loadEnv(ENV_PATH);
  const url = env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.log("set-workflow-enforcement: sin credenciales Supabase (.env.local).");
    return;
  }
  const db = createClient(url, key);

  const { data: cases, error: casesError } = await db
    .from("operational_cases")
    .select("user_id");
  if (casesError) throw casesError;
  const userIds = [...new Set((cases ?? []).map((c) => c.user_id as string))];
  if (userIds.length === 0) {
    console.log("No hay tenants con casos operativos; nada que actualizar.");
    return;
  }

  for (const userId of userIds) {
    const { error } = await db.from("account_feature_flags").upsert(
      {
        user_id: userId,
        flag_key: "workflow_enforcement_mode",
        enabled: mode !== "off",
        value_text: mode,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,flag_key" }
    );
    if (error) throw error;
  }

  console.log(
    `workflow_enforcement_mode="${mode}" fijado para ${userIds.length} tenant(s).`
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
