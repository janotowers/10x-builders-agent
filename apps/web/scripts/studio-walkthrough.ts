/**
 * Headless Studio walkthrough (Phase 4 exit check — script layer).
 *
 * Mirrors the Studio server actions: fork → validate (+ simulation gate) →
 * evidence → mark validated → optional publish → create a synthetic lab case
 * pinned to the resulting definition.
 *
 * This does NOT replace the human UI walkthrough (non-engineer create/fork/
 * validate/simulate/publish in the browser). Print the checklist at the end.
 *
 * Synthetic cases MUST set created_from=case_type_settings_test + test_mode so
 * production cron suppresses them (isCronSuppressedOperationalCase).
 *
 * Usage (from apps/web):
 *   npx tsx scripts/studio-walkthrough.ts [--user <uuid>] [--case-type property_optioning]
 *   npx tsx scripts/studio-walkthrough.ts --publish [--user <uuid>]
 *   npx tsx scripts/studio-walkthrough.ts --reuse-fork [--definition <id>]
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

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
  const reuseFork = process.argv.includes("--reuse-fork");
  const caseType = arg("--case-type") ?? "property_optioning";

  const {
    createServerClient,
    createOperationalCase,
    forkDefinition,
    getLatestPublishedDefinitionForUser,
    getWorkflowDefinitionById,
    insertOperationalCaseEvent,
    listWorkflowDefinitionsVisibleToUser,
    markDefinitionValidated,
    publishDefinition,
  } = await import("@agents/db");
  const {
    recordDefinitionValidationEvidence,
    validateDefinitionForUser,
  } = await import("../src/lib/workflow-studio/definition-validation");

  const db = createServerClient();

  const explicitUser = arg("--user");
  const { data: recentCases, error: casesError } = await db
    .from("operational_cases")
    .select("user_id")
    .eq("case_type", caseType)
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

  const sourceId = arg("--definition");
  const source = sourceId
    ? await getWorkflowDefinitionById(db, sourceId)
    : await getLatestPublishedDefinitionForUser(db, userId, caseType);
  if (!source) {
    throw new Error(
      `No published ${caseType} definition to fork; pass --definition <id>.`
    );
  }
  if (source.status !== "published") {
    throw new Error(
      `Source definition ${source.id} is ${source.status}; fork requires published.`
    );
  }
  console.log(
    `1) source published ${source.workflow_key} v${source.version}: ${source.id}`
  );

  const visible = await listWorkflowDefinitionsVisibleToUser(db, userId);
  const own = visible.filter((row) => row.user_id === userId);
  const identicalFork = own.find(
    (row) =>
      (row.status === "draft" || row.status === "validated") &&
      row.derived_from_definition_id === source.id &&
      row.definition_hash === source.definition_hash
  );

  let draft =
    reuseFork && identicalFork
      ? identicalFork
      : await forkDefinition(db, userId, source.id);
  if (reuseFork && identicalFork) {
    console.log(
      `2) reusing existing fork v${draft.version} (${draft.status}): ${draft.id}`
    );
  } else {
    console.log(`2) forked draft v${draft.version}: ${draft.id}`);
  }

  const report = await validateDefinitionForUser(db, {
    userId,
    definition: draft,
  });
  for (const gate of report.gates) {
    const mark = gate.result === "pass" ? "PASS" : "FAIL";
    console.log(`3) ${mark} ${gate.gate}`);
    if (gate.result === "fail") {
      console.log(JSON.stringify(gate.detail, null, 2));
    }
  }
  for (const outcome of report.simulationOutcomes ?? []) {
    console.log(
      `3b) simulation ${outcome.scenario}: ok=${outcome.ok} terminal=${outcome.terminalStep ?? "-"} expected=${outcome.expectedTerminalStep ?? "-"}`
    );
  }
  if (!report.ok) {
    throw new Error(`Definition ${draft.id} failed validation/simulation.`);
  }

  await recordDefinitionValidationEvidence(db, {
    userId,
    definition: draft,
    gates: report.gates,
  });
  if (draft.status === "draft") {
    draft = await markDefinitionValidated(db, draft.id);
  }
  console.log(`4) validated + evidence recorded: ${draft.id} (${draft.status})`);

  if (publish) {
    draft = await publishDefinition(db, draft.id, userId);
    console.log(`5) PUBLISHED v${draft.version}: ${draft.id}`);
  } else {
    console.log(
      "5) dry-run: skip publish (re-run with --publish for immutable flip)"
    );
  }

  const { data: caseTypes, error: caseTypesError } = await db
    .from("operational_case_types")
    .select("id,user_id,visibility,case_type,status")
    .eq("case_type", caseType)
    .eq("status", "active");
  if (caseTypesError) throw caseTypesError;
  const caseTypeRow =
    (caseTypes ?? []).find((row) => row.user_id === userId) ??
    (caseTypes ?? []).find((row) => row.visibility === "global");
  if (!caseTypeRow) {
    throw new Error(`No active case type for ${caseType}.`);
  }

  // Must carry settings-test markers so isCronSuppressedOperationalCase
  // skips this row. A bare controlled_test flag is NOT enough (live incident:
  // d900718d was cron-tickeado y disparó Telegram real).
  const opCase = await createOperationalCase(db, {
    userId,
    caseTypeId: caseTypeRow.id,
    caseType: caseTypeRow.case_type,
    status: "active",
    currentStep: "intake",
    nextActionAt: null,
    context: {
      created_from: "case_type_settings_test",
      test_mode: true,
      controlled_test: true,
      controlled_test_status: "ready",
      studio_walkthrough_at: new Date().toISOString(),
      studio_walkthrough_definition_id: draft.id,
    },
    workflowDefinition: draft,
  });
  await insertOperationalCaseEvent(db, {
    caseId: opCase.id,
    eventType: "state_changed",
    actor: "user",
    payload: {
      source: "studio_walkthrough",
      kind: "studio_walkthrough_synthetic_case",
      workflow_definition_id: draft.id,
      workflow_definition_version: draft.version,
      status: draft.status,
      test_mode: true,
      created_from: "case_type_settings_test",
    },
  });
  console.log(
    `6) synthetic case=${opCase.id} pinned def=${draft.id} v${draft.version} (${draft.status}) step=${opCase.current_step} (cron-suppressed settings test)`
  );

  console.log(`
── Human UI checklist (Phase 4 exit — non-engineer) ──
Open /operations/workflows as a non-engineer pilot user and confirm:
  [ ] Catálogo: ver la definición publicada de ${caseType}
  [ ] "Crear versión propia" (fork) abre Diseño con un borrador
  [ ] Validar: gates verdes + simulación happy-path
  [ ] Publicar (acto humano) solo con gates verdes
  [ ] Lab N0: selector "Definición del flujo" pinnea el borrador/versión
  [ ] Caso sintético corre con la definición pinneada (este script creó ${opCase.id})
Script layer alone does NOT close the exit check; tick the boxes in the UI.
`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
