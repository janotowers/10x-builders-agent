import assert from "node:assert/strict";
import {
  validateContractDraftReadyStepOutcome,
  validateContractTemplateMissingStepOutcome,
} from "@/lib/operational-cases/contract-review-validation";
import { parseContractReviewDecision } from "./contract-review";
import { businessDecisionHandler } from "./registry";

assert.equal(
  parseContractReviewDecision("mándalo al dueño").intent,
  "approve_send"
);
assert.equal(
  parseContractReviewDecision("necesita cambios en la comisión").intent,
  "request_changes"
);
assert.equal(
  parseContractReviewDecision(
    "ya lo ajusté, te adjunto el contrato corregido, mándalo al dueño"
  ).intent,
  "approve_send_after_revision"
);
assert.equal(businessDecisionHandler("contract_review").notificationKind, "contract_review");
assert.equal(
  businessDecisionHandler("contract_owner_signed").notificationKind,
  "contract_owner_signed"
);

assert.equal(
  validateContractTemplateMissingStepOutcome({
    current_step: "contract_pending",
    status: "paused",
    contract_drafted_event: false,
    notify_user_executed: true,
  }).ok,
  true,
  "plantilla faltante: paused + notify sin contract_drafted"
);
assert.equal(
  validateContractTemplateMissingStepOutcome({
    current_step: "contract_pending",
    status: "active",
    contract_drafted_event: false,
    notify_user_executed: true,
    generate_document_rendered: true,
    contract_draft_has_output_path: true,
  }).ok,
  false,
  "plantilla faltante falla si hubo render"
);
assert.equal(
  validateContractDraftReadyStepOutcome({
    current_step: "contract_pending",
    status: "waiting_internal",
    contract_drafted_event: true,
    notify_user_executed: true,
    generate_document_rendered: true,
    contract_draft_has_output_path: true,
  }).ok,
  true,
  "borrador listo: waiting_internal + render + output_path"
);

console.log("contract-review.selftest: ok");
