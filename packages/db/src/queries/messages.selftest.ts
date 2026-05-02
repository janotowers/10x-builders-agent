import assert from "node:assert/strict";
import type { DbClient } from "../client";
import type { AgentMessage } from "@agents/types";
import { getSessionMessages } from "./messages";

function message(id: string, createdAt: string): AgentMessage {
  return {
    id,
    session_id: "session-1",
    role: "user",
    content: id,
    created_at: createdAt,
  };
}

function makeDb(rowsNewestFirst: AgentMessage[]): DbClient {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const chain = {
    select: (...args: unknown[]) => {
      calls.push({ method: "select", args });
      return chain;
    },
    eq: (...args: unknown[]) => {
      calls.push({ method: "eq", args });
      return chain;
    },
    order: (...args: unknown[]) => {
      calls.push({ method: "order", args });
      return chain;
    },
    limit: (...args: unknown[]) => {
      calls.push({ method: "limit", args });
      return Promise.resolve({ data: rowsNewestFirst, error: null });
    },
  };
  return {
    from: (table: string) => {
      calls.push({ method: "from", args: [table] });
      return chain;
    },
    __calls: calls,
  } as unknown as DbClient;
}

async function testFetchesNewestThenReturnsChronological(): Promise<void> {
  const newestFirst = [
    message("m5", "2026-05-01T00:05:00Z"),
    message("m4", "2026-05-01T00:04:00Z"),
    message("m3", "2026-05-01T00:03:00Z"),
  ];
  const db = makeDb(newestFirst);

  const got = await getSessionMessages(db, "session-1", 3);

  assert.deepEqual(
    got.map((m) => m.id),
    ["m3", "m4", "m5"],
    "caller should receive selected recent messages in chronological order"
  );

  const calls = (db as unknown as { __calls: Array<{ method: string; args: unknown[] }> })
    .__calls;
  const orderCall = calls.find((c) => c.method === "order");
  assert.deepEqual(orderCall?.args, [
    "created_at",
    { ascending: false },
  ]);
  const limitCall = calls.find((c) => c.method === "limit");
  assert.deepEqual(limitCall?.args, [3]);
}

async function main(): Promise<void> {
  await testFetchesNewestThenReturnsChronological();
  console.log("queries/messages.selftest: all 1 cases passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
