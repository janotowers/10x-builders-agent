import assert from "node:assert/strict";
import {
  defaultDueAtForEngagement,
  reminderCooldownHoursForEngagement,
  resolveEngagementPolicy,
} from "./registry";

const base = Date.parse("2026-05-24T12:00:00.000Z");

assert.equal(
  defaultDueAtForEngagement(
    { audience: "internal_user", intent: "approval", kind: "price_approval" },
    base
  ),
  "2026-05-24T16:00:00.000Z"
);

assert.equal(
  reminderCooldownHoursForEngagement({
    audience: "internal_user",
    intent: "approval",
    kind: "price_approval",
  }),
  4
);

assert.equal(
  reminderCooldownHoursForEngagement({
    audience: "external_prospect",
    intent: "followup",
    channel: "telegram",
  }),
  24
);

assert.equal(
  resolveEngagementPolicy({
    audience: "external_prospect",
    intent: "followup",
  }).maxAttempts,
  3
);

assert.equal(
  reminderCooldownHoursForEngagement({
    audience: "internal_user",
    intent: "reminder",
    priority: "high",
  }),
  1
);

console.log("engagement-policies registry selftest passed");
