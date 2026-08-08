/**
 * Selftest mínimo Slice 5.1: XOR de raíz work_item (case_id | work_run_id).
 * Pure helper — no requiere DB.
 */
import assert from "node:assert/strict";
import { assertWorkItemRootXor } from "./durable-tasks";

function expectThrows(fn: () => void, label: string): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  assert.equal(threw, true, label);
}

expectThrows(
  () => assertWorkItemRootXor({ caseId: null, workRunId: null }),
  "neither root"
);
expectThrows(
  () => assertWorkItemRootXor({ caseId: undefined, workRunId: undefined }),
  "both undefined"
);
expectThrows(
  () => assertWorkItemRootXor({ caseId: "", workRunId: "" }),
  "both empty"
);
expectThrows(
  () => assertWorkItemRootXor({ caseId: "case-1", workRunId: "run-1" }),
  "both set"
);

assert.doesNotThrow(() =>
  assertWorkItemRootXor({ caseId: "case-1", workRunId: null })
);
assert.doesNotThrow(() =>
  assertWorkItemRootXor({ caseId: null, workRunId: "run-1" })
);
assert.doesNotThrow(() =>
  assertWorkItemRootXor({ caseId: "case-1", workRunId: undefined })
);

console.log("✓ assertWorkItemRootXor (XOR case_id | work_run_id)");
