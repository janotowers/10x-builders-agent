import assert from "node:assert/strict";
import {
  caseIdFromPendingToolCall,
  selectStaleSessionPendingIds,
  uniqueCaseIdsFromPendingRows,
} from "./repair-session-pending-confirmations";

const rows = [
  {
    id: "old",
    tool_name: "operational_case_update_state",
    arguments_json: { case_id: "case-a" },
    metadata_jsonb: null,
    created_at: "2026-07-30T17:00:00.000Z",
  },
  {
    id: "new",
    tool_name: "bash",
    arguments_json: {},
    metadata_jsonb: { case_id: "case-b" },
    created_at: "2026-07-30T18:00:00.000Z",
  },
];

assert.equal(caseIdFromPendingToolCall(rows[0]!), "case-a");
assert.equal(caseIdFromPendingToolCall(rows[1]!), "case-b");
assert.deepEqual(uniqueCaseIdsFromPendingRows(rows).sort(), [
  "case-a",
  "case-b",
]);

const selected = selectStaleSessionPendingIds(rows);
assert.equal(selected.keepId, "new");
assert.deepEqual(selected.staleIds, ["old"]);

assert.deepEqual(selectStaleSessionPendingIds([]), {
  keepId: null,
  staleIds: [],
});
assert.deepEqual(selectStaleSessionPendingIds([rows[0]!]), {
  keepId: "old",
  staleIds: [],
});

console.log("repair-session-pending-confirmations.selftest: ok");
