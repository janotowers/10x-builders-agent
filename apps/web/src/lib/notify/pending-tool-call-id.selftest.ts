import assert from "node:assert/strict";
import { resolvePendingToolCallId } from "./pending-tool-call-id";

// Direct send: id lives on the payload data.
assert.equal(
  resolvePendingToolCallId({ pending_tool_call_id: "tc-1" }, null),
  "tc-1"
);

// Reminder/escalation: id is recovered from the source notification metadata.
assert.equal(
  resolvePendingToolCallId(
    { source_notification_id: "n-1" },
    { pending_tool_call_id: "tc-9" }
  ),
  "tc-9"
);

// Payload data takes precedence over source metadata.
assert.equal(
  resolvePendingToolCallId(
    { pending_tool_call_id: "tc-payload" },
    { pending_tool_call_id: "tc-source" }
  ),
  "tc-payload"
);

// No id anywhere → null (no actionable buttons).
assert.equal(resolvePendingToolCallId({}, {}), null);
assert.equal(resolvePendingToolCallId(null, null), null);

// Blank strings are ignored.
assert.equal(
  resolvePendingToolCallId({ pending_tool_call_id: "   " }, null),
  null
);

console.log("pending-tool-call-id.selftest.ts: ok");
