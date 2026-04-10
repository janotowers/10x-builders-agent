import assert from "node:assert/strict";
import {
  resolveCalendarListWindow,
  calendarListEventsNeedsPeriod,
} from "./calendar-list-window";

const FIXED_NOW = new Date("2026-04-09T12:00:00.000Z");

assert.equal(calendarListEventsNeedsPeriod(undefined, undefined), true);
assert.equal(calendarListEventsNeedsPeriod("", "2026-04-10"), true);
assert.equal(calendarListEventsNeedsPeriod("2026-04-10", ""), true);
assert.equal(
  calendarListEventsNeedsPeriod("2026-04-09T12:00:00.000Z", "2026-04-16T12:00:00.000Z"),
  false
);

{
  const r = resolveCalendarListWindow(
    {
      time_min: "2026-04-09T12:00:00.000Z",
      time_max: "2026-04-16T12:00:00.000Z",
      historical: false,
    },
    FIXED_NOW
  );
  assert.equal(r.coerced, false);
}

{
  const r = resolveCalendarListWindow(
    {
      time_min: "2023-10-09T00:00:00.000Z",
      time_max: "2023-10-16T23:59:59.000Z",
      historical: false,
    },
    FIXED_NOW
  );
  assert.equal(r.coerced, true);
  assert.equal(r.coercion_reason, "past_only_range_without_historical_true");
  assert.equal(r.timeMin, "2026-04-09T12:00:00.000Z");
  assert.equal(r.timeMax, "2026-04-16T12:00:00.000Z");
}

{
  const r = resolveCalendarListWindow(
    {
      time_min: "2023-10-09T00:00:00.000Z",
      time_max: "2023-10-16T23:59:59.000Z",
      historical: true,
    },
    FIXED_NOW
  );
  assert.equal(r.coerced, false);
  assert.ok(r.timeMin.includes("2023-10-09"));
  assert.ok(r.timeMax.includes("2023-10-16"));
}

{
  const r = resolveCalendarListWindow(
    {
      time_min: "2026-04-20T00:00:00.000Z",
      time_max: "2026-04-10T00:00:00.000Z",
    },
    FIXED_NOW
  );
  assert.equal(r.coerced, true);
  assert.equal(r.coercion_reason, "invalid_or_inverted_time_range");
}

{
  const r = resolveCalendarListWindow(
    {
      time_min: "not-a-date",
      time_max: "2026-04-20T00:00:00.000Z",
    },
    FIXED_NOW
  );
  assert.equal(r.coerced, true);
  assert.equal(r.coercion_reason, "invalid_or_inverted_time_range");
}

console.log("calendar-list-window.selftest: all cases passed");
