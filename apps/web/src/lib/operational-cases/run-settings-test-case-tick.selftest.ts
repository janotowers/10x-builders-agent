import assert from "node:assert/strict";
import {
  deriveControlledE2EStatusForTest,
  missingContractFieldsFromToolCalls,
  shouldProcessOwnerResponseAsDocumentsReplyForTest,
} from "./run-settings-test-case-tick";

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

assert.equal(
  shouldProcessOwnerResponseAsDocumentsReplyForTest({
    currentStep: "documents_received",
    ownerResponseText: "listo",
  }),
  true
);
assert.equal(
  shouldProcessOwnerResponseAsDocumentsReplyForTest({
    currentStep: "price_proposal_pending",
    ownerResponseText: "1",
  }),
  false
);
assert.equal(
  deriveControlledE2EStatusForTest("advanced_to_price_proposal", false),
  "waiting_internal"
);

console.log("run-settings-test-case-tick.selftest: ok");
