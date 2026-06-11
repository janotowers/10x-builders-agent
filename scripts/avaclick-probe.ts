import fs from "node:fs";
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import {
  getAvaclickValuation,
  testAvaclickCredentials,
} from "../packages/agent/src/tools/avaclick";

function loadEnv(path: string) {
  if (!fs.existsSync(path)) return;
  for (const line of fs.readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || m[1].startsWith("#")) continue;
    let v = m[2].trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    process.env[m[1]] = process.env[m[1]] || v;
  }
}

function decryptToken(stored: string) {
  const [ivHex, tagHex, ctHex] = stored.split(":");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    Buffer.from(process.env.ENCRYPTION_KEY!, "hex"),
    Buffer.from(ivHex, "hex")
  );
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return decipher.update(ctHex, "hex", "utf8") + decipher.final("utf8");
}

async function main() {
loadEnv("apps/web/.env.local");

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

const { data, error } = await db
  .from("account_tool_secrets")
  .select(
    "config_jsonb,encrypted_secret_jsonb,status,last_checked_at,last_error,updated_at"
  )
  .eq("provider", "avaclick")
  .order("updated_at", { ascending: false })
  .limit(1)
  .maybeSingle();

if (error) throw error;
if (!data) {
  console.log(JSON.stringify({ error: "no_avaclick_secret" }, null, 2));
  process.exit(0);
}

const secret = JSON.parse(decryptToken(data.encrypted_secret_jsonb as string)) as {
  email?: string;
  password?: string;
};

const creds = {
  apiUrl:
    (data.config_jsonb as { api_url?: string })?.api_url ||
    "https://avaclick.app/Apiv2/Avaluo",
  companyName:
    (data.config_jsonb as { company_name?: string })?.company_name || "",
  email: secret.email || "",
  password: secret.password || "",
  source: "account" as const,
};

console.log(
  JSON.stringify(
    {
      account: {
        status: data.status,
        last_checked_at: data.last_checked_at,
        last_error: data.last_error,
        updated_at: data.updated_at,
        companyName: creds.companyName,
        emailPreview: creds.email ? `${creds.email.slice(0, 3)}***` : null,
        apiUrl: creds.apiUrl,
      },
    },
    null,
    2
  )
);

const credentialTest = await testAvaclickCredentials(creds);
console.log(JSON.stringify({ credentialTest }, null, 2));

const valuation = await getAvaclickValuation(
  {
    customer_name: "Prueba Avaclick",
    customer_email: creds.email,
    customer_phone: "1234567",
    property_type: "house",
    latitude: 20.674,
    longitude: -103.347,
    state_name: "Jalisco",
    municipality_name: "Guadalajara",
    neighborhood_name: "Americana",
    zip_code: "44160",
    street: "Av. Vallarta",
    exterior_number: "100",
    land_area_m2: 120,
    construction_area_m2: 100,
    age_years: 10,
    parking_spaces: 2,
    bedrooms: 3,
    full_bathrooms: 2,
    half_bathrooms: 1,
    floors: 2,
    conservation: "good",
    private_amenities: [],
    common_amenities: [],
  },
  creds
);

console.log(JSON.stringify({ valuation }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
});
