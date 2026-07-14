import assert from "node:assert/strict";
import {
  classifyContractGenerationFailureFromToolCalls,
  deriveControlledE2EStatusForTest,
  listingDescriptionReviewNeedsRegeneration,
  missingContractFieldsFromToolCalls,
  missingListingDescriptionIngredientsFromToolCalls,
  shouldAutoExecuteApprovedPublishToolsForTest,
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
  classifyContractGenerationFailureFromToolCalls([]).kind,
  "not_attempted"
);
assert.equal(
  classifyContractGenerationFailureFromToolCalls([
    {
      tool_name: "generate_document_from_template",
      status: "failed",
      result_json: { status: "not_configured", hint: "Falta plantilla" },
    },
  ]).kind,
  "template_missing"
);
assert.equal(
  classifyContractGenerationFailureFromToolCalls([
    {
      tool_name: "generate_document_from_template",
      status: "failed",
      result_json: { error: "titularidad_review_required" },
    },
  ]).kind,
  "titularidad_review_required"
);
assert.equal(
  classifyContractGenerationFailureFromToolCalls([
    {
      tool_name: "generate_document_from_template",
      status: "pending_confirmation",
      result_json: null,
    },
    {
      tool_name: "generate_document_from_template",
      status: "failed",
      result_json: {
        status: "validation_error",
        error: "{\"message\":\"<html>502 Bad Gateway cloudflare</html>\"}",
      },
    },
  ]).kind,
  "infrastructure_error"
);
assert.equal(
  classifyContractGenerationFailureFromToolCalls([
    {
      tool_name: "generate_document_from_template",
      status: "pending_confirmation",
      result_json: null,
    },
  ]).kind,
  "pending_confirmation"
);

assert.deepEqual(
  missingListingDescriptionIngredientsFromToolCalls([
    {
      tool_name: "prepare_listing_description_draft",
      status: "failed",
      result_json: {
        status: "missing_required_ingredients",
        missing_ingredients: ["photo_analysis", "zone_context"],
      },
    },
    {
      tool_name: "prepare_listing_description_draft",
      status: "failed",
      result_json: {
        status: "missing_required_ingredients",
        missing_ingredients: ["photo_analysis"],
      },
    },
    {
      tool_name: "notify_user",
      status: "failed",
      result_json: {
        error: "listing_description_draft_required_before_review_notify",
      },
    },
  ]),
  ["photo_analysis", "zone_context"]
);
assert.deepEqual(
  missingListingDescriptionIngredientsFromToolCalls([
    {
      tool_name: "prepare_listing_description_draft",
      status: "executed",
      result_json: { ok: true, status: "drafted" },
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

assert.equal(
  listingDescriptionReviewNeedsRegeneration({
    listing_description_review: { status: "changes_requested" },
  }),
  true
);
assert.equal(
  listingDescriptionReviewNeedsRegeneration({
    listing_description_review: { status: "approved" },
  }),
  false
);
assert.equal(listingDescriptionReviewNeedsRegeneration({}), false);

assert.equal(
  shouldAutoExecuteApprovedPublishToolsForTest({
    case_type: "property_optioning",
    current_step: "package_ready",
    context_jsonb: {
      listing_description_approved: { description: "Texto aprobado" },
      publish_approvals: { easybroker: "approved" },
      publication_mode: "active",
      package_ready_machine_work_in_flight: true,
      publication_runner_pending_action: {
        destination: "easybroker",
        type: "create_draft",
      },
    },
  } as never),
  true
);
assert.equal(
  shouldAutoExecuteApprovedPublishToolsForTest({
    case_type: "property_optioning",
    current_step: "package_ready",
    context_jsonb: {
      listing_description_approved: { description: "Texto aprobado" },
      publish_approvals: { easybroker: "approved" },
      publication_mode: "active",
      package_ready_machine_work_in_flight: true,
      publication_runner_pending_action: {
        destination: "ungga",
        type: "create_draft",
      },
    },
  } as never),
  false
);

console.log("run-settings-test-case-tick.selftest: ok");
