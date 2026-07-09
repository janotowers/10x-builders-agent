import assert from "node:assert/strict";
import {
  STEP_BRANCH_DECISION_ID_DOCUMENT_REQUEST,
  eventsIncludeStepBranchSelected,
} from "./step-branch-selected";

assert.equal(
  eventsIncludeStepBranchSelected([], {
    decisionId: STEP_BRANCH_DECISION_ID_DOCUMENT_REQUEST,
    branchValue: "internal_user",
  }),
  false
);

assert.equal(
  eventsIncludeStepBranchSelected(
    [
      {
        event_type: "human_decision",
        payload_jsonb: {
          kind: "step_branch_selected",
          decision_id: STEP_BRANCH_DECISION_ID_DOCUMENT_REQUEST,
          branch_value: "internal_user",
          decided_by: "user",
        },
      },
    ],
    {
      decisionId: STEP_BRANCH_DECISION_ID_DOCUMENT_REQUEST,
      branchValue: "internal_user",
    }
  ),
  true
);

assert.equal(
  eventsIncludeStepBranchSelected(
    [
      {
        event_type: "human_decision",
        payload_jsonb: {
          kind: "step_branch_selected",
          decision_id: STEP_BRANCH_DECISION_ID_DOCUMENT_REQUEST,
          branch_value: "internal_user",
        },
      },
    ],
    {
      decisionId: STEP_BRANCH_DECISION_ID_DOCUMENT_REQUEST,
      branchValue: "external_contact",
    }
  ),
  false
);

assert.equal(
  eventsIncludeStepBranchSelected(
    [
      {
        event_type: "state_changed",
        payload_jsonb: {
          kind: "document_request_target_inferred",
          target: "internal_user",
        },
      },
    ],
    {
      decisionId: STEP_BRANCH_DECISION_ID_DOCUMENT_REQUEST,
      branchValue: "internal_user",
    }
  ),
  false
);

console.log("step-branch-selected.selftest: ok");
