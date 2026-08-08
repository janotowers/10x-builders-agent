/**
 * Soak sintético del plano de trabajo (Slice 2.6-1/2.6-2/2.6-3).
 *
 * Dos runners concurrentes ejecutan `runTick` sobre un store compartido que
 * modela las garantías del módulo de queries (claim CAS atómico, completion
 * fail-closed, recovery de claims stale) con puntos de interleaving inyectados
 * (yields pseudo-aleatorios con semilla) antes de cada sección atómica — la
 * atomicidad de la mutación es exactamente la garantía que da la base de
 * datos; lo que el soak prueba es que la POLÍTICA del dispatcher nunca
 * double-procesa ni pierde trabajo bajo contención real.
 *
 * Invariantes verificados (§25 capa 5, Phase 2 exit checks):
 *   1. Cero double-claims silenciosos (asserts sobre el log de eventos).
 *   2. `claim_expired` visible para claims de un runner "muerto" pre-sembrado.
 *   3. El backlog drena: todo item termina en done/blocked; blocked SOLO el
 *      fixture que agota max_attempts (→ blocked_reason correcto).
 *   4. Caso end-to-end con rama paralela real (3 items concurrentes + fan-in).
 *   5. Punto de decisión humano (review → aprobación del operador) en orden.
 *   6. Equivalencia §12.2 entre dos corridas con semillas/interleavings
 *      distintos: mismo estado terminal, misma secuencia de estados de
 *      negocio, decisiones humanas en el mismo orden, artefactos idénticos
 *      por contenido — la granularidad de attempts PUEDE diferir.
 *
 * El soak vivo contra el tenant piloto (cron real, DB real) queda para el
 * entorno con la migración 00069 aplicada; este archivo es la versión
 * ejecutable-en-CI de la misma disciplina.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type {
  WorkItem,
  WorkItemAttempt,
  WorkItemTemplateSpec,
  WorkflowGraph,
} from "@agents/types";
import {
  createWorkDispatcher,
  type ExecutorAdapter,
  type WorkPlaneStore,
} from "./dispatcher";

const USER = "user-soak";

// ============================================================
// PRNG determinista (LCG) — interleavings reproducibles por semilla
// ============================================================

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

// ============================================================
// Store compartido con contención real
// ============================================================

interface SoakEvent {
  type:
    | "claimed"
    | "claim_expired"
    | "completed"
    | "double_claim_violation"
    | "operator_approved";
  itemId?: string;
  workType?: string;
  caseId?: string | null;
  attemptNumber?: number;
  runner?: string;
  detail?: string;
}

interface SoakStore extends WorkPlaneStore {
  items: WorkItem[];
  attempts: WorkItemAttempt[];
  deps: Array<{ work_item_id: string; depends_on_id: string }>;
  events: SoakEvent[];
}

function makeSoakStore(rng: () => number): SoakStore {
  const items: WorkItem[] = [];
  const attempts: WorkItemAttempt[] = [];
  const deps: Array<{ work_item_id: string; depends_on_id: string }> = [];
  const events: SoakEvent[] = [];

  // Punto de interleaving: 0–2 vueltas del event loop antes de la sección
  // atómica. Modela latencia de red/query; la mutación posterior es síncrona
  // (= la garantía CAS de la DB).
  async function jitter(): Promise<void> {
    const n = Math.floor(rng() * 3);
    for (let i = 0; i < n; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  const store: SoakStore = {
    items,
    attempts,
    deps,
    events,

    async createWorkItemsFromTemplates(input) {
      await jitter();
      const created: WorkItem[] = [];
      const existing: WorkItem[] = [];
      const byType = new Map<string, WorkItem>();
      for (const t of input.templates) {
        const key = t.idempotency_key?.trim()
          ? t.idempotency_key.trim()
          : input.onEnterState
            ? `${input.onEnterState}:${t.work_type}`
            : t.work_type;
        const prior = items.find(
          (i) => i.case_id === input.caseId && i.idempotency_key === key
        );
        if (prior) {
          existing.push(prior);
          byType.set(prior.work_type, prior);
          continue;
        }
        const now = new Date().toISOString();
        const row: WorkItem = {
          id: randomUUID(),
          case_id: input.caseId,
          work_run_id: null,
          user_id: input.userId,
          workflow_definition_version: input.workflowDefinitionVersion,
          work_type: t.work_type,
          origin: "definition_template",
          status: "todo",
          priority: t.priority ?? 100,
          required_capability: t.required_capability,
          assigned_worker_profile_id: null,
          not_before: t.not_before ?? null,
          due_at: t.due_at ?? null,
          attempt_count: 0,
          max_attempts: t.max_attempts ?? 3,
          current_attempt_id: null,
          blocked_reason: null,
          input_contract_jsonb: t.input_contract ?? {},
          output_contract_jsonb: t.output_contract ?? {},
          verification_contract_jsonb: t.verification_contract ?? {},
          result_jsonb: null,
          idempotency_key: key,
          version: 1,
          created_at: now,
          updated_at: now,
        };
        items.push(row);
        created.push(row);
        byType.set(row.work_type, row);
      }
      for (const t of input.templates) {
        const item = byType.get(t.work_type);
        if (!item) continue;
        for (const dep of t.depends_on ?? []) {
          const target = byType.get(dep);
          if (!target) throw new Error(`unknown sibling ${dep}`);
          if (
            !deps.some(
              (d) => d.work_item_id === item.id && d.depends_on_id === target.id
            )
          ) {
            deps.push({ work_item_id: item.id, depends_on_id: target.id });
          }
        }
      }
      return { created, existing };
    },

    async propagateReadiness(params) {
      await jitter();
      const now = new Date().toISOString();
      const readyIds: string[] = [];
      for (const item of items) {
        if (item.user_id !== params.userId) continue;
        if (params.caseId && item.case_id !== params.caseId) continue;
        if (item.status !== "todo") continue;
        if (item.not_before && item.not_before > now) continue;
        const itemDeps = deps.filter((d) => d.work_item_id === item.id);
        const allDone = itemDeps.every(
          (d) => items.find((i) => i.id === d.depends_on_id)?.status === "done"
        );
        if (allDone) {
          item.status = "ready";
          readyIds.push(item.id);
        }
      }
      return { readyIds };
    },

    async claimNextReady(input) {
      await jitter();
      // Sección atómica (síncrona): re-escanear y reclamar. Dos llamadas
      // concurrentes solo interlean en el jitter, nunca aquí — igual que el
      // UPDATE ... WHERE version = expected de la DB.
      const now = new Date().toISOString();
      const item = items
        .filter(
          (i) =>
            i.user_id === input.userId &&
            i.status === "ready" &&
            (!i.not_before || i.not_before <= now)
        )
        .sort((a, b) => a.priority - b.priority)[0];
      if (!item) return null;

      if (
        attempts.some(
          (a) => a.work_item_id === item.id && a.status === "running"
        )
      ) {
        events.push({
          type: "double_claim_violation",
          itemId: item.id,
          workType: item.work_type,
          runner: input.runnerRef,
          detail: "claim over an item with a running attempt",
        });
      }

      const attempt: WorkItemAttempt = {
        id: randomUUID(),
        work_item_id: item.id,
        user_id: input.userId,
        attempt_number: item.attempt_count + 1,
        executor_kind:
          typeof input.executorKind === "function"
            ? input.executorKind(item)
            : input.executorKind,
        executor_ref: input.runnerRef,
        worker_profile_id: null,
        status: "running",
        claimed_at: now,
        claim_expires_at: new Date(Date.now() + input.leaseMs).toISOString(),
        last_liveness_at: null,
        last_progress_at: null,
        completed_at: null,
        error_jsonb: null,
        evidence_jsonb: null,
        created_at: now,
      };
      attempts.push(attempt);
      item.status = "running";
      item.attempt_count = attempt.attempt_number;
      item.current_attempt_id = attempt.id;
      item.version += 1;
      events.push({
        type: "claimed",
        itemId: item.id,
        workType: item.work_type,
        caseId: item.case_id,
        attemptNumber: attempt.attempt_number,
        runner: input.runnerRef,
      });
      return { item: { ...item }, attempt: { ...attempt } };
    },

    async reportLiveness(input) {
      const attempt = attempts.find((a) => a.id === input.attemptId);
      if (!attempt || attempt.status !== "running") {
        return { ok: false, renewed: false, reason: "attempt_not_running" };
      }
      attempt.last_liveness_at = new Date().toISOString();
      const renewing = typeof input.renewLeaseMs === "number";
      if (renewing) {
        attempt.claim_expires_at = new Date(
          Date.now() + (input.renewLeaseMs as number)
        ).toISOString();
      }
      return { ok: true, renewed: renewing };
    },

    async recoverStaleClaims(params) {
      await jitter();
      // Sección atómica: misma semántica que recoverStaleClaims de @agents/db.
      const now = new Date().toISOString();
      const recovered: Array<{
        attemptId: string;
        workItemId: string;
        outcome: string;
      }> = [];
      for (const attempt of attempts) {
        if (attempt.user_id !== params.userId) continue;
        if (attempt.status !== "running") continue;
        if (attempt.claim_expires_at >= now) continue;
        attempt.status = "claim_expired";
        attempt.completed_at = now;
        const item = items.find((i) => i.id === attempt.work_item_id);
        if (!item || item.current_attempt_id !== attempt.id) {
          events.push({ type: "claim_expired", itemId: attempt.work_item_id });
          continue;
        }
        const exhausted = item.attempt_count >= item.max_attempts;
        item.status = exhausted ? "blocked" : "ready";
        item.blocked_reason = exhausted ? "max_attempts_exhausted" : null;
        item.current_attempt_id = null;
        item.version += 1;
        events.push({
          type: "claim_expired",
          itemId: item.id,
          workType: item.work_type,
          caseId: item.case_id,
          attemptNumber: attempt.attempt_number,
          detail: exhausted ? "blocked" : "ready",
        });
        recovered.push({
          attemptId: attempt.id,
          workItemId: item.id,
          outcome: exhausted ? "blocked" : "ready",
        });
      }
      return recovered;
    },

    async completeAttempt(input) {
      await jitter();
      const attempt = attempts.find((a) => a.id === input.attemptId);
      if (!attempt) return { ok: false, reason: "attempt_not_found" };
      if (attempt.status !== "running") {
        return { ok: false, reason: "attempt_not_running" };
      }
      const item = items.find((i) => i.id === attempt.work_item_id)!;
      if (item.current_attempt_id !== attempt.id) {
        return { ok: false, reason: "claim_lost" };
      }
      attempt.status = input.outcome;
      attempt.completed_at = new Date().toISOString();
      if (input.errorJsonb) attempt.error_jsonb = input.errorJsonb;
      events.push({
        type: "completed",
        itemId: item.id,
        workType: item.work_type,
        caseId: item.case_id,
        attemptNumber: attempt.attempt_number,
        detail: input.outcome,
      });
      if (input.outcome === "succeeded") {
        item.status = input.itemStatusOnSuccess ?? "review";
        item.result_jsonb = input.resultJsonb ?? null;
        item.current_attempt_id = null;
        item.version += 1;
        return { ok: true, item: { ...item }, itemStatus: item.status };
      }
      const exhausted = item.attempt_count >= item.max_attempts;
      item.status = exhausted ? "blocked" : "ready";
      item.blocked_reason = exhausted ? "max_attempts_exhausted" : null;
      item.current_attempt_id = null;
      if (!exhausted) item.not_before = input.retryNotBefore ?? null;
      item.version += 1;
      return { ok: true, item: { ...item }, itemStatus: item.status };
    },

    async blockItem(params) {
      const item = items.find((i) => i.id === params.itemId);
      if (!item) return null;
      item.status = "blocked";
      item.blocked_reason = params.reason;
      item.version += 1;
      return { ...item };
    },

    async listWorkItemsForCase(userId, caseId) {
      return items
        .filter((i) => i.user_id === userId && i.case_id === caseId)
        .map((i) => ({ ...i }));
    },
  };
  return store;
}

// ============================================================
// Grafos sintéticos
// ============================================================

/**
 * Caso estándar: collecting → producing → closed, con rama paralela real en
 * producing (3 items sin dependencias entre sí + fan-in) — el patrón §12.2
 * "contract preparation + photo coordination concurrent with comparables".
 */
function standardGraph(opts: { withHumanApproval?: boolean } = {}): WorkflowGraph {
  const producingTemplates: WorkflowGraph["work_templates"] = [
    {
      on_enter_state: "producing",
      work_type: "analyze_comparables",
      required_capability: "service",
    },
    {
      on_enter_state: "producing",
      work_type: "prepare_contract",
      required_capability: "flaky", // falla el intento 1, luego pasa (retries)
    },
    {
      on_enter_state: "producing",
      work_type: "coordinate_photos",
      required_capability: "service",
    },
    {
      on_enter_state: "producing",
      work_type: "assemble_package",
      required_capability: "service",
      depends_on: ["analyze_comparables", "prepare_contract", "coordinate_photos"],
    },
  ];
  if (opts.withHumanApproval) {
    producingTemplates.push({
      on_enter_state: "producing",
      work_type: "owner_approval",
      required_capability: "human",
      depends_on: ["assemble_package"],
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
        work_type: "collect_facts",
        required_capability: "service",
      },
      ...producingTemplates,
    ],
    postconditions: [],
    approvals: [],
    impact_dependencies: {},
    completion: { terminal_states: ["closed"], required_evidence: [] },
  };
}

/** Caso que agota max_attempts: su único item falla siempre. */
function alwaysFailGraph(): WorkflowGraph {
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
        work_type: "impossible_task",
        required_capability: "always_fail",
      },
    ],
    postconditions: [],
    approvals: [],
    impact_dependencies: {},
    completion: { terminal_states: ["closed"], required_evidence: [] },
  };
}

// ============================================================
// Ejecutores sintéticos (artefactos deterministas por contenido)
// ============================================================

function deterministicArtifact(item: WorkItem): Record<string, unknown> {
  // Contenido función SOLO de identidad de negocio (no de attempt/runner):
  // clave de la equivalencia §12.2 "artifacts by content".
  return { artifact: `${item.case_id}/${item.work_type}`, ok: true };
}

function makeResolver(rng: () => number): (item: WorkItem) => ExecutorAdapter | null {
  const yieldOnce = async () => {
    const n = Math.floor(rng() * 2);
    for (let i = 0; i < n; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  };
  const service: ExecutorAdapter = {
    executionMode: "deterministic_service",
    execute: async (ctx) => {
      await yieldOnce();
      return { outcome: "succeeded", result: deterministicArtifact(ctx.work.item) };
    },
  };
  const flaky: ExecutorAdapter = {
    executionMode: "deterministic_service",
    execute: async (ctx) => {
      await yieldOnce();
      if (ctx.work.attempt.attempt_number === 1) {
        return { outcome: "failed", error: { reason: "synthetic_first_attempt_failure" } };
      }
      return { outcome: "succeeded", result: deterministicArtifact(ctx.work.item) };
    },
  };
  const human: ExecutorAdapter = {
    executionMode: "human",
    execute: async (ctx) => {
      await yieldOnce();
      return {
        outcome: "succeeded",
        result: deterministicArtifact(ctx.work.item),
        requiresHumanReview: true,
      };
    },
  };
  const alwaysFail: ExecutorAdapter = {
    executionMode: "deterministic_service",
    execute: async () => {
      await yieldOnce();
      return { outcome: "failed", error: { reason: "synthetic_permanent_failure" } };
    },
  };
  return (item) => {
    switch (item.required_capability) {
      case "service":
        return service;
      case "flaky":
        return flaky;
      case "human":
        return human;
      case "always_fail":
        return alwaysFail;
      default:
        return null;
    }
  };
}

// ============================================================
// Corrida completa del soak (parametrizada por semilla)
// ============================================================

interface SuiteOutcome {
  terminalStates: Map<string, string>;
  stateSequences: Map<string, string[]>;
  /** Decisiones humanas (aprobaciones del operador) en orden global. */
  decisionPoints: Array<{ caseId: string | null; workType: string }>;
  /** Artefactos por contenido: `${caseId}/${workType}` → result_jsonb. */
  artifacts: Map<string, unknown>;
  attemptsPerItem: Map<string, number>;
  claimsByRunner: Map<string, number>;
  events: SoakEvent[];
  items: WorkItem[];
  rounds: number;
}

async function runSuite(seed: number): Promise<SuiteOutcome> {
  const rng = makeRng(seed);
  const store = makeSoakStore(rng);
  const resolver = makeResolver(rng);
  const dispatcher = createWorkDispatcher({
    store,
    resolveExecutor: resolver,
    retryBackoffMs: () => 0, // reintentos inmediatos: el soak drena en pocas rondas
  });

  // 8 casos: 6 estándar + 1 con aprobación humana + 1 que agota max_attempts.
  const caseStates = new Map<string, string>();
  const graphs = new Map<string, WorkflowGraph>();
  for (let i = 1; i <= 6; i++) {
    caseStates.set(`case-std-${i}`, "collecting");
    graphs.set(`case-std-${i}`, standardGraph());
  }
  caseStates.set("case-human", "collecting");
  graphs.set("case-human", standardGraph({ withHumanApproval: true }));
  caseStates.set("case-fail", "collecting");
  graphs.set("case-fail", alwaysFailGraph());

  const stateSequences = new Map<string, string[]>(
    [...caseStates.keys()].map((id) => [id, []])
  );
  const decisionPoints: Array<{ caseId: string | null; workType: string }> = [];

  // Pre-sembrar un claim stale de un runner "muerto": el item quedó running
  // con lease vencido; el primer recovery debe voltearlo a claim_expired y
  // devolverlo a ready sin intervención humana.
  {
    const staleCase = "case-std-1";
    await store.createWorkItemsFromTemplates({
      userId: USER,
      caseId: staleCase,
      workflowDefinitionVersion: 1,
      templates: [
        {
          work_type: "collect_facts",
          required_capability: "service",
          idempotency_key: "collecting:collect_facts",
        } as WorkItemTemplateSpec,
      ],
      onEnterState: "collecting",
    });
    await store.propagateReadiness({ userId: USER });
    const claimed = await store.claimNextReady({
      userId: USER,
      runnerRef: "crashed-runner",
      executorKind: "deterministic_service",
      leaseMs: 1, // vence de inmediato
    });
    assert.ok(claimed, "el pre-seed del claim stale debe reclamar");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  // advanceCase compartido: CAS sobre caseStates (equivale al guard
  // current_step === fromState del wrapper advised de producción).
  const advanceCase = async (params: {
    caseId: string;
    fromState: string;
    toState: string;
  }): Promise<boolean> => {
    if (caseStates.get(params.caseId) !== params.fromState) return false;
    caseStates.set(params.caseId, params.toState);
    stateSequences.get(params.caseId)!.push(params.toState);
    return true;
  };

  const tick = async (runnerRef: string) =>
    dispatcher.runTick({
      userId: USER,
      runnerRef,
      cases: [...caseStates.entries()].map(([caseId, currentState]) => ({
        caseId,
        currentState,
        workflowDefinitionVersion: 1,
        graph: graphs.get(caseId)!,
      })),
      leaseMs: 60_000,
      maxItems: 25,
      advanceCase: async (p) => advanceCase(p),
    });

  // Operador sintético: aprueba items en review entre rondas (review → done),
  // registrando el orden de los puntos de decisión humanos.
  const approveReviews = () => {
    for (const item of store.items) {
      if (item.status !== "review") continue;
      item.status = "done";
      item.version += 1;
      store.events.push({
        type: "operator_approved",
        itemId: item.id,
        workType: item.work_type,
        caseId: item.case_id,
      });
      decisionPoints.push({ caseId: item.case_id, workType: item.work_type });
    }
  };

  const allSettled = () =>
    store.items.every((i) => i.status === "done" || i.status === "blocked") &&
    [...caseStates.entries()].every(
      ([caseId, state]) => state === "closed" || caseId === "case-fail"
    );

  let rounds = 0;
  const MAX_ROUNDS = 60;
  while (rounds < MAX_ROUNDS) {
    rounds += 1;
    // Dos runners CONCURRENTES sobre el mismo store — contención real.
    await Promise.all([tick(`runner-A#${rounds}`), tick(`runner-B#${rounds}`)]);
    approveReviews();
    if (allSettled()) break;
  }

  const claimsByRunner = new Map<string, number>();
  for (const event of store.events) {
    if (event.type !== "claimed" || !event.runner) continue;
    const runner = event.runner.split("#")[0];
    claimsByRunner.set(runner, (claimsByRunner.get(runner) ?? 0) + 1);
  }

  const attemptsPerItem = new Map<string, number>();
  for (const attempt of store.attempts) {
    attemptsPerItem.set(
      attempt.work_item_id,
      Math.max(attemptsPerItem.get(attempt.work_item_id) ?? 0, attempt.attempt_number)
    );
  }

  const artifacts = new Map<string, unknown>();
  for (const item of store.items) {
    if (item.status === "done" && item.result_jsonb) {
      artifacts.set(`${item.case_id}/${item.work_type}`, item.result_jsonb);
    }
  }

  return {
    terminalStates: new Map(caseStates),
    stateSequences,
    decisionPoints,
    artifacts,
    attemptsPerItem,
    claimsByRunner,
    events: store.events,
    items: store.items,
    rounds,
  };
}

// ============================================================
// Asserts de invariantes por corrida
// ============================================================

function assertSuiteInvariants(outcome: SuiteOutcome, label: string): void {
  // 1. Cero double-claims silenciosos.
  const violations = outcome.events.filter(
    (e) => e.type === "double_claim_violation"
  );
  assert.equal(
    violations.length,
    0,
    `${label}: double-claims detectados: ${JSON.stringify(violations)}`
  );

  // attempt_numbers únicos y contiguos por item (ningún claim pisó a otro).
  const claimsPerItem = new Map<string, number[]>();
  for (const event of outcome.events) {
    if (event.type !== "claimed" || !event.itemId) continue;
    const list = claimsPerItem.get(event.itemId) ?? [];
    list.push(event.attemptNumber!);
    claimsPerItem.set(event.itemId, list);
  }
  for (const [itemId, numbers] of claimsPerItem) {
    const sorted = [...numbers].sort((a, b) => a - b);
    assert.deepEqual(
      sorted,
      Array.from({ length: sorted.length }, (_, i) => i + 1),
      `${label}: attempt_numbers no contiguos/únicos para ${itemId}: ${numbers}`
    );
  }

  // 2. claim_expired visible (el claim pre-sembrado del runner muerto).
  const expired = outcome.events.filter((e) => e.type === "claim_expired");
  assert.ok(
    expired.length >= 1,
    `${label}: el claim stale pre-sembrado debe aparecer como claim_expired`
  );

  // 3. Backlog drenado: todo item terminal; blocked SOLO impossible_task.
  for (const item of outcome.items) {
    assert.ok(
      item.status === "done" || item.status === "blocked",
      `${label}: item no drenado ${item.work_type} (${item.status})`
    );
    if (item.status === "blocked") {
      assert.equal(item.work_type, "impossible_task", `${label}: blocked inesperado`);
      assert.equal(item.blocked_reason, "max_attempts_exhausted");
      assert.equal(
        outcome.attemptsPerItem.get(item.id),
        item.max_attempts,
        `${label}: el item bloqueado debe haber agotado exactamente max_attempts`
      );
    }
  }

  // 4. Rama paralela end-to-end: en cada caso estándar el fan-in
  // (assemble_package) se reclamó DESPUÉS de completarse las 3 ramas.
  for (const [caseId, state] of outcome.terminalStates) {
    if (caseId === "case-fail") {
      assert.equal(state, "collecting", `${label}: case-fail no debe avanzar`);
      continue;
    }
    assert.equal(state, "closed", `${label}: ${caseId} no llegó a terminal`);
    const caseEvents = outcome.events.filter((e) => e.caseId === caseId);
    const fanInClaim = caseEvents.findIndex(
      (e) => e.type === "claimed" && e.workType === "assemble_package"
    );
    assert.ok(fanInClaim >= 0, `${label}: ${caseId} sin claim del fan-in`);
    for (const branch of [
      "analyze_comparables",
      "prepare_contract",
      "coordinate_photos",
    ]) {
      const branchDone = caseEvents.findIndex(
        (e) =>
          e.type === "completed" &&
          e.workType === branch &&
          e.detail === "succeeded"
      );
      assert.ok(
        branchDone >= 0 && branchDone < fanInClaim,
        `${label}: ${caseId} fan-in reclamado antes de terminar la rama ${branch}`
      );
    }
  }

  // Retries reales: prepare_contract (flaky) usó más de un attempt en algún caso.
  const flakyItems = outcome.items.filter((i) => i.work_type === "prepare_contract");
  assert.ok(
    flakyItems.every((i) => (outcome.attemptsPerItem.get(i.id) ?? 0) >= 2),
    `${label}: el fixture flaky debe ejercitar reintentos`
  );

  // 5. Punto de decisión humano: owner_approval pasó por review y aprobación.
  const humanDecisions = outcome.decisionPoints.filter(
    (d) => d.caseId === "case-human"
  );
  assert.deepEqual(
    humanDecisions.map((d) => d.workType),
    ["owner_approval"],
    `${label}: la decisión humana debe ser exactamente owner_approval`
  );

  // Contención real: ambos runners reclamaron trabajo.
  const runnerA = outcome.claimsByRunner.get("runner-A") ?? 0;
  const runnerB = outcome.claimsByRunner.get("runner-B") ?? 0;
  assert.ok(
    runnerA > 0 && runnerB > 0,
    `${label}: ambos runners deben competir (A=${runnerA}, B=${runnerB})`
  );

  console.log(
    `✓ ${label}: drenado en ${outcome.rounds} rondas; claims A=${runnerA} B=${runnerB}; ` +
      `claim_expired=${expired.length}; items=${outcome.items.length}`
  );
}

// ============================================================
// Equivalencia §12.2 entre corridas (semillas distintas)
// ============================================================

function assertEquivalence(a: SuiteOutcome, b: SuiteOutcome): void {
  // Mismo estado terminal por caso.
  assert.deepEqual(
    [...a.terminalStates.entries()].sort(),
    [...b.terminalStates.entries()].sort(),
    "estados terminales divergen entre corridas"
  );
  // Misma secuencia de estados de negocio por caso (el timing puede diferir).
  for (const [caseId, seq] of a.stateSequences) {
    assert.deepEqual(
      seq,
      b.stateSequences.get(caseId),
      `secuencia de estados diverge para ${caseId}`
    );
  }
  // Decisiones humanas en el mismo orden.
  assert.deepEqual(a.decisionPoints, b.decisionPoints, "decisiones humanas divergen");
  // Artefactos idénticos por contenido.
  assert.deepEqual(
    [...a.artifacts.entries()].sort(),
    [...b.artifacts.entries()].sort(),
    "artefactos divergen por contenido"
  );
  // La granularidad de attempts PUEDE diferir (§12.2) — solo se reporta.
  const attemptsA = [...a.attemptsPerItem.values()].reduce((s, n) => s + n, 0);
  const attemptsB = [...b.attemptsPerItem.values()].reduce((s, n) => s + n, 0);
  console.log(
    `✓ equivalencia §12.2 entre corridas (attempts totales: ${attemptsA} vs ${attemptsB} — pueden diferir)`
  );
}

// ============================================================
// Main
// ============================================================

async function main(): Promise<void> {
  const run1 = await runSuite(0xa11ce);
  assertSuiteInvariants(run1, "corrida 1 (seed a11ce)");
  const run2 = await runSuite(0xb0b);
  assertSuiteInvariants(run2, "corrida 2 (seed b0b)");
  assertEquivalence(run1, run2);
  console.log("soak selftest: all green");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
