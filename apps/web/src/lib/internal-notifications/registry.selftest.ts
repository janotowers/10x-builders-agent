import assert from "node:assert/strict";
import {
  autoStatusOnCreateForNotificationKind,
  defaultDueAtForNotificationKind,
  effectiveInternalNotificationKind,
  hiddenInboxNotificationKinds,
  internalNotificationKindConfig,
  reminderCooldownHoursForNotificationKind,
} from "./registry";

assert.equal(
  internalNotificationKindConfig("price_approval").label,
  "Aprobacion de precio"
);
assert.equal(
  internalNotificationKindConfig("tool_readiness_test").visibleInInbox,
  false
);
assert.equal(
  autoStatusOnCreateForNotificationKind("tool_readiness_test"),
  "actioned"
);
assert.deepEqual(hiddenInboxNotificationKinds(), [
  "tool_readiness_test",
  "contract_owner_signed",
]);

const base = Date.parse("2026-05-24T12:00:00.000Z");
assert.equal(
  defaultDueAtForNotificationKind("price_approval", base),
  "2026-05-24T16:00:00.000Z"
);
assert.equal(defaultDueAtForNotificationKind("general", base), null);

assert.equal(reminderCooldownHoursForNotificationKind("price_approval"), 4);
assert.equal(reminderCooldownHoursForNotificationKind("unknown_kind"), 8);
assert.equal(reminderCooldownHoursForNotificationKind("contract_review"), 4);

assert.equal(
  effectiveInternalNotificationKind({
    kind: "comparables_analysis",
    body: "Revisemos el precio propuesto.",
  }),
  "price_approval"
);
assert.equal(
  effectiveInternalNotificationKind({
    kind: "price_proposal",
  }),
  "price_approval"
);
assert.equal(
  effectiveInternalNotificationKind({
    kind: "pricing_proposal",
  }),
  "price_approval"
);
assert.equal(
  internalNotificationKindConfig("comparables_analysis", {
    body: "Revisemos el precio propuesto.",
  }).businessDecision,
  "price_approval"
);
assert.equal(
  internalNotificationKindConfig("comparables_insufficient_data").informational,
  true
);
assert.equal(
  internalNotificationKindConfig("comparables_analysis").informational,
  true
);
assert.equal(
  internalNotificationKindConfig("photos_upload_requested").informational,
  true,
  "photos_upload_requested must not block E2E ticks"
);
assert.equal(
  internalNotificationKindConfig("publish_destination_approvals").informational,
  true,
  "legacy batch publish destination kind must not block E2E ticks"
);
assert.equal(
  effectiveInternalNotificationKind({
    kind: "publish destination approvals",
  }),
  "publish_destination_approvals"
);
assert.equal(
  internalNotificationKindConfig("comparables_search_expansion_decision")
    .reviewCtaLabel,
  "Elegir ampliacion en flujo"
);

console.log("internal-notifications registry selftest passed");
