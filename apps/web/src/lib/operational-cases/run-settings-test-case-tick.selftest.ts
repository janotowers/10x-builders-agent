import assert from "node:assert/strict";
import { missingContractFieldsFromToolCalls } from "./run-settings-test-case-tick";

const missing = missingContractFieldsFromToolCalls([
  {
    tool_name: "generate_document_from_template",
    status: "failed",
    result_json: {
      error: "commission_contract_missing_required_data",
      missing_required_fields: ["owner_email", "property_address"],
    },
  },
  {
    tool_name: "generate_document_from_template",
    status: "failed",
    result_json: {
      error: "commission_contract_missing_required_data",
      missing_required_fields: ["owner_email"],
    },
  },
  {
    tool_name: "notify_user",
    status: "executed",
    result_json: { ok: true },
  },
]);
assert.deepEqual(missing, ["owner_email", "property_address"]);

assert.deepEqual(
  missingContractFieldsFromToolCalls([
    {
      tool_name: "generate_document_from_template",
      status: "executed",
      result_json: { ok: true },
    },
  ]),
  []
);

console.log("run-settings-test-case-tick.selftest: ok");
