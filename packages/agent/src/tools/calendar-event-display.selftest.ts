import assert from "node:assert/strict";
import { formatGoogleEventBoundary } from "./calendar-event-display";

const MX = "America/Mexico_City";

{
  const s = formatGoogleEventBoundary(
    { dateTime: "2026-04-09T18:00:00-06:00", timeZone: "America/Mexico_City" },
    MX
  );
  assert.ok(s.includes("2026") || s.includes("abr"), s);
  assert.ok(!s.includes("UTC"), s);
  assert.ok(s.includes("(CST") || s.includes("(CDT"), `expected tz abbr in: ${s}`);
}

{
  const s = formatGoogleEventBoundary({ date: "2026-04-09" }, MX);
  assert.ok(s.includes("todo el día"), s);
}

console.log("calendar-event-display.selftest: passed");
