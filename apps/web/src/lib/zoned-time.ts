/** Convert a wall-clock instant in `timeZone` to a UTC Date. */

export function zonedWallTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string
): Date | null {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

  const wallKey =
    year * 1e8 + month * 1e6 + day * 1e4 + hour * 100 + minute;

  const keyAt = (ms: number) => {
    const p = Object.fromEntries(
      formatter.formatToParts(new Date(ms)).map((x) => [x.type, x.value])
    );
    return (
      +p.year * 1e8 +
      +p.month * 1e6 +
      +p.day * 1e4 +
      +p.hour * 100 +
      +p.minute
    );
  };

  let lo = Date.UTC(year, month - 1, day, hour, minute, 0) - 48 * 3600 * 1000;
  let hi = lo + 96 * 3600 * 1000;

  for (let i = 0; i < 48; i++) {
    const mid = Math.floor((lo + hi) / 2);
    const k = keyAt(mid);
    if (k < wallKey) lo = mid + 1;
    else hi = mid;
  }

  return keyAt(lo) === wallKey ? new Date(lo) : null;
}

export function calendarDateInZone(
  iso: string,
  timeZone: string,
  dayOffset: number
): { year: number; month: number; day: number } {
  const base = Date.parse(iso) + dayOffset * 86400000;
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const [y, m, d] = f.format(new Date(base)).split("-").map(Number);
  return { year: y, month: m, day: d };
}
