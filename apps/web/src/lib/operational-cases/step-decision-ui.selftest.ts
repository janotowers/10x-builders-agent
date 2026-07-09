import assert from "node:assert/strict";
import type { OperationalCaseFlowStepDecision } from "@agents/types";
import {
  branchesForScenarioId,
  partitionToolsByStepDecision,
  scenarioBranchBadgeLabel,
  stepDecisionToolBadgeLabel,
} from "./step-decision-ui";

const decision: OperationalCaseFlowStepDecision = {
  id: "document_request_target",
  label: "¿Quién aporta?",
  branches: [
    {
      value: "internal_user",
      label: "Equipo interno",
      primary_tool_ids: ["notify_user"],
      scenario_ids: ["awaiting_documents_internal_upload"],
    },
    {
      value: "external_contact",
      label: "Contacto externo",
      primary_tool_ids: ["telegram_send_message_to_contact"],
      scenario_ids: ["awaiting_documents_outreach"],
    },
  ],
  shared_tool_ids: ["operational_case_list_documents"],
};

const empty = partitionToolsByStepDecision(undefined);
assert.equal(empty.byBranch.size, 0);
assert.equal(empty.shared.size, 0);
assert.equal(stepDecisionToolBadgeLabel("notify_user", empty), null);

const part = partitionToolsByStepDecision(decision);
assert.equal(stepDecisionToolBadgeLabel("notify_user", part), "Equipo interno");
assert.equal(
  stepDecisionToolBadgeLabel("telegram_send_message_to_contact", part),
  "Contacto externo"
);
assert.equal(
  stepDecisionToolBadgeLabel("operational_case_list_documents", part),
  "Compartida"
);
assert.equal(stepDecisionToolBadgeLabel("other_tool", part), null);

assert.equal(
  scenarioBranchBadgeLabel(decision, "awaiting_documents_internal_upload"),
  "Equipo interno"
);
assert.equal(
  scenarioBranchBadgeLabel(decision, "awaiting_documents_outreach"),
  "Contacto externo"
);
assert.equal(scenarioBranchBadgeLabel(decision, "unknown"), null);
assert.equal(branchesForScenarioId(decision, "awaiting_documents_outreach").length, 1);

console.log("step-decision-ui.selftest: ok");
