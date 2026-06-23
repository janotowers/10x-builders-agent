import assert from "node:assert/strict";
import type {
  OperationalCase,
  OperationalCaseConversationBinding,
} from "@agents/types";
import {
  filterBindingsForActiveE2ELabSync,
  isAdoptableConversationalCaseForE2ELab,
  isUsableE2ELabSessionCase,
} from "./e2e-lab-routing-isolation";

const binding = (caseId: string): OperationalCaseConversationBinding =>
  ({
    id: `binding-${caseId}`,
    case_id: caseId,
    case_type: "property_optioning",
    channel: "telegram",
    status: "awaiting_user",
  }) as OperationalCaseConversationBinding;

const realCase = {
  id: "real-case",
  user_id: "user-1",
  case_type: "property_optioning",
  status: "waiting_internal",
  context_jsonb: { created_from: "agent_conversation", e2e_controlled: false },
} as unknown as OperationalCase;

const e2eCase = {
  id: "e2e-case",
  user_id: "user-1",
  case_type: "property_optioning",
  status: "waiting_internal",
  context_jsonb: { created_from: "agent_conversation", e2e_controlled: true },
} as unknown as OperationalCase;

const caseById = new Map([
  ["real-case", realCase],
  ["e2e-case", e2eCase],
]);

assert.deepEqual(
  filterBindingsForActiveE2ELabSync(
    [binding("real-case"), binding("e2e-case")],
    caseById
  ).map((row) => row.case_id),
  ["e2e-case"]
);

assert.equal(
  isAdoptableConversationalCaseForE2ELab(realCase, true),
  false
);
assert.equal(isAdoptableConversationalCaseForE2ELab(e2eCase, true), true);
assert.equal(isAdoptableConversationalCaseForE2ELab(realCase, false), true);
assert.equal(
  isUsableE2ELabSessionCase({
    opCase: e2eCase,
    userId: "user-1",
    caseType: "property_optioning",
  }),
  true
);
assert.equal(
  isUsableE2ELabSessionCase({
    opCase: realCase,
    userId: "user-1",
    caseType: "property_optioning",
  }),
  false
);
assert.equal(
  isUsableE2ELabSessionCase({
    opCase: e2eCase,
    userId: "other-user",
    caseType: "property_optioning",
  }),
  false
);

console.log("e2e-lab-routing-isolation.selftest: ok");
