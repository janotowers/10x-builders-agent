// Soak vivo del plano de trabajo (Slice 2.6, parte pendiente-de-entorno).
//
// Corre contra la base real (migración 00069 aplicada) el MISMO pass de
// producción (`runWorkPlaneCronPass`) con dos invocaciones concurrentes por
// ronda ("two runners via repeated cron invocations"):
//   1. Verifica que las tablas del work plane existen.
//   2. Habilita `work_plane_v2` para el tenant piloto.
//   3. Publica definiciones sintéticas privadas (rama paralela + fan-in;
//      variante con aprobación humana; variante que agota max_attempts) y
//      crea casos test pinneados (next_action_at en el futuro: el loop v1
//      del cron jamás los toca).
//   4. Siembra un claim stale de un runner "muerto" (lease de 1.2s).
//   5. Rondas de dos passes concurrentes hasta drenar; entre rondas el
//      operador sintético aprueba items en review (valida finding 20 en vivo).
//   6. Asserts: cero double-claims, claim_expired visible, drenado, fan-in
//      tras las ramas, blocked + notificación, casos en terminal con la misma
//      secuencia de estados, evento state_changed del wrapper advised.
//   7. Cleanup: casos soak → completed (usa --keep para conservarlos activos).
//
// Uso: npx tsx apps/web/scripts/work-plane-soak.ts [--user <uuid>] [--keep]
// Credenciales: apps/web/.env.local (NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import {
  approveReviewedItem,
  claimNextReady,
  createWorkItemsFromTemplates,
  insertDraftDefinition,
  propagateReadiness,
  publishDefinition,
  type DbClient,
} from "@agents/db";
import { computeDefinitionHash } from "@agents/workflows";
import type { WorkflowGraph, WorkItem, WorkItemAttempt } from "@agents/types";
import { runWorkPlaneCronPass } from "../src/lib/operational-cases/work-plane-tick";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = resolve(__dirname, "..", ".env.local");

const CASE_TYPE = "work_plane_soak_synthetic";
const MAX_ROUNDS = 15;

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

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function ok(message: string): void {
  console.log(`✓ ${message}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ============================================================
// Grafos sintéticos (mismos fixtures que el soak selftest, con work_types
// del DETERMINISTIC_REGISTRY de producción)
// ============================================================

function soakGraph(variant: "standard" | "human" | "blocked"): WorkflowGraph {
  if (variant === "blocked") {
    return {
      states: [
        { key: "collecting", kind: "operational" },
        { key: "closed", kind: "terminal" },
      ],
      transitions: [
        {
          from: "collecting",
          to: "closed",
          guards: [],
          authorized_proposers: ["runtime"],
          approval_required: null,
        },
      ],
      step_bindings: [],
      work_templates: [
        {
          on_enter_state: "collecting",
          // Capability sintética resoluble (perfil work_plane_synthetic,
          // 00072) pero work_type NO registrado: cada intento falla
          // explícito hasta agotar max_attempts → blocked + notificación.
          work_type: "work_plane_synthetic_unregistered",
          required_capability: "synthetic_work",
        },
      ],
      postconditions: [],
      approvals: [],
      impact_dependencies: {},
      completion: { terminal_states: ["closed"], required_evidence: [] },
    } as WorkflowGraph;
  }

  const producing: WorkflowGraph["work_templates"] = [
    {
      on_enter_state: "producing",
      work_type: "work_plane_synthetic_branch_a",
      required_capability: "synthetic_work",
    },
    {
      on_enter_state: "producing",
      work_type: "work_plane_synthetic_branch_b",
      required_capability: "synthetic_work",
    },
    {
      on_enter_state: "producing",
      work_type: "work_plane_synthetic_fan_in",
      required_capability: "synthetic_work",
      depends_on: [
        "work_plane_synthetic_branch_a",
        "work_plane_synthetic_branch_b",
      ],
    },
  ];
  if (variant === "human") {
    producing.push({
      on_enter_state: "producing",
      work_type: "work_plane_synthetic_approval",
      required_capability: "human",
      depends_on: ["work_plane_synthetic_fan_in"],
    });
  }
  return {
    states: [
      { key: "collecting", kind: "operational" },
      { key: "producing", kind: "operational" },
      { key: "closed", kind: "terminal" },
    ],
    transitions: [
      {
        from: "collecting",
        to: "producing",
        guards: [],
        authorized_proposers: ["runtime"],
        approval_required: null,
      },
      {
        from: "producing",
        to: "closed",
        guards: [],
        authorized_proposers: ["runtime"],
        approval_required: null,
      },
    ],
    step_bindings: [],
    work_templates: [
      {
        on_enter_state: "collecting",
        work_type: "work_plane_synthetic_echo",
        required_capability: "synthetic_work",
      },
      ...producing,
    ],
    postconditions: [],
    approvals: [],
    impact_dependencies: {},
    completion: { terminal_states: ["closed"], required_evidence: [] },
  } as WorkflowGraph;
}

// ============================================================
// Main
// ============================================================

async function main() {
  const env = loadEnv(ENV_PATH);
  const url = env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) fail("sin credenciales Supabase en apps/web/.env.local");
  // Propagar al process.env: los módulos de src (p. ej. work-plane-agent-turn)
  // pueden leerlas directamente.
  process.env.NEXT_PUBLIC_SUPABASE_URL = url;
  process.env.SUPABASE_SERVICE_ROLE_KEY = key;

  const db = createClient(url, key) as unknown as DbClient;
  const args = process.argv.slice(2);
  const keep = args.includes("--keep");
  const userArg = args.indexOf("--user");

  // ── 1. Migración aplicada ──────────────────────────────────────────
  for (const table of [
    "work_items",
    "work_item_attempts",
    "work_item_dependencies",
    "work_item_events",
  ]) {
    const { error } = await db.from(table).select("*").limit(1);
    if (error) fail(`tabla ${table} no disponible: ${error.message}`);
  }
  ok("migración 00069 verificada (las 4 tablas responden)");

  // ── 2. Tenant piloto + flag ────────────────────────────────────────
  let pilotUserId: string;
  if (userArg >= 0 && args[userArg + 1]) {
    pilotUserId = args[userArg + 1];
  } else {
    const { data: cases, error } = await db
      .from("operational_cases")
      .select("user_id");
    if (error) throw error;
    const counts = new Map<string, number>();
    for (const row of (cases ?? []) as Array<{ user_id: string }>) {
      counts.set(row.user_id, (counts.get(row.user_id) ?? 0) + 1);
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (!top) fail("no hay tenants con casos operativos; usa --user <uuid>");
    pilotUserId = top[0];
    console.log(
      `· tenant piloto autodetectado: ${pilotUserId} (${top[1]} casos operativos)`
    );
  }

  {
    const { error } = await db.from("account_feature_flags").upsert(
      {
        user_id: pilotUserId,
        flag_key: "work_plane_v2",
        enabled: true,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,flag_key" }
    );
    if (error) throw error;
    ok(`work_plane_v2 habilitado para el tenant piloto ${pilotUserId}`);
  }

  // ── 3. Case type + definiciones sintéticas + casos test ───────────
  let caseTypeId: string;
  {
    const { data: existing, error } = await db
      .from("operational_case_types")
      .select("id")
      .eq("case_type", CASE_TYPE)
      .maybeSingle();
    if (error) throw error;
    if (existing) {
      caseTypeId = (existing as { id: string }).id;
    } else {
      const { data: inserted, error: insertError } = await db
        .from("operational_case_types")
        .insert({
          case_type: CASE_TYPE,
          display_name: "Work plane soak (sintético)",
          default_skill_slug: "work-plane-soak",
          description:
            "Tipo sintético del soak 2.6. Sus casos son test_mode y el loop v1 del cron nunca los procesa (next_action_at en el futuro).",
          user_id: pilotUserId,
          visibility: "private",
          status: "active",
        })
        .select("id")
        .single();
      if (insertError) throw insertError;
      caseTypeId = (inserted as { id: string }).id;
    }
  }

  // Versionado por corrida: siguiente versión libre para (user, case_type).
  const { data: versionRows, error: versionError } = await db
    .from("workflow_definitions")
    .select("version")
    .eq("user_id", pilotUserId)
    .eq("case_type", CASE_TYPE)
    .order("version", { ascending: false })
    .limit(1);
  if (versionError) throw versionError;
  const baseVersion = ((versionRows?.[0]?.version as number | undefined) ?? 0) + 1;

  const variants = ["standard", "human", "blocked"] as const;
  const definitions = new Map<
    (typeof variants)[number],
    { id: string; version: number }
  >();
  for (let i = 0; i < variants.length; i++) {
    const variant = variants[i];
    const graph = soakGraph(variant);
    const draft = await insertDraftDefinition(db, {
      userId: pilotUserId,
      caseType: CASE_TYPE,
      version: baseVersion + i,
      graph,
      definitionHash: computeDefinitionHash(graph),
      provenance: { source: "work-plane-soak-script", variant },
    });
    const published = await publishDefinition(db, draft.id, null);
    definitions.set(variant, { id: published.id, version: published.version });
  }
  ok(
    `definiciones sintéticas publicadas: v${baseVersion}(standard) v${baseVersion + 1}(human) v${baseVersion + 2}(blocked)`
  );

  const farFuture = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const soakCaseIds: string[] = [];
  const caseVariant = new Map<string, string>();
  const plannedCases: Array<{ variant: (typeof variants)[number]; label: string }> = [
    { variant: "standard", label: "std-1" },
    { variant: "standard", label: "std-2" },
    { variant: "standard", label: "std-3" },
    { variant: "standard", label: "std-4" },
    { variant: "human", label: "human-1" },
    { variant: "blocked", label: "blocked-1" },
  ];
  for (const planned of plannedCases) {
    const def = definitions.get(planned.variant)!;
    const { data, error } = await db
      .from("operational_cases")
      .insert({
        user_id: pilotUserId,
        case_type_id: caseTypeId,
        case_type: CASE_TYPE,
        workflow_definition_id: def.id,
        workflow_definition_version: def.version,
        status: "active",
        current_step: "collecting",
        assigned_to_user_id: pilotUserId,
        external_contact_jsonb: {},
        // El loop v1 del cron solo toma casos vencidos: mantenerlos fuera.
        next_action_at: farFuture,
        context_jsonb: {
          test_mode: true,
          work_plane_soak: true,
          soak_label: planned.label,
        },
        version: 0,
      })
      .select("id")
      .single();
    if (error) throw error;
    const caseId = (data as { id: string }).id;
    soakCaseIds.push(caseId);
    caseVariant.set(caseId, planned.variant);
  }
  ok(`${soakCaseIds.length} casos sintéticos creados (test_mode, v1-cron aislado)`);

  // ── 4. Claim stale de un runner "muerto" ───────────────────────────
  {
    const staleCaseId = soakCaseIds[0];
    await createWorkItemsFromTemplates(db, {
      userId: pilotUserId,
      caseId: staleCaseId,
      workflowDefinitionVersion: definitions.get("standard")!.version,
      templates: [
        {
          work_type: "work_plane_synthetic_echo",
          required_capability: "synthetic_work",
        },
      ],
      onEnterState: "collecting",
    });
    await propagateReadiness(db, { userId: pilotUserId, caseId: staleCaseId });
    const claimed = await claimNextReady(db, {
      userId: pilotUserId,
      runnerRef: "crashed-runner-seed",
      executorKind: "deterministic_service",
      leaseMs: 1200,
    });
    if (!claimed) fail("el seed del claim stale no pudo reclamar");
    await sleep(1500); // el lease expira antes de la primera ronda
    ok("claim stale sembrado (runner muerto, lease 1.2s vencido)");
  }

  // ── 5. Rondas: dos passes de cron concurrentes ─────────────────────
  const approvalsInOrder: Array<{ caseId: string; workType: string }> = [];
  let rounds = 0;
  let drained = false;
  while (rounds < MAX_ROUNDS) {
    rounds += 1;
    const [passA, passB] = await Promise.all([
      runWorkPlaneCronPass(db, {
        runnerRef: `soak-runner-A#${rounds}`,
        maxItemsPerTenant: 25,
        retryBackoffMs: () => 0,
      }),
      runWorkPlaneCronPass(db, {
        runnerRef: `soak-runner-B#${rounds}`,
        maxItemsPerTenant: 25,
        retryBackoffMs: () => 0,
      }),
    ]);
    for (const pass of [passA, passB]) {
      for (const err of pass.errors) {
        console.warn(`  · pass error [${err.userId}]: ${err.message}`);
      }
      for (const tenant of pass.tenants) {
        for (const err of tenant.tick.errors) {
          console.warn(`  · tick error [${err.scope}]: ${err.message}`);
        }
      }
    }

    // Operador sintético: aprobar items en review (valida finding 20 en vivo:
    // el caso debe avanzar en la ronda SIGUIENTE vía el sweep, sin claims).
    const { data: reviewItems, error: reviewError } = await db
      .from("work_items")
      .select("id, work_type, case_id")
      .eq("user_id", pilotUserId)
      .in("case_id", soakCaseIds)
      .eq("status", "review");
    if (reviewError) throw reviewError;
    for (const row of (reviewItems ?? []) as Array<{
      id: string;
      work_type: string;
      case_id: string;
    }>) {
      const approved = await approveReviewedItem(db, {
        userId: pilotUserId,
        itemId: row.id,
      });
      if (approved) {
        approvalsInOrder.push({ caseId: row.case_id, workType: row.work_type });
      }
    }

    // ¿Drenado? Items terminales y casos (menos blocked-1) en closed.
    const { data: itemRows, error: itemsError } = await db
      .from("work_items")
      .select("status, case_id")
      .eq("user_id", pilotUserId)
      .in("case_id", soakCaseIds);
    if (itemsError) throw itemsError;
    const items = (itemRows ?? []) as Array<{ status: string; case_id: string }>;
    const { data: caseRows, error: casesError } = await db
      .from("operational_cases")
      .select("id, current_step")
      .in("id", soakCaseIds);
    if (casesError) throw casesError;
    const caseSteps = new Map(
      ((caseRows ?? []) as Array<{ id: string; current_step: string }>).map(
        (c) => [c.id, c.current_step]
      )
    );
    const itemsSettled =
      items.length > 0 &&
      items.every((i) => i.status === "done" || i.status === "blocked");
    const casesSettled = soakCaseIds.every((id) =>
      caseVariant.get(id) === "blocked"
        ? true
        : caseSteps.get(id) === "closed"
    );
    console.log(
      `· ronda ${rounds}: items=${items.length} settled=${itemsSettled} casesClosed=${casesSettled}`
    );
    if (itemsSettled && casesSettled) {
      drained = true;
      break;
    }
    await sleep(500);
  }
  if (!drained) fail(`el backlog no drenó en ${MAX_ROUNDS} rondas`);
  ok(`backlog drenado en ${rounds} rondas (dos runners concurrentes por ronda)`);

  // ── 6. Asserts sobre la base real ──────────────────────────────────
  const { data: allItemsData, error: allItemsError } = await db
    .from("work_items")
    .select("*")
    .eq("user_id", pilotUserId)
    .in("case_id", soakCaseIds);
  if (allItemsError) throw allItemsError;
  const allItems = (allItemsData ?? []) as WorkItem[];
  const itemIds = allItems.map((i) => i.id);

  const { data: attemptsData, error: attemptsError } = await db
    .from("work_item_attempts")
    .select("*")
    .eq("user_id", pilotUserId)
    .in("work_item_id", itemIds);
  if (attemptsError) throw attemptsError;
  const allAttempts = (attemptsData ?? []) as WorkItemAttempt[];

  // 6a. Cero double-claims: ningún attempt running al final; attempt_numbers
  // únicos y contiguos por item (la constraint única ya lo garantiza en DB;
  // esto verifica que ningún claim se perdió en silencio).
  if (allAttempts.some((a) => a.status === "running")) {
    fail("attempts running tras el drenado (claim colgado)");
  }
  const byItem = new Map<string, number[]>();
  for (const a of allAttempts) {
    const list = byItem.get(a.work_item_id) ?? [];
    list.push(a.attempt_number);
    byItem.set(a.work_item_id, list);
  }
  for (const [itemId, numbers] of byItem) {
    const sorted = [...numbers].sort((x, y) => x - y);
    const expected = Array.from({ length: sorted.length }, (_, i) => i + 1);
    if (JSON.stringify(sorted) !== JSON.stringify(expected)) {
      fail(`attempt_numbers no contiguos para ${itemId}: ${numbers}`);
    }
  }
  ok("cero double-claims silenciosos (attempts únicos/contiguos, ninguno colgado)");

  // 6b. claim_expired visible (el claim del runner muerto).
  const { data: expiredEvents, error: expiredError } = await db
    .from("work_item_events")
    .select("id, work_item_id, payload_jsonb")
    .eq("user_id", pilotUserId)
    .in("work_item_id", itemIds)
    .eq("event_type", "claim_expired");
  if (expiredError) throw expiredError;
  if ((expiredEvents ?? []).length < 1) {
    fail("no hay eventos claim_expired: el claim stale sembrado no fue recuperado visiblemente");
  }
  ok(`claim_expired visible (${(expiredEvents ?? []).length} evento(s))`);

  // 6c. Drenado correcto: blocked SOLO el fixture unregistered.
  for (const item of allItems) {
    if (item.status === "blocked") {
      if (item.work_type !== "work_plane_synthetic_unregistered") {
        fail(`blocked inesperado: ${item.work_type}`);
      }
      if (item.blocked_reason !== "max_attempts_exhausted") {
        fail(`blocked_reason inesperado: ${item.blocked_reason}`);
      }
      if (item.attempt_count !== item.max_attempts) {
        fail(
          `el item bloqueado debió agotar max_attempts (${item.attempt_count}/${item.max_attempts})`
        );
      }
    } else if (item.status !== "done") {
      fail(`item no terminal tras drenado: ${item.work_type} (${item.status})`);
    }
  }
  ok("blocked únicamente el fixture max_attempts, con razón y conteo exactos");

  // 6d. Rama paralela: fan-in reclamado después de terminar ambas ramas.
  const { data: eventsData, error: eventsError } = await db
    .from("work_item_events")
    .select("work_item_id, event_type, created_at")
    .eq("user_id", pilotUserId)
    .in("work_item_id", itemIds)
    .order("created_at", { ascending: true });
  if (eventsError) throw eventsError;
  const events = (eventsData ?? []) as Array<{
    work_item_id: string;
    event_type: string;
    created_at: string;
  }>;
  for (const caseId of soakCaseIds) {
    if (caseVariant.get(caseId) === "blocked") continue;
    const caseItems = allItems.filter((i) => i.case_id === caseId);
    const fanIn = caseItems.find(
      (i) => i.work_type === "work_plane_synthetic_fan_in"
    );
    if (!fanIn) fail(`caso ${caseId} sin item fan_in`);
    const fanInClaimAt = events.find(
      (e) => e.work_item_id === fanIn.id && e.event_type === "claimed"
    )?.created_at;
    if (!fanInClaimAt) fail(`caso ${caseId}: fan_in sin evento claimed`);
    for (const branchType of [
      "work_plane_synthetic_branch_a",
      "work_plane_synthetic_branch_b",
    ]) {
      const branch = caseItems.find((i) => i.work_type === branchType);
      if (!branch) fail(`caso ${caseId} sin item ${branchType}`);
      const branchDoneAt = events.find(
        (e) => e.work_item_id === branch.id && e.event_type === "done"
      )?.created_at;
      if (!branchDoneAt || branchDoneAt > fanInClaimAt) {
        fail(`caso ${caseId}: fan_in reclamado antes de terminar ${branchType}`);
      }
    }
  }
  ok("rama paralela verificada: fan-in siempre después de ambas ramas");

  // 6e. Notificaciones: blocked + review.
  const { data: notifications, error: notifError } = await db
    .from("internal_user_notifications")
    .select("kind, case_id")
    .eq("user_id", pilotUserId)
    .in("case_id", soakCaseIds);
  if (notifError) throw notifError;
  const kinds = new Set(
    ((notifications ?? []) as Array<{ kind: string }>).map((n) => n.kind)
  );
  if (!kinds.has("work_item_blocked")) {
    fail("falta la notificación work_item_blocked del exit check max-attempts");
  }
  if (!kinds.has("work_item_review")) {
    fail("falta la notificación work_item_review del executor human");
  }
  ok("notificaciones emitidas: work_item_blocked y work_item_review");

  // 6f. Decisión humana en orden + avance post-aprobación (finding 20 en vivo).
  const humanApprovals = approvalsInOrder.filter(
    (a) => caseVariant.get(a.caseId) === "human"
  );
  if (
    humanApprovals.length !== 1 ||
    humanApprovals[0].workType !== "work_plane_synthetic_approval"
  ) {
    fail(
      `decisión humana inesperada: ${JSON.stringify(humanApprovals)} (esperada exactamente work_plane_synthetic_approval)`
    );
  }
  ok("decisión humana única y en orden; el caso avanzó a closed tras la aprobación (sweep finding 20)");

  // 6g. Secuencia de estados idéntica entre instancias de la misma definición
  // + evento state_changed del wrapper advised (evaluator-autorizado).
  const { data: caseEvents, error: caseEventsError } = await db
    .from("operational_case_events")
    .select("case_id, event_type, payload_jsonb, created_at")
    .in("case_id", soakCaseIds)
    .eq("event_type", "state_changed")
    .order("created_at", { ascending: true });
  if (caseEventsError) throw caseEventsError;
  const sequences = new Map<string, string[]>();
  for (const event of (caseEvents ?? []) as Array<{
    case_id: string;
    payload_jsonb: Record<string, unknown>;
  }>) {
    const payload = event.payload_jsonb ?? {};
    if (payload.kind !== "workflow_step_transition") continue;
    if (payload.source !== "work_plane_dispatcher") continue;
    const to = (payload.to as { current_step?: string } | undefined)?.current_step;
    if (!to) continue;
    const seq = sequences.get(event.case_id) ?? [];
    seq.push(to);
    sequences.set(event.case_id, seq);
  }
  const standardSequences = soakCaseIds
    .filter((id) => caseVariant.get(id) === "standard")
    .map((id) => JSON.stringify(sequences.get(id) ?? []));
  if (new Set(standardSequences).size !== 1) {
    fail(`secuencias de estados divergentes entre casos standard: ${standardSequences}`);
  }
  if (standardSequences[0] !== JSON.stringify(["producing", "closed"])) {
    fail(`secuencia standard inesperada: ${standardSequences[0]}`);
  }
  ok(
    "secuencia de estados idéntica en las 4 instancias standard (collecting→producing→closed), registrada vía el wrapper advised"
  );

  // Reporte de contención: claims por runner.
  const claimsByRunner = new Map<string, number>();
  for (const a of allAttempts) {
    const runner = (a.executor_ref ?? "?").split("#")[0];
    claimsByRunner.set(runner, (claimsByRunner.get(runner) ?? 0) + 1);
  }
  const runnerSummary = [...claimsByRunner.entries()]
    .map(([r, n]) => `${r}=${n}`)
    .join(" · ");
  console.log(`· claims por runner: ${runnerSummary}`);
  const soakRunners = [...claimsByRunner.keys()].filter((r) =>
    r.startsWith("soak-runner-")
  );
  if (soakRunners.length < 2) {
    console.warn(
      "⚠ un solo runner del soak llegó a reclamar (el otro pass encontró la cola vacía); los invariantes de contención igual se verificaron"
    );
  }

  // ── 7. Cleanup ─────────────────────────────────────────────────────
  if (!keep) {
    const { error } = await db
      .from("operational_cases")
      .update({ status: "completed", updated_at: new Date().toISOString() })
      .in("id", soakCaseIds);
    if (error) throw error;
    ok("cleanup: casos soak marcados completed (items/attempts/eventos quedan como historia)");
  } else {
    console.log("· --keep: los casos soak quedan activos para inspección");
  }

  console.log("\nwork-plane-soak: all green");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
