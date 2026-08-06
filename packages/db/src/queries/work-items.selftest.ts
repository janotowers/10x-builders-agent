/**
 * Selftests del plano de trabajo (Slice 2.2-3).
 *
 * Corren contra un fake in-memory del cliente supabase que reproduce la
 * semántica que el módulo necesita: filtros, unique constraints
 * (work_items(case_id, idempotency_key), work_item_attempts(work_item_id,
 * attempt_number), PK de dependencias) y un hook para inyectar carreras.
 *
 * Cobertura exigida por el plan: contención CAS (dos claimers, gana uno),
 * stale-claim recovery (attempt expirado → evento claim_expired + padre ready
 * + nada incrementado), max-attempts → blocked + reason, propagación de
 * readiness con fan-in/fan-out, liveness vs renovación de lease (2.2-4) y
 * fail-closed de completion con claim perdido (2.3-6).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { DbClient } from "../client";
import type { WorkItem, WorkItemAttempt, WorkItemEvent } from "@agents/types";
import {
  approveReviewedItem,
  blockItem,
  claimNextReady,
  completeAttempt,
  createWorkItemsFromTemplates,
  getWorkItemById,
  listWorkItemEvents,
  propagateReadiness,
  recoverStaleClaims,
  reportLiveness,
} from "./work-items";

// ============================================================
// Fake in-memory
// ============================================================

type Row = Record<string, unknown>;

interface FakeStore {
  work_items: Row[];
  work_item_attempts: Row[];
  work_item_dependencies: Row[];
  work_item_events: Row[];
}

interface FakeDb {
  client: DbClient;
  store: FakeStore;
  /** Inyecta una mutación que corre justo antes del PRÓXIMO update a la tabla. */
  queueBeforeUpdate(table: keyof FakeStore, fn: (store: FakeStore) => void): void;
}

const TABLE_DEFAULTS: Record<keyof FakeStore, () => Row> = {
  work_items: () => ({
    assigned_worker_profile_id: null,
    not_before: null,
    due_at: null,
    attempt_count: 0,
    max_attempts: 3,
    current_attempt_id: null,
    blocked_reason: null,
    result_jsonb: null,
    idempotency_key: null,
    version: 1,
  }),
  work_item_attempts: () => ({
    executor_ref: null,
    worker_profile_id: null,
    last_liveness_at: null,
    last_progress_at: null,
    completed_at: null,
    error_jsonb: null,
    evidence_jsonb: null,
  }),
  work_item_dependencies: () => ({ dependency_kind: "finish_to_start" }),
  work_item_events: () => ({ attempt_id: null, payload_jsonb: {} }),
};

function uniqueViolation(store: FakeStore, table: keyof FakeStore, row: Row): boolean {
  if (table === "work_items") {
    if (row.idempotency_key == null) return false;
    return store.work_items.some(
      (r) =>
        r.case_id === row.case_id && r.idempotency_key === row.idempotency_key
    );
  }
  if (table === "work_item_attempts") {
    return store.work_item_attempts.some(
      (r) =>
        r.work_item_id === row.work_item_id &&
        r.attempt_number === row.attempt_number
    );
  }
  if (table === "work_item_dependencies") {
    return store.work_item_dependencies.some(
      (r) =>
        r.work_item_id === row.work_item_id &&
        r.depends_on_id === row.depends_on_id
    );
  }
  return false;
}

function makeFakeDb(): FakeDb {
  const store: FakeStore = {
    work_items: [],
    work_item_attempts: [],
    work_item_dependencies: [],
    work_item_events: [],
  };
  const beforeUpdateHooks = new Map<string, Array<(s: FakeStore) => void>>();

  function from(table: keyof FakeStore) {
    type Filter =
      | { kind: "eq"; col: string; val: unknown }
      | { kind: "in"; col: string; vals: unknown[] }
      | { kind: "lt"; col: string; val: unknown };
    const state = {
      op: "select" as "select" | "insert" | "update",
      rows: [] as Row[],
      patch: {} as Row,
      filters: [] as Filter[],
      orders: [] as Array<{ col: string; ascending: boolean }>,
      limitN: null as number | null,
      mode: "many" as "many" | "single" | "maybeSingle",
      returning: false,
    };

    function matches(row: Row): boolean {
      return state.filters.every((f) => {
        if (f.kind === "eq") return row[f.col] === f.val;
        if (f.kind === "in") return f.vals.includes(row[f.col]);
        return (
          typeof row[f.col] === "string" &&
          typeof f.val === "string" &&
          (row[f.col] as string) < f.val
        );
      });
    }

    function execute(): { data: unknown; error: { code?: string; message: string } | null } {
      if (state.op === "insert") {
        const inserted: Row[] = [];
        for (const raw of state.rows) {
          if (uniqueViolation(store, table, raw)) {
            return {
              data: null,
              error: { code: "23505", message: `duplicate key on ${table}` },
            };
          }
          const row: Row = {
            id: randomUUID(),
            created_at: new Date().toISOString(),
            ...(table === "work_items"
              ? { updated_at: new Date().toISOString() }
              : {}),
            ...TABLE_DEFAULTS[table](),
            ...raw,
          };
          store[table].push(row);
          inserted.push(row);
        }
        return finish(inserted);
      }
      if (state.op === "update") {
        const hooks = beforeUpdateHooks.get(table) ?? [];
        const hook = hooks.shift();
        if (hook) hook(store);
        const affected = store[table].filter(matches);
        for (const row of affected) Object.assign(row, state.patch);
        return finish(affected);
      }
      let rows = store[table].filter(matches);
      if (state.orders.length > 0) {
        rows = [...rows].sort((a, b) => {
          for (const o of state.orders) {
            const av = a[o.col] as string | number | null;
            const bv = b[o.col] as string | number | null;
            if (av === bv) continue;
            if (av == null) return o.ascending ? -1 : 1;
            if (bv == null) return o.ascending ? 1 : -1;
            const cmp = av < bv ? -1 : 1;
            return o.ascending ? cmp : -cmp;
          }
          return 0;
        });
      }
      if (state.limitN != null) rows = rows.slice(0, state.limitN);
      return finish(rows);
    }

    function finish(rows: Row[]): {
      data: unknown;
      error: { code?: string; message: string } | null;
    } {
      const copies = rows.map((r) => ({ ...r }));
      if (state.mode === "single") {
        if (copies.length !== 1) {
          return {
            data: null,
            error: { message: `expected 1 row, got ${copies.length}` },
          };
        }
        return { data: copies[0], error: null };
      }
      if (state.mode === "maybeSingle") {
        if (copies.length > 1) {
          return {
            data: null,
            error: { message: `expected <=1 row, got ${copies.length}` },
          };
        }
        return { data: copies[0] ?? null, error: null };
      }
      return { data: copies, error: null };
    }

    const builder: Record<string, unknown> = {
      select: () => {
        state.returning = true;
        return builder;
      },
      insert: (rows: Row | Row[]) => {
        state.op = "insert";
        state.rows = Array.isArray(rows) ? rows : [rows];
        return builder;
      },
      update: (patch: Row) => {
        state.op = "update";
        state.patch = patch;
        return builder;
      },
      eq: (col: string, val: unknown) => {
        state.filters.push({ kind: "eq", col, val });
        return builder;
      },
      in: (col: string, vals: unknown[]) => {
        state.filters.push({ kind: "in", col, vals });
        return builder;
      },
      lt: (col: string, val: unknown) => {
        state.filters.push({ kind: "lt", col, val });
        return builder;
      },
      order: (col: string, opts?: { ascending?: boolean }) => {
        state.orders.push({ col, ascending: opts?.ascending ?? true });
        return builder;
      },
      limit: (n: number) => {
        state.limitN = n;
        return builder;
      },
      single: () => {
        state.mode = "single";
        return builder;
      },
      maybeSingle: () => {
        state.mode = "maybeSingle";
        return builder;
      },
      then: (
        resolve: (value: unknown) => unknown,
        reject?: (reason: unknown) => unknown
      ) => {
        try {
          return Promise.resolve(execute()).then(resolve, reject);
        } catch (err) {
          return Promise.reject(err).then(resolve, reject);
        }
      },
    };
    return builder;
  }

  return {
    client: { from } as unknown as DbClient,
    store,
    queueBeforeUpdate(table, fn) {
      const list = beforeUpdateHooks.get(table) ?? [];
      list.push(fn);
      beforeUpdateHooks.set(table, list);
    },
  };
}

// ============================================================
// Helpers de fixture
// ============================================================

const USER = "user-1";
const CASE = "case-1";

async function seedChain(fake: FakeDb): Promise<{ a: WorkItem; b: WorkItem; c: WorkItem; d: WorkItem }> {
  // Fan-out: b y c dependen de a. Fan-in: d depende de b y c.
  const { created } = await createWorkItemsFromTemplates(fake.client, {
    userId: USER,
    caseId: CASE,
    workflowDefinitionVersion: 1,
    onEnterState: "materials_in_preparation",
    templates: [
      { work_type: "gather_facts", required_capability: "case_management" },
      {
        work_type: "draft_description",
        required_capability: "listing_copy",
        depends_on: ["gather_facts"],
      },
      {
        work_type: "collect_photos",
        required_capability: "case_management",
        depends_on: ["gather_facts"],
      },
      {
        work_type: "assemble_package",
        required_capability: "case_management",
        depends_on: ["draft_description", "collect_photos"],
      },
    ],
  });
  const byType = new Map(created.map((i) => [i.work_type, i]));
  return {
    a: byType.get("gather_facts")!,
    b: byType.get("draft_description")!,
    c: byType.get("collect_photos")!,
    d: byType.get("assemble_package")!,
  };
}

function eventsOf(fake: FakeDb, itemId: string): WorkItemEvent[] {
  return fake.store.work_item_events.filter(
    (e) => e.work_item_id === itemId
  ) as unknown as WorkItemEvent[];
}

async function claimAndFinish(
  fake: FakeDb,
  itemId: string,
  outcome: "succeeded" | "failed" = "succeeded"
): Promise<void> {
  const claimed = await claimNextReady(fake.client, {
    userId: USER,
    runnerRef: "runner-helper",
    executorKind: "deterministic_service",
    leaseMs: 60_000,
  });
  assert.ok(claimed && claimed.item.id === itemId, `expected to claim ${itemId}`);
  const done = await completeAttempt(fake.client, {
    userId: USER,
    attemptId: claimed.attempt.id,
    outcome,
    itemStatusOnSuccess: "done",
  });
  assert.ok(done.ok, "helper completion should succeed");
}

// ============================================================
// Tests
// ============================================================

async function testTemplateInstantiationIsIdempotent(): Promise<void> {
  const fake = makeFakeDb();
  const first = await seedChain(fake);
  assert.equal(fake.store.work_items.length, 4);
  assert.equal(first.a.origin, "definition_template");
  assert.equal(first.a.status, "todo");
  assert.equal(first.a.idempotency_key, "materials_in_preparation:gather_facts");
  assert.equal(fake.store.work_item_dependencies.length, 4);
  assert.ok(
    eventsOf(fake, first.a.id).some((e) => e.event_type === "created"),
    "created event expected"
  );

  // Reentrada al mismo estado: nada se duplica.
  const second = await createWorkItemsFromTemplates(fake.client, {
    userId: USER,
    caseId: CASE,
    workflowDefinitionVersion: 1,
    onEnterState: "materials_in_preparation",
    templates: [
      { work_type: "gather_facts", required_capability: "case_management" },
    ],
  });
  assert.equal(second.created.length, 0);
  assert.equal(second.existing.length, 1);
  assert.equal(fake.store.work_items.length, 4);

  // Sibling desconocido en depends_on truena explícitamente.
  await assert.rejects(
    createWorkItemsFromTemplates(fake.client, {
      userId: USER,
      caseId: "case-2",
      workflowDefinitionVersion: 1,
      templates: [
        {
          work_type: "x",
          required_capability: "case_management",
          depends_on: ["missing_sibling"],
        },
      ],
    }),
    /unknown sibling/
  );
  console.log("✓ template instantiation idempotente + origin estampado");
}

async function testReadinessFanOutFanIn(): Promise<void> {
  const fake = makeFakeDb();
  const { a, b, c, d } = await seedChain(fake);

  // Solo a (sin dependencias) queda ready.
  const r1 = await propagateReadiness(fake.client, { userId: USER });
  assert.deepEqual(r1.readyIds, [a.id]);
  assert.ok(eventsOf(fake, a.id).some((e) => e.event_type === "ready"));

  // a done → fan-out: b y c ready; d (fan-in) sigue todo.
  await claimAndFinish(fake, a.id);
  const r2 = await propagateReadiness(fake.client, { userId: USER });
  assert.deepEqual(new Set(r2.readyIds), new Set([b.id, c.id]));
  assert.equal((await getWorkItemById(fake.client, USER, d.id))?.status, "todo");

  // Solo b done → d aún no (fan-in incompleto).
  await claimAndFinish(fake, b.id);
  const r3 = await propagateReadiness(fake.client, { userId: USER });
  assert.deepEqual(r3.readyIds, []);

  // c done → d ready.
  await claimAndFinish(fake, c.id);
  const r4 = await propagateReadiness(fake.client, { userId: USER });
  assert.deepEqual(r4.readyIds, [d.id]);

  // Ticks repetidos son idempotentes.
  const r5 = await propagateReadiness(fake.client, { userId: USER });
  assert.deepEqual(r5.readyIds, []);
  console.log("✓ readiness fan-out / fan-in / idempotencia");
}

async function testReadinessRespectsNotBefore(): Promise<void> {
  const fake = makeFakeDb();
  const future = new Date(Date.now() + 3_600_000).toISOString();
  await createWorkItemsFromTemplates(fake.client, {
    userId: USER,
    caseId: CASE,
    workflowDefinitionVersion: 1,
    templates: [
      { work_type: "delayed", required_capability: "x", not_before: future },
    ],
  });
  const r = await propagateReadiness(fake.client, { userId: USER });
  assert.deepEqual(r.readyIds, [], "not_before futuro bloquea readiness");
  console.log("✓ readiness respeta not_before");
}

async function testClaimContentionUniqueArbiter(): Promise<void> {
  const fake = makeFakeDb();
  const { a } = await seedChain(fake);
  await propagateReadiness(fake.client, { userId: USER });

  // Racer: ya insertó el attempt_number 1 para a (árbitro 1: unique).
  fake.store.work_item_attempts.push({
    id: randomUUID(),
    work_item_id: a.id,
    user_id: USER,
    attempt_number: 1,
    executor_kind: "main_agent",
    executor_ref: "racer",
    worker_profile_id: null,
    status: "running",
    claimed_at: new Date().toISOString(),
    claim_expires_at: new Date(Date.now() + 60_000).toISOString(),
    last_liveness_at: null,
    last_progress_at: null,
    completed_at: null,
    error_jsonb: null,
    evidence_jsonb: null,
    created_at: new Date().toISOString(),
  });

  const claimed = await claimNextReady(fake.client, {
    userId: USER,
    runnerRef: "loser",
    executorKind: "main_agent",
    leaseMs: 60_000,
  });
  // a era el único candidato ready → el perdedor no obtiene nada.
  assert.equal(claimed, null, "unique constraint debe arbitrar el doble claim");
  // Sin doble claim silencioso: no hay evento claimed del perdedor.
  const claimedEvents = eventsOf(fake, a.id).filter(
    (e) => e.event_type === "claimed"
  );
  assert.equal(claimedEvents.length, 0);
  console.log("✓ contención CAS: árbitro 1 (unique attempt_number)");
}

async function testClaimContentionCasArbiter(): Promise<void> {
  const fake = makeFakeDb();
  const { a } = await seedChain(fake);
  await propagateReadiness(fake.client, { userId: USER });

  // Racer gana el CAS entre nuestra lectura y nuestro update: simulamos
  // bumpeando la version del padre justo antes del update de work_items.
  fake.queueBeforeUpdate("work_items", (store) => {
    const row = store.work_items.find((r) => r.id === a.id)!;
    row.version = (row.version as number) + 1;
    row.status = "running";
  });

  const claimed = await claimNextReady(fake.client, {
    userId: USER,
    runnerRef: "loser",
    executorKind: "main_agent",
    leaseMs: 60_000,
  });
  assert.equal(claimed, null, "CAS perdido no debe devolver el item");

  // El attempt huérfano quedó cancelado de forma visible, no colgado.
  const orphan = fake.store.work_item_attempts.find(
    (r) => r.executor_ref === "loser"
  ) as unknown as WorkItemAttempt;
  assert.equal(orphan.status, "cancelled");
  assert.deepEqual(orphan.error_jsonb, { reason: "claim_cas_lost" });
  console.log("✓ contención CAS: árbitro 2 (version) cancela el attempt huérfano");
}

async function testStaleClaimRecovery(): Promise<void> {
  const fake = makeFakeDb();
  const { a } = await seedChain(fake);
  await propagateReadiness(fake.client, { userId: USER });

  const claimed = await claimNextReady(fake.client, {
    userId: USER,
    runnerRef: "runner-1",
    executorKind: "main_agent",
    leaseMs: 60_000,
  });
  assert.ok(claimed);
  const itemAfterClaim = await getWorkItemById(fake.client, USER, a.id);
  assert.equal(itemAfterClaim?.attempt_count, 1);

  // Vence el lease.
  const attemptRow = fake.store.work_item_attempts.find(
    (r) => r.id === claimed.attempt.id
  )!;
  attemptRow.claim_expires_at = new Date(Date.now() - 1_000).toISOString();

  const recovered = await recoverStaleClaims(fake.client, { userId: USER });
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].outcome, "ready");

  const item = await getWorkItemById(fake.client, USER, a.id);
  assert.equal(item?.status, "ready");
  assert.equal(item?.current_attempt_id, null);
  assert.equal(item?.attempt_count, 1, "recovery no incrementa nada");
  assert.equal(attemptRow.status, "claim_expired");
  assert.ok(
    eventsOf(fake, a.id).some((e) => e.event_type === "claim_expired"),
    "evento claim_expired visible"
  );

  // El item vuelve a ser reclamable (attempt 2).
  const reclaimed = await claimNextReady(fake.client, {
    userId: USER,
    runnerRef: "runner-2",
    executorKind: "main_agent",
    leaseMs: 60_000,
  });
  assert.ok(reclaimed && reclaimed.attempt.attempt_number === 2);
  console.log("✓ stale-claim recovery: claim_expired + ready + nada incrementado");
}

async function testMaxAttemptsBlocksOnExpiredLastAttempt(): Promise<void> {
  const fake = makeFakeDb();
  await createWorkItemsFromTemplates(fake.client, {
    userId: USER,
    caseId: CASE,
    workflowDefinitionVersion: 1,
    templates: [
      { work_type: "fragile", required_capability: "x", max_attempts: 1 },
    ],
  });
  await propagateReadiness(fake.client, { userId: USER });
  const claimed = await claimNextReady(fake.client, {
    userId: USER,
    runnerRef: "runner-1",
    executorKind: "main_agent",
    leaseMs: 60_000,
  });
  assert.ok(claimed);
  fake.store.work_item_attempts.find(
    (r) => r.id === claimed.attempt.id
  )!.claim_expires_at = new Date(Date.now() - 1_000).toISOString();

  const recovered = await recoverStaleClaims(fake.client, { userId: USER });
  assert.equal(recovered[0].outcome, "blocked");
  const item = await getWorkItemById(fake.client, USER, claimed.item.id);
  assert.equal(item?.status, "blocked");
  assert.equal(item?.blocked_reason, "max_attempts_exhausted");
  assert.ok(
    eventsOf(fake, claimed.item.id).some((e) => e.event_type === "blocked")
  );
  console.log("✓ max-attempts agotado en recovery → blocked + reason");
}

async function testMaxAttemptsBlocksOnFailure(): Promise<void> {
  const fake = makeFakeDb();
  await createWorkItemsFromTemplates(fake.client, {
    userId: USER,
    caseId: CASE,
    workflowDefinitionVersion: 1,
    templates: [
      { work_type: "flaky", required_capability: "x", max_attempts: 2 },
    ],
  });
  await propagateReadiness(fake.client, { userId: USER });

  // Intento 1 falla → reintento (ready).
  const c1 = await claimNextReady(fake.client, {
    userId: USER,
    runnerRef: "r",
    executorKind: "main_agent",
    leaseMs: 60_000,
  });
  assert.ok(c1);
  const f1 = await completeAttempt(fake.client, {
    userId: USER,
    attemptId: c1.attempt.id,
    outcome: "failed",
    errorJsonb: { message: "boom" },
  });
  assert.ok(f1.ok && f1.itemStatus === "ready");
  assert.ok(
    eventsOf(fake, c1.item.id).some((e) => e.event_type === "attempt_failed")
  );

  // Intento 2 falla → blocked + reason.
  const c2 = await claimNextReady(fake.client, {
    userId: USER,
    runnerRef: "r",
    executorKind: "main_agent",
    leaseMs: 60_000,
  });
  assert.ok(c2 && c2.attempt.attempt_number === 2);
  const f2 = await completeAttempt(fake.client, {
    userId: USER,
    attemptId: c2.attempt.id,
    outcome: "failed",
    errorJsonb: { message: "boom again" },
  });
  assert.ok(f2.ok && f2.itemStatus === "blocked");
  const item = await getWorkItemById(fake.client, USER, c2.item.id);
  assert.equal(item?.blocked_reason, "max_attempts_exhausted");
  console.log("✓ max-attempts agotado en fallo → blocked + reason");
}

async function testLivenessVersusLeaseRenewal(): Promise<void> {
  const fake = makeFakeDb();
  await seedChain(fake);
  await propagateReadiness(fake.client, { userId: USER });
  const claimed = await claimNextReady(fake.client, {
    userId: USER,
    runnerRef: "runner-1",
    executorKind: "main_agent",
    leaseMs: 60_000,
  });
  assert.ok(claimed);
  const originalExpiry = claimed.attempt.claim_expires_at;

  // Liveness sin renovación: expiry intacto, sin evento claim_renewed (2.2-4).
  const l1 = await reportLiveness(fake.client, {
    userId: USER,
    attemptId: claimed.attempt.id,
  });
  assert.ok(l1.ok && !l1.renewed);
  const row = fake.store.work_item_attempts.find(
    (r) => r.id === claimed.attempt.id
  )!;
  assert.equal(row.claim_expires_at, originalExpiry);
  assert.ok(row.last_liveness_at != null);
  const events1 = eventsOf(fake, claimed.item.id);
  assert.ok(events1.some((e) => e.event_type === "liveness_updated"));
  assert.ok(!events1.some((e) => e.event_type === "claim_renewed"));

  // Renovación: expiry extendido + evento claim_renewed propio.
  const l2 = await reportLiveness(fake.client, {
    userId: USER,
    attemptId: claimed.attempt.id,
    renewLeaseMs: 120_000,
  });
  assert.ok(l2.ok && l2.renewed);
  assert.ok((row.claim_expires_at as string) > originalExpiry);
  assert.ok(
    eventsOf(fake, claimed.item.id).some((e) => e.event_type === "claim_renewed")
  );

  // Attempt no-running: liveness falla cerrado.
  row.status = "claim_expired";
  const l3 = await reportLiveness(fake.client, {
    userId: USER,
    attemptId: claimed.attempt.id,
  });
  assert.ok(!l3.ok && l3.reason === "attempt_not_running");
  console.log("✓ liveness ≠ renovación de lease (eventos separados)");
}

async function testCompletionFailsClosedOnLostClaim(): Promise<void> {
  const fake = makeFakeDb();
  const { a } = await seedChain(fake);
  await propagateReadiness(fake.client, { userId: USER });
  const claimed = await claimNextReady(fake.client, {
    userId: USER,
    runnerRef: "runner-1",
    executorKind: "main_agent",
    leaseMs: 60_000,
  });
  assert.ok(claimed);
  const attemptRow = fake.store.work_item_attempts.find(
    (r) => r.id === claimed.attempt.id
  )!;

  // Lease vencido pero recovery aún no corre → fail closed.
  attemptRow.claim_expires_at = new Date(Date.now() - 1_000).toISOString();
  const r1 = await completeAttempt(fake.client, {
    userId: USER,
    attemptId: claimed.attempt.id,
    outcome: "succeeded",
    itemStatusOnSuccess: "done",
  });
  assert.ok(!r1.ok && r1.reason === "lease_expired");

  // Recovery reasigna; completion tardía del attempt viejo → rechazada.
  await recoverStaleClaims(fake.client, { userId: USER });
  const reclaimed = await claimNextReady(fake.client, {
    userId: USER,
    runnerRef: "runner-2",
    executorKind: "main_agent",
    leaseMs: 60_000,
  });
  assert.ok(reclaimed && reclaimed.item.id === a.id);
  const r2 = await completeAttempt(fake.client, {
    userId: USER,
    attemptId: claimed.attempt.id,
    outcome: "succeeded",
    itemStatusOnSuccess: "done",
  });
  assert.ok(!r2.ok, "completion tardía tras reasignación debe rechazarse");

  // El nuevo dueño sí puede completar.
  const r3 = await completeAttempt(fake.client, {
    userId: USER,
    attemptId: reclaimed.attempt.id,
    outcome: "succeeded",
    itemStatusOnSuccess: "done",
    resultJsonb: { note: "ok" },
  });
  assert.ok(r3.ok && r3.itemStatus === "done");
  assert.ok(eventsOf(fake, a.id).some((e) => e.event_type === "done"));
  console.log("✓ completion fail-closed: lease vencido y claim perdido");
}

async function testBlockItemAndEventLog(): Promise<void> {
  const fake = makeFakeDb();
  const { a } = await seedChain(fake);
  const blocked = await blockItem(fake.client, {
    userId: USER,
    itemId: a.id,
    reason: "missing_required_asset",
  });
  assert.equal(blocked?.status, "blocked");
  assert.equal(blocked?.blocked_reason, "missing_required_asset");

  const events = await listWorkItemEvents(fake.client, USER, a.id);
  assert.ok(events.some((e) => e.event_type === "blocked"));
  console.log("✓ blockItem + event log");
}

async function testReviewedItemStoresResolutionEvidence(): Promise<void> {
  const fake = makeFakeDb();
  const { a } = await seedChain(fake);
  const row = fake.store.work_items.find((item) => item.id === a.id)!;
  row.status = "review";
  row.result_jsonb = { verdict: "fail" };

  const resolved = await approveReviewedItem(fake.client, {
    userId: USER,
    itemId: a.id,
    resolution: {
      source: "price_business_decision",
      decision: "human_override_approved",
      rationale: "Acepto Avaclick como base",
      relatedEventKind: "price_approved",
    },
  });

  assert.equal(resolved?.status, "done");
  assert.deepEqual(
    (resolved?.result_jsonb as Record<string, unknown>).review_resolution,
    {
      source: "price_business_decision",
      decision: "human_override_approved",
      rationale: "Acepto Avaclick como base",
      related_event_kind: "price_approved",
      resolved_at: (
        (resolved?.result_jsonb as Record<string, unknown>)
          .review_resolution as Record<string, unknown>
      ).resolved_at,
      resolved_by: USER,
    }
  );
  const doneEvent = eventsOf(fake, a.id).find(
    (event) => event.event_type === "done"
  );
  assert.equal(
    (
      (doneEvent?.payload_jsonb as Record<string, unknown>)
        .review_resolution as Record<string, unknown>
    ).decision,
    "human_override_approved"
  );
  console.log("✓ review→done conserva evidencia de resolución");
}

async function testTenantScoping(): Promise<void> {
  const fake = makeFakeDb();
  await seedChain(fake);
  await propagateReadiness(fake.client, { userId: USER });

  // Otro tenant no ve ni reclama nada.
  const foreign = await claimNextReady(fake.client, {
    userId: "user-2",
    runnerRef: "intruder",
    executorKind: "main_agent",
    leaseMs: 60_000,
  });
  assert.equal(foreign, null);
  const foreignReadiness = await propagateReadiness(fake.client, {
    userId: "user-2",
  });
  assert.deepEqual(foreignReadiness.readyIds, []);
  console.log("✓ tenant scoping (userId requerido en todo)");
}

async function main(): Promise<void> {
  await testTemplateInstantiationIsIdempotent();
  await testReadinessFanOutFanIn();
  await testReadinessRespectsNotBefore();
  await testClaimContentionUniqueArbiter();
  await testClaimContentionCasArbiter();
  await testStaleClaimRecovery();
  await testMaxAttemptsBlocksOnExpiredLastAttempt();
  await testMaxAttemptsBlocksOnFailure();
  await testLivenessVersusLeaseRenewal();
  await testCompletionFailsClosedOnLostClaim();
  await testBlockItemAndEventLog();
  await testReviewedItemStoresResolutionEvidence();
  await testTenantScoping();
  console.log("work-items selftest: all green");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
