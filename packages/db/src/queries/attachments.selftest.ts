import assert from "node:assert/strict";
import type { DbClient } from "../client";
import {
  claimUserFileProcessing,
  createMessageAttachment,
  getUserFile,
  markUserFileFailed,
  markUserFileReady,
  markUserFileUploaded,
} from "./attachments";

type Call = { method: string; args: unknown[] };

function makeDb(): DbClient & { __calls: Call[] } {
  const calls: Call[] = [];
  const response = {
    data: {
      id: "file_1",
      user_id: "user_1",
      status: "processing",
    },
    error: null,
  };
  const chain: Record<string, unknown> = {};
  for (const method of [
    "insert",
    "update",
    "select",
    "eq",
    "in",
    "neq",
    "order",
    "limit",
  ]) {
    chain[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return chain;
    };
  }
  chain.single = async () => response;
  chain.maybeSingle = async () => response;
  const db = {
    from(table: string) {
      calls.push({ method: "from", args: [table] });
      return chain;
    },
    __calls: calls,
  };
  return db as unknown as DbClient & { __calls: Call[] };
}

function hasCall(calls: Call[], method: string, ...args: unknown[]): boolean {
  return calls.some(
    (call) =>
      call.method === method &&
      JSON.stringify(call.args) === JSON.stringify(args)
  );
}

async function testOwnershipFilters(): Promise<void> {
  const db = makeDb();
  await getUserFile(db, { userId: "user_1", fileId: "file_1" });
  assert.ok(hasCall(db.__calls, "eq", "user_id", "user_1"));
  assert.ok(hasCall(db.__calls, "eq", "id", "file_1"));
}

async function testCasLifecycle(): Promise<void> {
  const uploadedDb = makeDb();
  await markUserFileUploaded(uploadedDb, {
    userId: "user_1",
    fileId: "file_1",
  });
  assert.ok(hasCall(uploadedDb.__calls, "eq", "status", "pending_upload"));
  assert.ok(hasCall(uploadedDb.__calls, "eq", "user_id", "user_1"));

  const claimedDb = makeDb();
  await claimUserFileProcessing(claimedDb, {
    userId: "user_1",
    fileId: "file_1",
  });
  assert.ok(hasCall(claimedDb.__calls, "eq", "status", "uploaded"));
  assert.ok(hasCall(claimedDb.__calls, "eq", "user_id", "user_1"));

  const readyDb = makeDb();
  await markUserFileReady(readyDb, {
    userId: "user_1",
    fileId: "file_1",
  });
  assert.ok(hasCall(readyDb.__calls, "eq", "status", "processing"));
  assert.ok(hasCall(readyDb.__calls, "eq", "user_id", "user_1"));

  const failedDb = makeDb();
  await markUserFileFailed(failedDb, {
    userId: "user_1",
    fileId: "file_1",
    error: { code: "extract_failed" },
  });
  assert.ok(
    hasCall(failedDb.__calls, "in", "status", [
      "pending_upload",
      "uploaded",
      "processing",
    ])
  );
  assert.ok(hasCall(failedDb.__calls, "eq", "user_id", "user_1"));
}

async function testAssociationCarriesOwner(): Promise<void> {
  const db = makeDb();
  await createMessageAttachment(db, {
    userId: "user_1",
    fileId: "file_1",
    sessionId: "session_1",
    turnId: "turn_1",
    channel: "web",
    role: "input",
  });
  const insert = db.__calls.find((call) => call.method === "insert");
  assert.deepEqual(insert?.args[0], {
    user_id: "user_1",
    file_id: "file_1",
    session_id: "session_1",
    message_id: null,
    turn_id: "turn_1",
    channel: "web",
    role: "input",
    ordinal: 0,
    metadata_jsonb: {},
    expires_at: null,
  });
}

async function main(): Promise<void> {
  await testOwnershipFilters();
  await testCasLifecycle();
  await testAssociationCarriesOwner();
  console.log("queries/attachments.selftest: all 3 cases passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
