import assert from "node:assert/strict";
import {
  isControlledE2EOperationalCase,
  isCronSuppressedOperationalCase,
  isSettingsOperationalTestCase,
} from "@agents/types";

assert.equal(
  isSettingsOperationalTestCase({
    context_jsonb: { created_from: "case_type_settings_test" },
  }),
  true
);

assert.equal(
  isControlledE2EOperationalCase({
    context_jsonb: {
      created_from: "agent_conversation",
      e2e_controlled: true,
    },
  }),
  true
);

assert.equal(
  isCronSuppressedOperationalCase({
    context_jsonb: {
      created_from: "agent_conversation",
      e2e_controlled: true,
    },
  }),
  true
);

assert.equal(
  isCronSuppressedOperationalCase({
    context_jsonb: {
      created_from: "agent_conversation",
    },
  }),
  false
);

assert.equal(
  isControlledE2EOperationalCase({
    context_jsonb: {
      created_from: "case_type_settings_test",
      e2e_controlled: true,
    },
  }),
  false
);

console.log("controlled-e2e-case.selftest: ok");
