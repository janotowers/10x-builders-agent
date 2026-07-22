import assert from "node:assert/strict";
import { isActionableContractReviewNotification } from "./pending-decision-router";

// contract_review is always actionable.
assert.equal(
  isActionableContractReviewNotification({ kind: "contract_review" }),
  true
);

// contract_pending only counts when no required fields are missing.
assert.equal(
  isActionableContractReviewNotification({
    kind: "contract_pending",
    metadata_jsonb: { missing_required_fields: [] },
  }),
  true
);
assert.equal(
  isActionableContractReviewNotification({
    kind: "contract_pending",
    metadata_jsonb: {},
  }),
  true
);
assert.equal(
  isActionableContractReviewNotification({
    kind: "contract_pending",
    metadata_jsonb: { missing_required_fields: ["owner_email"] },
  }),
  false
);

// Other kinds never claim the contract gate.
assert.equal(
  isActionableContractReviewNotification({ kind: "price_approval" }),
  false
);
assert.equal(
  isActionableContractReviewNotification({
    kind: "contract_data_review",
    metadata_jsonb: { missing_required_fields: [] },
  }),
  false
);

console.log("pending-decision-router.selftest: ok");
