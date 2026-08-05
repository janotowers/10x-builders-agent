/**
 * Creates, validates, records gate evidence, and (with --publish) publishes a
 * tenant-private property_optioning v2 definition that activates work/impact
 * plane semantics. Idempotent by definition hash.
 *
 * Usage (from apps/web):
 *   npx tsx scripts/publish-property-optioning-v2.ts [--user <uuid>]
 *   npx tsx scripts/publish-property-optioning-v2.ts --publish [--user <uuid>]
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createServerClient,
  getLatestPublishedDefinitionForUser,
  insertDraftDefinition,
  markDefinitionValidated,
  publishDefinition,
} from "@agents/db";
import {
  computeDefinitionHash,
  transformFlowToGraph,
} from "@agents/workflows";
import type {
  OperationalCaseFlowStep,
  WorkflowDefinition,
} from "@agents/types";
import {
  recordDefinitionValidationEvidence,
  validateDefinitionForUser,
} from "../src/lib/workflow-studio/definition-validation";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CASE_TYPE = "property_optioning";

function loadEnv(path: string): void {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
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
    if (!process.env[key]) process.env[key] = value;
  }
}

function arg(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

loadEnv(resolve(__dirname, "..", ".env.local"));

async function main() {
  const publish = process.argv.includes("--publish");
  const db = createServerClient();

  const explicitUser = arg("--user");
  const { data: recentCases, error: casesError } = await db
    .from("operational_cases")
    .select("user_id")
    .eq("case_type", CASE_TYPE)
    .order("created_at", { ascending: false })
    .limit(100);
  if (casesError) throw casesError;
  const counts = new Map<string, number>();
  for (const row of recentCases ?? []) {
    counts.set(row.user_id, (counts.get(row.user_id) ?? 0) + 1);
  }
  const userId =
    explicitUser ??
    [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!userId) throw new Error("No pilot user found; pass --user <uuid>.");

  const source = await getLatestPublishedDefinitionForUser(
    db,
    userId,
    CASE_TYPE
  );
  if (!source) throw new Error("No published property_optioning definition.");

  const { data: caseTypes, error: caseTypesError } = await db
    .from("operational_case_types")
    .select("id,user_id,visibility,operational_flow_jsonb,status")
    .eq("case_type", CASE_TYPE)
    .eq("status", "active");
  if (caseTypesError) throw caseTypesError;
  const caseType = (caseTypes ?? []).find(
    (row) => row.user_id === userId
  ) ?? (caseTypes ?? []).find((row) => row.visibility === "global");
  if (!caseType) throw new Error("No active property_optioning case type.");
  const flow = Array.isArray(caseType.operational_flow_jsonb)
    ? (caseType.operational_flow_jsonb as OperationalCaseFlowStep[])
    : [];
  if (flow.length === 0) throw new Error("property_optioning flow is empty.");

  const graph = transformFlowToGraph({ caseType: CASE_TYPE, flow });
  graph.work_templates = [
    {
      on_enter_state: "documents_received",
      work_type: "extraction_consolidation",
      required_capability: "service:extraction_consolidation",
    },
    {
      on_enter_state: "price_proposal_pending",
      work_type: "verify_valuation",
      required_capability: "agent:valuation_verifier",
    },
    {
      on_enter_state: "package_ready",
      work_type: "publication_reconciliation",
      required_capability: "service:publication_reconciliation",
    },
  ];
  const hash = computeDefinitionHash(graph);

  const { data: ownRows, error: ownError } = await db
    .from("workflow_definitions")
    .select("*")
    .eq("user_id", userId)
    .eq("case_type", CASE_TYPE)
    .order("version", { ascending: false });
  if (ownError) throw ownError;
  const identical = (ownRows ?? []).find(
    (row) => row.definition_hash === hash
  ) as WorkflowDefinition | undefined;
  if (identical?.status === "published") {
    console.log(
      `property_optioning v${identical.version} already published: ${identical.id} (${hash})`
    );
    return;
  }

  let draft = identical;
  if (!draft) {
    const maxVersion = (ownRows ?? []).reduce(
      (max, row) => Math.max(max, Number(row.version) || 0),
      0
    );
    draft = await insertDraftDefinition(db, {
      userId,
      caseType: CASE_TYPE,
      workflowKey: source.workflow_key,
      version: maxVersion + 1,
      industry: source.industry,
      domainTags: source.domain_tags,
      graph,
      definitionHash: hash,
      derivedFromDefinitionId: source.id,
      derivedFromVersion: source.version,
      businessSpec: source.business_spec_jsonb,
      implementationSpec: source.implementation_spec_jsonb,
      provenance: {
        forked_from: source.id,
        forked_from_version: source.version,
        generated_by: "publish-property-optioning-v2.ts",
        generated_at: new Date().toISOString(),
        work_impact_plane_activation: true,
      },
    });
    console.log(`created draft v${draft.version}: ${draft.id}`);
  } else {
    console.log(
      `reusing identical ${draft.status} v${draft.version}: ${draft.id}`
    );
  }

  const report = await validateDefinitionForUser(db, {
    userId,
    definition: draft,
  });
  for (const gate of report.gates) {
    console.log(`${gate.result === "pass" ? "PASS" : "FAIL"} ${gate.gate}`);
    if (gate.result === "fail") console.log(JSON.stringify(gate.detail, null, 2));
  }
  if (!report.ok) {
    throw new Error(`Definition ${draft.id} failed validation; not published.`);
  }

  await recordDefinitionValidationEvidence(db, {
    userId,
    definition: draft,
    gates: report.gates,
  });
  if (draft.status === "draft") {
    draft = await markDefinitionValidated(db, draft.id);
  }
  console.log(
    `validated v${draft.version}: templates=${draft.graph_jsonb.work_templates.length}, hash=${hash}`
  );

  if (!publish) {
    console.log("Dry run complete. Re-run with --publish for the immutable flip.");
    return;
  }

  // Same governance as the Studio publish action: gates are run in this
  // invocation and their evidence is recorded immediately before the flip.
  const published = await publishDefinition(db, draft.id, userId);
  console.log(
    `PUBLISHED property_optioning v${published.version}: ${published.id}`
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
