import assert from "node:assert/strict";
import {
  autoStatusOnCreateForNotificationKind,
  defaultDueAtForNotificationKind,
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
assert.deepEqual(hiddenInboxNotificationKinds(), ["tool_readiness_test"]);

const base = Date.parse("2026-05-24T12:00:00.000Z");
assert.equal(
  defaultDueAtForNotificationKind("price_approval", base),
  "2026-05-24T16:00:00.000Z"
);
assert.equal(defaultDueAtForNotificationKind("general", base), null);

assert.equal(reminderCooldownHoursForNotificationKind("price_approval"), 4);
assert.equal(reminderCooldownHoursForNotificationKind("unknown_kind"), 8);
assert.equal(reminderCooldownHoursForNotificationKind("contract_review"), 4);

console.log("internal-notifications registry selftest passed");
