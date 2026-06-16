import assert from "node:assert/strict";
import {
  defaultDueAtForEngagement,
  isWithinDeliveryWindow,
  nextAllowedDeliveryAt,
  normalizeEngagementPolicyOverrides,
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

const overrides = normalizeEngagementPolicyOverrides({
  by_audience: {
    internal_user: {
      reminder_cooldown_hours: 2,
      delivery_window: {
        days_of_week: [1, 2, 3, 4, 5],
        start_time: "09:00",
        end_time: "18:00",
      },
    },
  },
  by_kind: {
    tool_confirmation_pending: {
      reminder_cooldown_hours: 1,
      escalate_after_hours: 12,
    },
  },
});
assert.equal(
  reminderCooldownHoursForEngagement(
    {
      audience: "internal_user",
      intent: "approval",
      kind: "tool_confirmation_pending",
    },
    overrides
  ),
  1
);

const withinWindow = isWithinDeliveryWindow({
  now: new Date("2026-05-25T16:00:00.000Z"), // Monday 11:00 America/Mexico_City
  timezone: "America/Mexico_City",
  window: {
    days_of_week: [1, 2, 3, 4, 5],
    start_time: "09:00",
    end_time: "18:00",
  },
});
assert.equal(withinWindow, true);

const outsideWindow = isWithinDeliveryWindow({
  now: new Date("2026-05-25T03:00:00.000Z"), // Sunday night/Monday dawn local
  timezone: "America/Mexico_City",
  window: {
    days_of_week: [1, 2, 3, 4, 5],
    start_time: "09:00",
    end_time: "18:00",
  },
});
assert.equal(outsideWindow, false);

const nextWindow = nextAllowedDeliveryAt({
  now: new Date("2026-05-24T08:30:00.000Z"), // Sunday local pre-window
  timezone: "America/Mexico_City",
  window: {
    days_of_week: [1, 2, 3, 4, 5],
    start_time: "09:00",
    end_time: "18:00",
  },
});
assert.equal(nextWindow.toISOString(), "2026-05-25T15:00:00.000Z");

console.log("engagement-policies registry selftest passed");
