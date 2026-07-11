import assert from "node:assert/strict";
import { toolCallCaseId } from "./finalize-case-after-tool-decision";

assert.equal(
  toolCallCaseId({ arguments_json: { case_id: " case-1 " } }),
  "case-1"
);
assert.equal(
  toolCallCaseId({ metadata_jsonb: { case_id: "case-2" } }),
  "case-2"
);
assert.equal(
  toolCallCaseId({
    arguments_json: { case_id: "case-args" },
    metadata_jsonb: { case_id: "case-meta" },
  }),
  "case-args"
);
assert.equal(toolCallCaseId({ arguments_json: {} }), null);
assert.equal(toolCallCaseId({}), null);

console.log("finalize-case-after-tool-decision.selftest: ok");
