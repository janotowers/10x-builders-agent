import assert from "node:assert/strict";
import {
  DEFAULT_WORKFLOW_OPERATIONAL_JUDGE_MODEL_ID,
  resolveWorkflowOperationalJudgeModelId,
} from "./model";

assert.equal(
  resolveWorkflowOperationalJudgeModelId({
    WORKFLOW_OPERATIONAL_JUDGE_MODEL_ID: " vendor/judge ",
    WORKFLOW_COMPILER_MODEL_ID: "vendor/compiler",
  }),
  "vendor/judge"
);
assert.equal(
  resolveWorkflowOperationalJudgeModelId({
    WORKFLOW_OPERATIONAL_JUDGE_MODEL_ID: " ",
    WORKFLOW_COMPILER_MODEL_ID: " vendor/compiler ",
  }),
  "vendor/compiler"
);
assert.equal(
  resolveWorkflowOperationalJudgeModelId({}),
  DEFAULT_WORKFLOW_OPERATIONAL_JUDGE_MODEL_ID
);

console.log("model-operational-judge.selftest: ok");
