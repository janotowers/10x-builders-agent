// Bootstraps an Organization from an opaque legacy organization key
// (R1 Relationship Operations, SL-0 / Technical Plan TD-1).
//
// Generic on purpose: no tenant is named here or in any migration. The operator
// supplies the legacy key and the seats; this script is the mechanism, the run
// is the pilot data.
//
// Usage:
//   npx tsx scripts/bootstrap-organization.ts --legacy-key <key> [--name "Org"]
//                                             [--member <userId>:<role>]... [--apply]
//
// Dry-run is the DEFAULT. Nothing is written without --apply, because this
// creates a tenancy boundary. Reads credentials from apps/web/.env.local.
//
// Re-running is safe: the Organization resolves through its identity binding,
// and an existing membership is left exactly as it is — this script never
// revives a deactivated member, which is a separate authorized decision.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import type { OrganizationRole } from "@agents/types";
import {
  bootstrapOrganizationFromLegacyKey,
  ensureOrganizationMembership,
  listOrganizationMemberships,
} from "@agents/db";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = resolve(__dirname, "..", "apps", "web", ".env.local");

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

const ROLES: readonly OrganizationRole[] = ["owner", "org_admin", "advisor"];

interface Args {
  legacyKey: string;
  name: string | null;
  members: Array<{ userId: string; role: OrganizationRole }>;
  apply: boolean;
}

function parseArgs(argv: string[]): Args {
  let legacyKey = "";
  let name: string | null = null;
  const members: Args["members"] = [];
  let apply = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--legacy-key") legacyKey = argv[++i] ?? "";
    else if (arg === "--name") name = argv[++i] ?? null;
    else if (arg === "--apply") apply = true;
    else if (arg === "--member") {
      const raw = argv[++i] ?? "";
      const sep = raw.lastIndexOf(":");
      const userId = sep > 0 ? raw.slice(0, sep) : raw;
      const role = (sep > 0 ? raw.slice(sep + 1) : "advisor") as OrganizationRole;
      if (!ROLES.includes(role)) {
        throw new Error(`--member role must be one of ${ROLES.join(" | ")}, got "${role}"`);
      }
      if (!userId) throw new Error("--member requires <userId>:<role>");
      members.push({ userId, role });
    }
  }

  if (!legacyKey.trim()) {
    throw new Error("--legacy-key is required (the opaque legacy organization key)");
  }
  return { legacyKey: legacyKey.trim(), name, members, apply };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const env = { ...loadEnv(ENV_PATH), ...process.env };

  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY " +
        `(looked in ${ENV_PATH} and the environment)`
    );
  }
  const db = createClient(url, serviceKey);

  console.log(`legacy key : ${args.legacyKey}`);
  console.log(`mode       : ${args.apply ? "APPLY" : "dry-run (pass --apply to write)"}`);

  // Resolve first so the operator sees create-vs-reuse before anything happens.
  const { data: existing, error: lookupError } = await db
    .from("external_identity_bindings")
    .select("organization_id")
    .eq("source_system", "traditional_gu")
    .eq("binding_kind", "legacy_organization_key")
    .eq("external_id", args.legacyKey)
    .maybeSingle();
  if (lookupError) throw lookupError;

  const existingOrgId = (existing as { organization_id: string } | null)?.organization_id;
  console.log(
    existingOrgId
      ? `organization: REUSE ${existingOrgId} (binding already exists)`
      : "organization: CREATE (no binding for this legacy key yet)"
  );

  if (!args.apply) {
    for (const member of args.members) {
      console.log(`  would ensure membership ${member.userId} as ${member.role}`);
    }
    console.log("\ndry-run complete — nothing was written.");
    return;
  }

  const organizationId = await bootstrapOrganizationFromLegacyKey(db, {
    legacyKey: args.legacyKey,
    organizationName: args.name,
  });
  console.log(`organization: ${organizationId}`);

  for (const member of args.members) {
    const membership = await ensureOrganizationMembership(db, {
      organizationId,
      userId: member.userId,
      role: member.role,
    });
    if (!membership) {
      console.log(`  membership ${member.userId}: FAILED to read back`);
      continue;
    }
    const untouched =
      membership.role !== member.role || membership.status !== "active";
    console.log(
      `  membership ${member.userId}: role=${membership.role} status=${membership.status}` +
        (untouched ? "  (pre-existing — left unchanged, reactivation is a separate decision)" : "")
    );
  }

  const all = await listOrganizationMemberships(db, organizationId, {
    includeInactive: true,
  });
  console.log(`\nfinal membership count: ${all.length}`);
  for (const m of all) {
    console.log(`  ${m.user_id}  ${m.role}  ${m.status}`);
  }
  console.log("\napply complete. Re-running is a no-op.");
}

void main().catch((error) => {
  console.error(`bootstrap-organization failed: ${(error as Error).message}`);
  process.exitCode = 1;
});
