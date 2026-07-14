import assert from "node:assert/strict";
import type { OperationalCase } from "@agents/types";
import {
  buildObservedConversationalCaseLabel,
  isObservationalLabCaseReadOnly,
  listObservableConversationalCases,
  observedConversationalCaseModeTag,
  partitionObservableConversationalCases,
} from "./settings-test-history-ui";

function caseStub(
  partial: Partial<OperationalCase> & {
    id: string;
    status: OperationalCase["status"];
    updated_at: string;
  }
): OperationalCase {
  return {
    user_id: "u1",
    case_type_id: "t1",
    case_type: "property_optioning",
    version: 1,
    current_step: "published",
    next_action_at: null,
    due_at: null,
    context_jsonb: { created_from: "agent_conversation", e2e_controlled: true },
    external_contact_jsonb: null,
    created_at: partial.updated_at,
    ...partial,
  } as OperationalCase;
}

assert.equal(isObservationalLabCaseReadOnly({ status: "completed" }), true);
assert.equal(isObservationalLabCaseReadOnly({ status: "failed" }), true);
assert.equal(isObservationalLabCaseReadOnly({ status: "active" }), false);
assert.equal(isObservationalLabCaseReadOnly(null), false);

const active = caseStub({
  id: "active-1",
  status: "active",
  current_step: "package_ready",
  updated_at: "2026-07-14T01:00:00.000Z",
});
const completed = caseStub({
  id: "done-1",
  status: "completed",
  current_step: "published",
  updated_at: "2026-07-14T03:00:00.000Z",
});
const failed = caseStub({
  id: "fail-1",
  status: "failed",
  current_step: "package_ready",
  updated_at: "2026-07-14T02:00:00.000Z",
});
const nonConversational = caseStub({
  id: "settings-1",
  status: "completed",
  updated_at: "2026-07-14T04:00:00.000Z",
  context_jsonb: {
    created_from: "case_type_settings_test",
    test_mode: true,
  },
});

const listed = listObservableConversationalCases([
  completed,
  failed,
  active,
  nonConversational,
]);
assert.deepEqual(
  listed.map((c) => c.id),
  ["active-1", "done-1", "fail-1"],
  "active first; completed/failed included; non-conversational excluded"
);

const parts = partitionObservableConversationalCases([
  completed,
  failed,
  active,
]);
assert.deepEqual(
  parts.active.map((c) => c.id),
  ["active-1"]
);
assert.deepEqual(
  parts.closedReadOnly.map((c) => c.id),
  ["done-1", "fail-1"]
);

assert.equal(observedConversationalCaseModeTag(completed), "[E2E cerrado]");
assert.equal(observedConversationalCaseModeTag(failed), "[E2E fallido]");
assert.equal(observedConversationalCaseModeTag(active), "[E2E activo]");

const label = buildObservedConversationalCaseLabel({
  opCase: completed,
  formatDateTime: () => "fecha",
});
assert.ok(label.includes("[E2E cerrado]"));
assert.ok(label.includes("Completado"));
assert.ok(label.includes("done-1"));

console.log("settings-test-history-ui.selftest: ok");
