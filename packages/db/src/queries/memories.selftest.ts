import assert from "node:assert/strict";
import type { DbClient } from "../client";
import {
  listMemories,
  archiveMemory,
  restoreMemory,
  deleteMemory,
  logMemoryAction,
} from "./memories";

interface RecordedCall {
  method: string;
  args: unknown[];
}

interface ChainResult {
  data: unknown;
  error: unknown;
  count?: number | null;
}

/**
 * Construye un mock encadenable. La diferencia con messages.selftest es
 * que aquí terminamos en `select(...)` o en `range(...)` (await sobre el
 * chain entero), así que cada método devuelve `chain` que es a la vez
 * thenable. El resultado final lo sirve `result()`.
 */
function makeChain(result: () => ChainResult): {
  chain: Record<string, unknown>;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const record = (method: string) =>
    function recorded(this: unknown, ...args: unknown[]): unknown {
      calls.push({ method, args });
      return chain;
    };
  const chain: Record<string, unknown> = {};
  for (const m of [
    "select",
    "eq",
    "is",
    "not",
    "ilike",
    "order",
    "range",
    "limit",
    "in",
    "update",
    "delete",
    "insert",
    "upsert",
  ]) {
    chain[m] = record(m);
  }
  // Hacer el chain awaitable (PromiseLike<ChainResult>).
  chain.then = (
    onFulfilled: (value: ChainResult) => unknown,
    onRejected?: (reason: unknown) => unknown
  ) => Promise.resolve(result()).then(onFulfilled, onRejected);
  // Variantes terminales explícitas (single / maybeSingle).
  chain.maybeSingle = () => Promise.resolve(result());
  chain.single = () => Promise.resolve(result());
  return { chain, calls };
}

function makeDb(result: () => ChainResult): {
  db: DbClient;
  calls: RecordedCall[];
} {
  const { chain, calls } = makeChain(result);
  const db = {
    from: (table: string) => {
      calls.push({ method: "from", args: [table] });
      return chain;
    },
  } as unknown as DbClient;
  return { db, calls };
}

async function testListMemoriesActiveDefault(): Promise<void> {
  const { db, calls } = makeDb(() => ({
    data: [
      {
        id: "m1",
        type: "semantic",
        content: "x",
        retrieval_count: 0,
        created_at: "2026-01-01T00:00:00Z",
        last_retrieved_at: null,
        archived_at: null,
      },
    ],
    error: null,
    count: 1,
  }));
  const res = await listMemories(db, { userId: "u1" });
  assert.equal(res.total, 1, "total = 1");
  assert.equal(res.rows.length, 1, "1 row returned");
  // Active default → debe pedir is('archived_at', null)
  const isCall = calls.find(
    (c) => c.method === "is" && c.args[0] === "archived_at"
  );
  assert.ok(isCall, "active default must filter archived_at IS NULL");
  // Por default ordena por created_at desc
  const order = calls.find((c) => c.method === "order");
  assert.deepEqual(order?.args, ["created_at", { ascending: false }]);
  // Range default 0..49
  const range = calls.find((c) => c.method === "range");
  assert.deepEqual(range?.args, [0, 49]);
}

async function testListMemoriesArchivedAndType(): Promise<void> {
  const { db, calls } = makeDb(() => ({ data: [], error: null, count: 0 }));
  await listMemories(db, {
    userId: "u1",
    status: "archived",
    type: "semantic",
    limit: 25,
    offset: 50,
  });
  const notCall = calls.find(
    (c) => c.method === "not" && c.args[0] === "archived_at"
  );
  assert.ok(notCall, "archived status must filter NOT archived_at IS NULL");
  const typeCall = calls.find(
    (c) => c.method === "eq" && c.args[0] === "type"
  );
  assert.deepEqual(typeCall?.args, ["type", "semantic"]);
  const range = calls.find((c) => c.method === "range");
  assert.deepEqual(range?.args, [50, 74]);
}

async function testListMemoriesIlikeEscapes(): Promise<void> {
  const { db, calls } = makeDb(() => ({ data: [], error: null, count: 0 }));
  await listMemories(db, { userId: "u1", q: "100% rebaja_ahora" });
  const ilike = calls.find((c) => c.method === "ilike");
  assert.equal(ilike?.args[0], "content");
  assert.equal(
    ilike?.args[1],
    "%100\\% rebaja\\_ahora%",
    "ILIKE pattern must escape % and _"
  );
}

async function testListMemoriesSortByArchivedAt(): Promise<void> {
  const { db, calls } = makeDb(() => ({ data: [], error: null, count: 0 }));
  await listMemories(db, {
    userId: "u1",
    status: "archived",
    sortBy: "archived_at",
    sortDir: "asc",
  });
  const order = calls.find((c) => c.method === "order");
  assert.deepEqual(order?.args, ["archived_at", { ascending: true }]);
}

async function testListMemoriesActiveCoercesArchivedSort(): Promise<void> {
  const { db, calls } = makeDb(() => ({ data: [], error: null, count: 0 }));
  await listMemories(db, {
    userId: "u1",
    status: "active",
    sortBy: "archived_at",
    sortDir: "asc",
  });
  const order = calls.find((c) => c.method === "order");
  assert.deepEqual(order?.args, ["created_at", { ascending: true }]);
}

async function testArchiveMemoryReturnsTrueOnHit(): Promise<void> {
  const { db, calls } = makeDb(() => ({
    data: [{ id: "m1" }],
    error: null,
  }));
  const ok = await archiveMemory(db, { userId: "u1", memoryId: "m1" });
  assert.equal(ok, true, "should return true when row was archived");
  const update = calls.find((c) => c.method === "update");
  assert.ok(update, "must call update");
  const updatePayload = update?.args[0] as { archived_at: string };
  assert.ok(
    typeof updatePayload.archived_at === "string" &&
      updatePayload.archived_at.length > 0,
    "must set archived_at to ISO timestamp"
  );
  // Ownership doble-check
  const userEq = calls.find(
    (c) => c.method === "eq" && c.args[0] === "user_id"
  );
  assert.deepEqual(userEq?.args, ["user_id", "u1"]);
  // Solo archiva si actualmente NULL (idempotencia)
  const isNull = calls.find(
    (c) => c.method === "is" && c.args[0] === "archived_at"
  );
  assert.deepEqual(isNull?.args, ["archived_at", null]);
}

async function testArchiveMemoryReturnsFalseOnNoHit(): Promise<void> {
  const { db } = makeDb(() => ({ data: [], error: null }));
  const ok = await archiveMemory(db, { userId: "u1", memoryId: "missing" });
  assert.equal(ok, false, "should return false when no rows updated");
}

async function testRestoreMemoryFiltersArchived(): Promise<void> {
  const { db, calls } = makeDb(() => ({
    data: [{ id: "m1" }],
    error: null,
  }));
  const ok = await restoreMemory(db, { userId: "u1", memoryId: "m1" });
  assert.equal(ok, true);
  const notCall = calls.find(
    (c) => c.method === "not" && c.args[0] === "archived_at"
  );
  assert.ok(notCall, "restore must require archived_at IS NOT NULL");
}

async function testDeleteMemoryRequiresOwnership(): Promise<void> {
  const { db, calls } = makeDb(() => ({
    data: [{ id: "m1" }],
    error: null,
  }));
  const ok = await deleteMemory(db, { userId: "u1", memoryId: "m1" });
  assert.equal(ok, true);
  const userEq = calls.find(
    (c) => c.method === "eq" && c.args[0] === "user_id"
  );
  assert.deepEqual(userEq?.args, ["user_id", "u1"]);
  const idEq = calls.find((c) => c.method === "eq" && c.args[0] === "id");
  assert.deepEqual(idEq?.args, ["id", "m1"]);
}

async function testLogMemoryActionInsertsAndSwallowsErrors(): Promise<void> {
  const { db, calls } = makeDb(() => ({
    data: {
      id: "log1",
      user_id: "u1",
      memory_id: "m1",
      action: "delete",
      details: { reason: "test" },
      performed_at: "2026-01-01T00:00:00Z",
    },
    error: null,
  }));
  const log = await logMemoryAction(db, {
    userId: "u1",
    memoryId: "m1",
    action: "delete",
    details: { reason: "test" },
  });
  assert.equal(log?.id, "log1");
  const insert = calls.find((c) => c.method === "insert");
  const payload = insert?.args[0] as Record<string, unknown>;
  assert.equal(payload.user_id, "u1");
  assert.equal(payload.memory_id, "m1");
  assert.equal(payload.action, "delete");

  // Failure path: missing table → returns null, no throw.
  const { db: db2 } = makeDb(() => ({
    data: null,
    error: { message: "relation memory_audit_log does not exist" },
  }));
  const log2 = await logMemoryAction(db2, {
    userId: "u1",
    memoryId: null,
    action: "archive",
  });
  assert.equal(log2, null);
}

async function main(): Promise<void> {
  await testListMemoriesActiveDefault();
  await testListMemoriesArchivedAndType();
  await testListMemoriesIlikeEscapes();
  await testListMemoriesSortByArchivedAt();
  await testListMemoriesActiveCoercesArchivedSort();
  await testArchiveMemoryReturnsTrueOnHit();
  await testArchiveMemoryReturnsFalseOnNoHit();
  await testRestoreMemoryFiltersArchived();
  await testDeleteMemoryRequiresOwnership();
  await testLogMemoryActionInsertsAndSwallowsErrors();
  console.log("queries/memories.selftest: all 10 cases passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
