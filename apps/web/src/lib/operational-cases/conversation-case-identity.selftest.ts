import assert from "node:assert/strict";
import type { OperationalCase } from "@agents/types";
import { buildConversationCaseIdentity } from "./conversation-case-identity";

const opCase = {
  id: "5f4f0de6-d8f6-4bd1-a4ea-d9f57c9ab123",
  case_type: "property_optioning",
  status: "waiting_internal",
  current_step: "intake",
  context_jsonb: {
    title: "Terreno en Sendas",
  },
} as unknown as OperationalCase;

const identity = buildConversationCaseIdentity({ opCase });
assert.equal(identity.caseTypeLabel, "property_optioning");
assert.equal(identity.summary, "Terreno en Sendas");
assert.equal(identity.technical, "waiting_internal / intake");
assert.match(identity.shortId, /…[a-f0-9]{8}/);

console.log("conversation-case-identity.selftest: ok");
