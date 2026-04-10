const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const PAST_GRACE_MS = 60_000;

export interface CalendarListWindowInput {
  time_min: string;
  time_max: string;
  /** Solo true si el usuario pidió explícitamente fechas pasadas / historial. */
  historical?: boolean;
}

export interface CalendarListWindowResult {
  timeMin: string;
  timeMax: string;
  coerced: boolean;
  coercion_reason?: string;
}

function defaultWindow(nowMs: number): { timeMin: string; timeMax: string } {
  return {
    timeMin: new Date(nowMs).toISOString(),
    timeMax: new Date(nowMs + SEVEN_DAYS_MS).toISOString(),
  };
}

/** true si falta alguno de los extremos del rango (tras OAuth / modelo). */
export function calendarListEventsNeedsPeriod(
  time_min?: string,
  time_max?: string
): boolean {
  return !String(time_min ?? "").trim() || !String(time_max ?? "").trim();
}

/**
 * Normaliza la ventana para calendar_list_events (time_min y time_max ya definidos).
 * Sin historical=true, rangos que terminan en el pasado se sustituyen por ahora → +7 días.
 */
export function resolveCalendarListWindow(
  input: CalendarListWindowInput,
  now: Date
): CalendarListWindowResult {
  const nowMs = now.getTime();
  const historical = input.historical === true;

  let timeMin = input.time_min.trim();
  let timeMax = input.time_max.trim();

  const startMs = Date.parse(timeMin);
  const endMs = Date.parse(timeMax);

  const invalidRange =
    !Number.isFinite(startMs) ||
    !Number.isFinite(endMs) ||
    startMs > endMs;

  if (invalidRange) {
    const d = defaultWindow(nowMs);
    return {
      timeMin: d.timeMin,
      timeMax: d.timeMax,
      coerced: true,
      coercion_reason: "invalid_or_inverted_time_range",
    };
  }

  const entirelyInPast = endMs < nowMs - PAST_GRACE_MS;

  if (!historical && entirelyInPast) {
    const d = defaultWindow(nowMs);
    return {
      timeMin: d.timeMin,
      timeMax: d.timeMax,
      coerced: true,
      coercion_reason: "past_only_range_without_historical_true",
    };
  }

  return { timeMin, timeMax, coerced: false };
}
