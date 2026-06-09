import assert from "node:assert/strict";
import { buildTelegramOperationalCaseToolApprovalPolicy } from "./telegram-operational-case-tool-policy";

assert.deepEqual(
  buildTelegramOperationalCaseToolApprovalPolicy({ current_step: "intake" }),
  {
    operational_case_update_intake: "auto_execute",
    operational_case_create: "auto_execute",
    operational_case_update_state: "deny",
  }
);

assert.deepEqual(
  buildTelegramOperationalCaseToolApprovalPolicy({
    current_step: "awaiting_documents",
  }),
  {
    operational_case_update_intake: "auto_execute",
  }
);

assert.equal(buildTelegramOperationalCaseToolApprovalPolicy(null), undefined);

console.log("telegram-operational-case-tool-policy.selftest: ok");
