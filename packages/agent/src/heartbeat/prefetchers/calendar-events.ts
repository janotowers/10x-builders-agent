/**
 * Calendar event prefetcher.
 *
 * Mirrors the `calendar_list_events` tool's read shape so the persisted
 * `tool_calls` row is indistinguishable from an agent-issued read in the UI
 * — except for the `executor_kind=deterministic` flag and the `IA` /
 * `Determinístico` badge in the chat panel.
 */
import { googleCalendarJson, calendarEventsPath } from "../../tools/calendar-api";
import { eventDisplayFields } from "../../tools/calendar-event-display";
import type {
  HeartbeatPrefetcher,
  HeartbeatPrefetchEnv,
  HeartbeatPrefetchInput,
  HeartbeatPrefetchOutput,
  HeartbeatPrefetchSignal,
} from "./types";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function eventStartMs(boundary: unknown): number | null {
  const record = asRecord(boundary);
  const dateTime = record.dateTime;
  if (typeof dateTime !== "string" || !dateTime.trim()) return null;
  const ms = Date.parse(dateTime);
  return Number.isFinite(ms) ? ms : null;
}

export const calendarEventsPrefetcher: HeartbeatPrefetcher = {
  kind: "calendar_events",
  toolName: "calendar_list_events",
  isAvailable(env: HeartbeatPrefetchEnv): boolean {
    if (!env.googleCalendarAccessToken) return false;
    return env.integrations.some(
      (i) => i.provider === "google_calendar" && i.status === "active"
    );
  },
  async run(
    env: HeartbeatPrefetchEnv,
    input: HeartbeatPrefetchInput
  ): Promise<HeartbeatPrefetchOutput> {
    const token = env.googleCalendarAccessToken;
    if (!token) {
      return {
        toolName: this.toolName,
        arguments: {},
        result: { error: "missing_google_calendar_token" },
        status: "failed",
        signals: [],
      };
    }
    const now = env.now;
    const nowMs = now.getTime();
    const horizonMs = nowMs + input.reminderWindowMinutes * 60_000;
    const args = {
      calendar_id: "primary",
      time_min: now.toISOString(),
      time_max: new Date(horizonMs).toISOString(),
    };
    const query = new URLSearchParams({
      timeMin: args.time_min,
      timeMax: args.time_max,
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "10",
    });
    const { status, data } = await googleCalendarJson(
      token,
      calendarEventsPath("primary", `?${query.toString()}`)
    );
    if (status >= 400) {
      return {
        toolName: this.toolName,
        arguments: args,
        result: { error: "Calendar API error", status, details: data },
        status: "failed",
        signals: [],
      };
    }

    const rawEvents = asRecord(data).items;
    const events = Array.isArray(rawEvents) ? rawEvents : [];
    const signals: HeartbeatPrefetchSignal[] = [];
    const enriched: Array<Record<string, unknown>> = [];

    for (const event of events) {
      const e = asRecord(event);
      if (e.status === "cancelled") continue;
      const startMs = eventStartMs(e.start);
      if (startMs === null || startMs < nowMs - 60_000 || startMs > horizonMs) {
        continue;
      }
      const display = eventDisplayFields(e, env.timezone);
      const summary =
        typeof e.summary === "string" && e.summary.trim()
          ? e.summary.trim()
          : "Evento sin título";
      const minutesAhead = Math.max(0, Math.round((startMs - nowMs) / 60_000));
      const id = typeof e.id === "string" ? e.id : `event-${signals.length}`;
      signals.push({
        id,
        title: summary,
        whenDisplay: display.start_display,
        minutesAhead,
        details: {
          starts_in_minutes: minutesAhead,
          start: display.start_display,
          end: display.end_display,
          status:
            typeof e.status === "string" ? (e.status as string) : undefined,
          transparency:
            typeof e.transparency === "string"
              ? (e.transparency as string)
              : undefined,
          calendar_id: "primary",
        },
      });
      enriched.push({
        id: e.id,
        summary,
        status: e.status,
        start: e.start,
        end: e.end,
        start_display: display.start_display,
        end_display: display.end_display,
        starts_in_minutes: minutesAhead,
        calendar_id: "primary",
      });
    }

    return {
      toolName: this.toolName,
      arguments: args,
      result: {
        events: enriched,
        applied_window: {
          time_min: args.time_min,
          time_max: args.time_max,
          reminder_window_minutes: input.reminderWindowMinutes,
        },
      },
      status: "executed",
      signals,
      fallbackHeadline: "calendar_events",
    };
  },
};
