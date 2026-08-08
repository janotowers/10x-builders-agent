/**
 * Selftests del dispatcher (Slice 2.3).
 *
 * Un WorkPlaneStore in-memory reproduce la semántica del módulo de queries
 * (idempotencia por key, claim con attempt, fail-closed en completion); la
 * mecánica real de CAS/constraints se prueba en @agents/db test:work-plane.
 * Aquí se prueba la política del dispatcher: tick completo con cadena de
 * dependencias, verificación mínima del output contract, containment de
 * claims perdidos (2.3-6), bloqueo por capability sin ejecutor y el
 * advancement predicate (§8.4) con su único call site de avance.
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
  evaluateAdvancement,
  templateSpecsForState,
  verifyOutputContract,
  type ClaimedWork,
  type ExecutorAdapter,
  type WorkPlaneStore,
} from "./dispatcher";

const USER = "user-1";
const CASE = "case-1";

// ============================================================
// Store in-memory
// ============================================================

interface MemoryStore extends WorkPlaneStore {
  items: WorkItem[];
  attempts: WorkItemAttempt[];
  deps: Array<{ work_item_id: string; depends_on_id: string }>;
  /** Comportamiento inyectable de reportLiveness (containment tests). */
  livenessBehavior: (attemptId: string) => { ok: boolean } | "throw";
}

function makeStore(): MemoryStore {
  const items: WorkItem[] = [];
  const attempts: WorkItemAttempt[] = [];
  const deps: Array<{ work_item_id: string; depends_on_id: string }> = [];

  const store: MemoryStore = {
    items,
    attempts,
    deps,
    livenessBehavior: () => ({ ok: true }),

    async createWorkItemsFromTemplates(input) {
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
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
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
              (d) =>
                d.work_item_id === item.id && d.depends_on_id === target.id
            )
          ) {
            deps.push({ work_item_id: item.id, depends_on_id: target.id });
          }
        }
      }
      return { created, existing };
    },

    async propagateReadiness(params) {
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
      const now = new Date().toISOString();
      const candidates = items
        .filter(
          (i) =>
            i.user_id === input.userId &&
            i.status === "ready" &&
            (!i.not_before || i.not_before <= now)
        )
        .sort((a, b) => a.priority - b.priority);
      const item = candidates[0];
      if (!item) return null;
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
      return { item: { ...item }, attempt: { ...attempt } };
    },

    async reportLiveness(input) {
      const behavior = store.livenessBehavior(input.attemptId);
      if (behavior === "throw") throw new Error("transient network error");
      if (!behavior.ok) {
        return { ok: false, renewed: false, reason: "attempt_not_running" };
      }
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

    async recoverStaleClaims() {
      return [];
    },

    async completeAttempt(input) {
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
      if (input.outcome === "succeeded") {
        item.status = input.itemStatusOnSuccess ?? "review";
        item.result_jsonb = input.resultJsonb ?? null;
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
// Fixtures
// ============================================================

function graphWithTemplates(): WorkflowGraph {
  return {
    states: [
      { key: "preparing", kind: "operational" },
      { key: "reviewing", kind: "operational" },
      { key: "closed", kind: "terminal" },
    ],
    transitions: [
      {
        from: "preparing",
        to: "reviewing",
        guards: [],
        authorized_proposers: ["runtime"],
        approval_required: null,
      },
      {
        from: "reviewing",
        to: "closed",
        guards: [],
        authorized_proposers: ["model"],
        approval_required: null,
      },
    ],
    step_bindings: [],
    work_templates: [
      {
        on_enter_state: "preparing",
        work_type: "gather_facts",
        required_capability: "facts",
      },
      {
        on_enter_state: "preparing",
        work_type: "draft_copy",
        required_capability: "copywriting",
        depends_on: ["gather_facts"],
        verification_contract: {},
      },
      {
        on_enter_state: "reviewing",
        work_type: "final_check",
        required_capability: "facts",
      },
    ],
    postconditions: [],
    approvals: [],
    impact_dependencies: {},
    completion: { terminal_states: ["closed"], required_evidence: [] },
  };
}

function makeAdapter(
  mode: string,
  execute: ExecutorAdapter["execute"]
): ExecutorAdapter {
  return { executionMode: mode, execute };
}

const okAdapter = makeAdapter("deterministic_service", async (ctx) => ({
  outcome: "succeeded",
  result: { work_type: ctx.work.item.work_type },
}));

// ============================================================
// Tests
// ============================================================

async function testFullTickWithDependencyChainAndAdvancement(): Promise<void> {
  const store = makeStore();
  const advanced: Array<{ fromState: string; toState: string }> = [];
  const dispatcher = createWorkDispatcher({
    store,
    resolveExecutor: () => okAdapter,
  });

  const result = await dispatcher.runTick({
    userId: USER,
    runnerRef: "tick-1",
    cases: [
      {
        caseId: CASE,
        currentState: "preparing",
        workflowDefinitionVersion: 1,
        graph: graphWithTemplates(),
      },
    ],
    leaseMs: 60_000,
    maxItems: 10,
    advanceCase: async (params) => {
      advanced.push({ fromState: params.fromState, toState: params.toState });
      return true;
    },
  });

  // Instanció los 2 templates de preparing + (tras avanzar) 1 de reviewing.
  assert.equal(result.instantiated, 3);
  // gather_facts → draft_copy → avance → final_check, todo en un tick.
  assert.deepEqual(
    result.processed.map((p) => `${p.workType}:${p.outcome}`),
    ["gather_facts:done", "draft_copy:done", "final_check:done"]
  );
  assert.deepEqual(advanced, [{ fromState: "preparing", toState: "reviewing" }]);
  // reviewing → closed requiere proposer model, no runtime: no se avanza solo.
  assert.equal(result.advanced.length, 1);
  assert.deepEqual(result.errors, []);
  console.log("✓ tick completo: cadena, avance único evaluator-bound, sin avance ambiguo");
}

async function testOutputContractViolationRetriesThenBlocks(): Promise<void> {
  const store = makeStore();
  const dispatcher = createWorkDispatcher({
    store,
    resolveExecutor: () =>
      makeAdapter("deterministic_service", async () => ({
        outcome: "succeeded",
        result: {}, // siempre viola el contrato
      })),
    retryBackoffMs: () => 0, // reintento inmediato para el test
  });

  await store.createWorkItemsFromTemplates({
    userId: USER,
    caseId: CASE,
    workflowDefinitionVersion: 1,
    templates: [
      {
        work_type: "strict_output",
        required_capability: "facts",
        max_attempts: 2,
        output_contract: { required_keys: ["summary"] },
      } as WorkItemTemplateSpec & { output_contract: Record<string, unknown> },
    ],
  });

  const result = await dispatcher.runTick({
    userId: USER,
    runnerRef: "tick-1",
    cases: [],
    leaseMs: 60_000,
    maxItems: 10,
    advanceCase: async () => false,
  });

  assert.deepEqual(
    result.processed.map((p) => p.outcome),
    ["retry", "blocked"],
    "primer intento reintenta; el segundo agota max_attempts"
  );
  const item = store.items[0];
  assert.equal(item.status, "blocked");
  assert.equal(item.blocked_reason, "max_attempts_exhausted");
  console.log("✓ violación de output contract → retry → blocked");
}

async function testNoExecutorForCapabilityBlocks(): Promise<void> {
  const store = makeStore();
  const dispatcher = createWorkDispatcher({
    store,
    resolveExecutor: () => null,
  });
  await store.createWorkItemsFromTemplates({
    userId: USER,
    caseId: CASE,
    workflowDefinitionVersion: 1,
    templates: [{ work_type: "exotic", required_capability: "quantum" }],
  });

  const result = await dispatcher.runTick({
    userId: USER,
    runnerRef: "tick-1",
    cases: [],
    leaseMs: 60_000,
    advanceCase: async () => false,
  });

  assert.deepEqual(
    result.processed.map((p) => p.outcome),
    ["blocked"]
  );
  assert.equal(
    store.items[0].blocked_reason,
    "no_executor_for_capability:quantum"
  );
  console.log("✓ capability sin ejecutor → blocked explícito");
}

async function testScopeEnforcementDenyBlocks(): Promise<void> {
  const store = makeStore();
  let executed = 0;
  const dispatcher = createWorkDispatcher({
    store,
    resolveExecutor: () =>
      makeAdapter("registered_specialized_worker", async () => {
        executed += 1;
        return { outcome: "succeeded", result: {} };
      }),
    // 3.4-5: el perfil no permite la tool exigida por el contrato ⇒ deny en
    // la SELECCIÓN — el ejecutor jamás corre.
    enforceScopes: async (item) =>
      Array.isArray(item.input_contract_jsonb.required_tools)
        ? { ok: false, reason: "scope_mismatch:tool_not_allowed:easybroker_write" }
        : { ok: true },
  });
  await store.createWorkItemsFromTemplates({
    userId: USER,
    caseId: CASE,
    workflowDefinitionVersion: 1,
    templates: [
      {
        work_type: "sensitive_write",
        required_capability: "agent:writer",
        input_contract: { required_tools: ["easybroker_write"] },
      },
    ],
  });

  const result = await dispatcher.runTick({
    userId: USER,
    runnerRef: "tick-1",
    cases: [],
    leaseMs: 60_000,
    advanceCase: async () => false,
  });

  assert.deepEqual(
    result.processed.map((p) => p.outcome),
    ["blocked"]
  );
  assert.equal(executed, 0, "deny en selección: el ejecutor no corre");
  assert.equal(
    store.items[0].blocked_reason,
    "scope_mismatch:tool_not_allowed:easybroker_write"
  );
  assert.equal(store.items[0].status, "blocked");
  console.log("✓ scope enforcement en selección → deny + blocked_reason");
}

async function testHumanReviewParksItemInReview(): Promise<void> {
  const store = makeStore();
  const dispatcher = createWorkDispatcher({
    store,
    resolveExecutor: () =>
      makeAdapter("human", async () => ({
        outcome: "succeeded",
        requiresHumanReview: true,
      })),
  });
  await store.createWorkItemsFromTemplates({
    userId: USER,
    caseId: CASE,
    workflowDefinitionVersion: 1,
    templates: [{ work_type: "manual_check", required_capability: "human" }],
  });

  const result = await dispatcher.runTick({
    userId: USER,
    runnerRef: "tick-1",
    cases: [],
    leaseMs: 60_000,
    advanceCase: async () => false,
  });
  assert.deepEqual(
    result.processed.map((p) => p.outcome),
    ["review"]
  );
  assert.equal(store.items[0].status, "review");
  console.log("✓ modo human → review (no done)");
}

async function testConfirmedClaimLossAbortsExecutor(): Promise<void> {
  const store = makeStore();
  // La primera renovación confirma pérdida del claim.
  store.livenessBehavior = () => ({ ok: false });

  let sawAbort = false;
  const dispatcher = createWorkDispatcher({
    store,
    resolveExecutor: () =>
      makeAdapter("main_agent", async (ctx) => {
        // Ejecutor largo: espera hasta la señal de cancelación.
        await new Promise<void>((resolve) => {
          if (ctx.signal.aborted) return resolve();
          ctx.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        sawAbort = ctx.signal.aborted;
        return { outcome: "succeeded", result: {} };
      }),
  });
  await store.createWorkItemsFromTemplates({
    userId: USER,
    caseId: CASE,
    workflowDefinitionVersion: 1,
    templates: [{ work_type: "long_run", required_capability: "agent" }],
  });

  const result = await dispatcher.runTick({
    userId: USER,
    runnerRef: "tick-1",
    cases: [],
    leaseMs: 90, // renovación cada ~30ms
    advanceCase: async () => false,
  });

  assert.ok(sawAbort, "el ejecutor debe recibir la señal de cancelación");
  assert.deepEqual(
    result.processed.map((p) => p.outcome),
    ["completion_rejected"],
    "con claim perdido no se intenta completion (fail closed)"
  );
  // El item NO fue tocado por este runner: recovery es el dueño de la historia.
  assert.equal(store.items[0].status, "running");
  console.log("✓ pérdida confirmada de claim → abort + sin completion");
}

async function testTransientRenewalFailuresExhaustWindow(): Promise<void> {
  const store = makeStore();
  store.livenessBehavior = () => "throw"; // errores transitorios siempre

  let sawAbort = false;
  const dispatcher = createWorkDispatcher({
    store,
    resolveExecutor: () =>
      makeAdapter("main_agent", async (ctx) => {
        await new Promise<void>((resolve) => {
          if (ctx.signal.aborted) return resolve();
          ctx.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        sawAbort = ctx.signal.aborted;
        return { outcome: "succeeded", result: {} };
      }),
  });
  await store.createWorkItemsFromTemplates({
    userId: USER,
    caseId: CASE,
    workflowDefinitionVersion: 1,
    templates: [{ work_type: "long_run", required_capability: "agent" }],
  });

  const result = await dispatcher.runTick({
    userId: USER,
    runnerRef: "tick-1",
    cases: [],
    // lease 90ms / intervalo 30ms ⇒ umbral derivado = 3 fallos consecutivos
    // (una ventana de lease completa sin renovación exitosa).
    leaseMs: 90,
    advanceCase: async () => false,
  });

  assert.ok(sawAbort, "ventana de renovaciones agotada debe abortar");
  assert.deepEqual(
    result.processed.map((p) => p.outcome),
    ["completion_rejected"]
  );
  console.log("✓ fallos transitorios que agotan la ventana del lease → abort");
}

function testAdvancementPredicateUnit(): void {
  const graph = graphWithTemplates();
  const baseItem = (over: Partial<WorkItem>): WorkItem =>
    ({
      id: randomUUID(),
      case_id: CASE,
      work_run_id: null,
      user_id: USER,
      workflow_definition_version: 1,
      work_type: "gather_facts",
      origin: "definition_template",
      status: "done",
      priority: 100,
      required_capability: "facts",
      assigned_worker_profile_id: null,
      not_before: null,
      due_at: null,
      attempt_count: 1,
      max_attempts: 3,
      current_attempt_id: null,
      blocked_reason: null,
      input_contract_jsonb: {},
      output_contract_jsonb: {},
      verification_contract_jsonb: {},
      result_jsonb: null,
      idempotency_key: `preparing:${over.work_type ?? "gather_facts"}`,
      version: 1,
      created_at: "",
      updated_at: "",
      ...over,
    }) as WorkItem;

  // Incompleto: falta draft_copy done.
  const incomplete = evaluateAdvancement(graph, "preparing", [
    baseItem({ work_type: "gather_facts" }),
    baseItem({ work_type: "draft_copy", status: "running" }),
  ]);
  assert.equal(incomplete.satisfied, false);
  assert.equal(incomplete.reason, "work_incomplete");

  // Completo → avanza a reviewing.
  const complete = evaluateAdvancement(graph, "preparing", [
    baseItem({ work_type: "gather_facts" }),
    baseItem({ work_type: "draft_copy" }),
  ]);
  assert.deepEqual(complete, {
    satisfied: true,
    toState: "reviewing",
    reason: "advance",
  });

  // reviewing → closed no está autorizado para runtime.
  const noRuntime = evaluateAdvancement(graph, "reviewing", [
    baseItem({
      work_type: "final_check",
      idempotency_key: "reviewing:final_check",
    }),
  ]);
  assert.equal(noRuntime.reason, "no_runtime_transition");

  // Estado sin templates jamás avanza desde el work plane.
  const noTemplates = evaluateAdvancement(graph, "closed", []);
  assert.equal(noTemplates.reason, "no_templates_for_state");

  // Ambigüedad: dos transiciones runtime → no adivinar.
  const ambiguous: WorkflowGraph = {
    ...graph,
    transitions: [
      ...graph.transitions,
      {
        from: "preparing",
        to: "closed",
        guards: [],
        authorized_proposers: ["runtime"],
        approval_required: null,
      },
    ],
  };
  const ambiguousDecision = evaluateAdvancement(ambiguous, "preparing", [
    baseItem({ work_type: "gather_facts" }),
    baseItem({ work_type: "draft_copy" }),
  ]);
  assert.equal(ambiguousDecision.reason, "ambiguous_transitions");
  console.log("✓ advancement predicate: incompleto/completo/no-runtime/ambiguo");
}

function testVerifyOutputContractUnit(): void {
  assert.deepEqual(verifyOutputContract({}, undefined), {
    ok: true,
    missingKeys: [],
  });
  assert.deepEqual(
    verifyOutputContract({ required_keys: ["a", "b"] }, { a: 1 }),
    { ok: false, missingKeys: ["b"] }
  );
  assert.deepEqual(
    verifyOutputContract({ required_keys: ["a"] }, { a: null }),
    { ok: false, missingKeys: ["a"] }
  );
  assert.deepEqual(
    verifyOutputContract({ required_keys: ["a"] }, { a: 0 }),
    { ok: true, missingKeys: [] }
  );
  console.log("✓ verifyOutputContract (mínimo Phase 2)");
}

function testTemplateSpecsForStateUnit(): void {
  const specs = templateSpecsForState(graphWithTemplates(), "preparing");
  assert.equal(specs.length, 2);
  assert.equal(specs[0].required_capability, "facts");
  assert.deepEqual(specs[1].depends_on, ["gather_facts"]);
  assert.deepEqual(templateSpecsForState(graphWithTemplates(), "closed"), []);
  console.log("✓ templateSpecsForState");
}

async function main(): Promise<void> {
  testVerifyOutputContractUnit();
  testTemplateSpecsForStateUnit();
  testAdvancementPredicateUnit();
  await testFullTickWithDependencyChainAndAdvancement();
  await testOutputContractViolationRetriesThenBlocks();
  await testNoExecutorForCapabilityBlocks();
  await testScopeEnforcementDenyBlocks();
  await testHumanReviewParksItemInReview();
  await testConfirmedClaimLossAbortsExecutor();
  await testTransientRenewalFailuresExhaustWindow();
  console.log("dispatcher selftest: all green");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
