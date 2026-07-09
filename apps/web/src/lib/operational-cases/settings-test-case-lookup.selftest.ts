import assert from "node:assert/strict";
import type { OperationalCase } from "@agents/types";
import { isLabSettingsTestCaseForTemplate } from "./settings-test-case-lookup";

function baseCase(
  overrides: Partial<OperationalCase> & {
    context_jsonb?: Record<string, unknown>;
  }
): OperationalCase {
  return {
    id: "case-1",
    user_id: "user-1",
    case_type_id: "type-private",
    case_type: "property_optioning",
    current_step: "awaiting_documents",
    status: "active",
    context_jsonb: {
      created_from: "case_type_settings_test",
      test_mode: true,
    },
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  } as OperationalCase;
}

const globalTemplate = { id: "type-global", case_type: "property_optioning" };
const privateTemplate = {
  id: "type-private",
  case_type: "property_optioning",
};
const otherSlug = { id: "type-other", case_type: "other_flow" };

assert.equal(
  isLabSettingsTestCaseForTemplate(
    baseCase({ case_type_id: "type-private" }),
    "user-1",
    privateTemplate
  ),
  true,
  "exact case_type_id match"
);

assert.equal(
  isLabSettingsTestCaseForTemplate(
    baseCase({ case_type_id: "type-private" }),
    "user-1",
    globalTemplate
  ),
  true,
  "same slug, different template id (global vs private)"
);

assert.equal(
  isLabSettingsTestCaseForTemplate(
    baseCase({ case_type_id: "type-private", case_type: "property_optioning" }),
    "user-1",
    otherSlug
  ),
  false,
  "different slug rejected"
);

assert.equal(
  isLabSettingsTestCaseForTemplate(
    baseCase({
      context_jsonb: { created_from: "agent_conversation", test_mode: true },
    }),
    "user-1",
    privateTemplate
  ),
  false,
  "non-settings test rejected"
);

assert.equal(
  isLabSettingsTestCaseForTemplate(
    baseCase({}),
    "other-user",
    privateTemplate
  ),
  false,
  "wrong user rejected"
);

console.log("settings-test-case-lookup.selftest: ok");
