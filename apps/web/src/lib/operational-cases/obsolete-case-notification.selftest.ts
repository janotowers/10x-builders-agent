import assert from "node:assert/strict";
import type { InternalUserNotification, OperationalCase } from "@agents/types";
import { isInternalCaseNotificationObsolete } from "./obsolete-case-notification";

const obsolete = (
  kind: string,
  currentStep: string,
  context: Record<string, unknown> = {}
) =>
  isInternalCaseNotificationObsolete({
    notification: { kind } as InternalUserNotification,
    opCase: {
      current_step: currentStep,
      context_jsonb: context,
    } as OperationalCase,
  });

assert.equal(obsolete("price_approval", "contract_pending"), true);
assert.equal(
  obsolete("price_approval", "price_proposal_pending", {
    pricing_proposal: { approval_status: "approved" },
  }),
  true
);
assert.equal(obsolete("price_approval", "price_proposal_pending"), false);
assert.equal(
  obsolete("property_data_minimums_missing", "contract_pending"),
  true
);
assert.equal(
  obsolete("contract_data_review", "contract_pending", {
    contract_data_review: { status: "captured" },
  }),
  true
);
assert.equal(obsolete("contract_review", "contract_pending"), false);
assert.equal(obsolete("photos_upload_requested", "package_ready"), true);
assert.equal(
  obsolete("listing_description_review", "package_ready", {
    listing_description_approved: { description: "Lista" },
  }),
  true
);
assert.equal(
  obsolete("easybroker_publish_approval", "package_ready", {
    publication: {
      destinations: { easybroker: { approval: "approved" } },
    },
  }),
  true
);
assert.equal(obsolete("publication_review_required", "published"), true);

console.log("obsolete-case-notification.selftest: ok");
