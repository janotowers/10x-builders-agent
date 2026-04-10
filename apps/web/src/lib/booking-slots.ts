import { zonedWallTimeToUtc, calendarDateInZone } from "./zoned-time";

type Busy = { start: string; end: string };

function busyOverlaps(
  start: number,
  end: number,
  busy: Busy[]
): boolean {
  for (const b of busy) {
    const bs = Date.parse(b.start);
    const be = Date.parse(b.end);
    if (!Number.isFinite(bs) || !Number.isFinite(be)) continue;
    if (start < be && end > bs) return true;
  }
  return false;
}

/** 30-minute slots, weekdays 09:00–17:00 local in `timezone`, max 64 starts. */
export function suggestPublicBookingSlots(
  timeMin: string,
  timeMax: string,
  timezone: string,
  busy: Busy[],
  dayCount: number
): string[] {
  const out: string[] = [];
  const endLimit = Date.parse(timeMax);
  const now = Date.now();

  for (let day = 0; day < dayCount && out.length < 64; day++) {
    const { year, month, day: d } = calendarDateInZone(timeMin, timezone, day);
    for (let h = 9; h < 17; h++) {
      for (const mi of [0, 30]) {
        const start = zonedWallTimeToUtc(year, month, d, h, mi, timezone);
        if (!start) continue;
        const t0 = start.getTime();
        const t1 = t0 + 30 * 60 * 1000;
        if (t0 < now || t1 > endLimit) continue;
        if (busyOverlaps(t0, t1, busy)) continue;
        out.push(start.toISOString());
      }
    }
  }

  return out;
}
