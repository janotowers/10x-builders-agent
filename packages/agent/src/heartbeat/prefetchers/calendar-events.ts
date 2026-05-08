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

function eventBoundaryMs(boundary: unknown): number | null {
  const record = asRecord(boundary);
  const dateTime = record.dateTime;
  if (typeof dateTime !== "string" || !dateTime.trim()) return null;
  const ms = Date.parse(dateTime);
  return Number.isFinite(ms) ? ms : null;
}

function eventBoundaryKey(boundary: unknown): string {
  const record = asRecord(boundary);
  const dateTime = record.dateTime;
  if (typeof dateTime === "string" && dateTime.trim()) return dateTime.trim();
  const date = record.date;
  return typeof date === "string" && date.trim() ? date.trim() : "";
}

function eventOccurrenceKey(event: Record<string, unknown>): string | null {
  const start = eventBoundaryKey(event.start);
  if (!start) return null;
  const id = typeof event.id === "string" && event.id.trim()
    ? event.id.trim()
    : "";
  if (id) return `${id}::${start}`;
  const summary = typeof event.summary === "string" && event.summary.trim()
    ? event.summary.trim()
    : "";
  return summary ? `${summary}::${start}` : null;
}

function eventOccurrenceKeyFromPersisted(value: unknown): string | null {
  const event = asRecord(value);
  return eventOccurrenceKey(event);
}

async function loadRecentlyEmittedEventKeys(
  env: HeartbeatPrefetchEnv
): Promise<Set<string>> {
  const since = new Date(env.now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  try {
    const { data, error } = await env.db
      .from("tool_calls")
      .select("result_json")
      .eq("session_id", env.sessionId)
      .eq("tool_name", "calendar_list_events")
      .eq("executor_kind", "deterministic")
      .eq("status", "executed")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw error;

    const keys = new Set<string>();
    for (const row of data ?? []) {
      const result = asRecord(
        (row as { result_json?: unknown }).result_json
      );
      const events = result.events;
      if (!Array.isArray(events)) continue;
      for (const event of events) {
        const key = eventOccurrenceKeyFromPersisted(event);
        if (key) keys.add(key);
      }
    }
    return keys;
  } catch (err) {
    console.warn(
      "[heartbeat] failed to load previously emitted calendar signals:",
      err instanceof Error ? err.message : String(err)
    );
    return new Set();
  }
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
    const recentlyEmittedKeys = await loadRecentlyEmittedEventKeys(env);
    const signals: HeartbeatPrefetchSignal[] = [];
    const suppressedSignals: HeartbeatPrefetchSignal[] = [];
    const enriched: Array<Record<string, unknown>> = [];
    const suppressedEnriched: Array<Record<string, unknown>> = [];

    for (const event of events) {
      const e = asRecord(event);
      if (e.status === "cancelled") continue;
      const startMs = eventBoundaryMs(e.start);
      const endMs = eventBoundaryMs(e.end);
      if (startMs === null) continue;
      // Two complementary cases count as a heartbeat signal:
      //   1) The event starts inside the lookahead window (-60s grace for the
      //      "just started" case).
      //   2) The event already started but has not ended yet (in-progress).
      // Without case (2) the prefetcher and the LLM-issued `calendar_list_events`
      // disagreed: Google returns events that overlap the time window, so the
      // model would surface in-progress meetings while the deterministic
      // signal block was empty. See `docs/heartbeat/deterministic-prefetchers.md`.
      const startsInWindow =
        startMs >= nowMs - 60_000 && startMs <= horizonMs;
      const isInProgress =
        startMs < nowMs && endMs !== null && endMs > nowMs;
      if (!startsInWindow && !isInProgress) continue;

      const display = eventDisplayFields(e, env.timezone);
      const summary =
        typeof e.summary === "string" && e.summary.trim()
          ? e.summary.trim()
          : "Evento sin título";
      // `startsInMinutes` is negative for in-progress events (minutes elapsed).
      const startsInMinutes = Math.round((startMs - nowMs) / 60_000);
      // `minutesAhead` stays non-negative to keep the existing
      // `HeartbeatPrefetchSignal` contract (sorting / threshold copy).
      const minutesAhead = Math.max(0, startsInMinutes);
      const id = typeof e.id === "string" ? e.id : `event-${signals.length}`;
      const signal: HeartbeatPrefetchSignal = {
        id,
        title: summary,
        whenDisplay: display.start_display,
        minutesAhead,
        details: {
          starts_in_minutes: startsInMinutes,
          start: display.start_display,
          end: display.end_display,
          // Surfaced explicitly so prompt formatters and the fallback copy
          // can pick "in progress" wording without re-deriving from numbers.
          is_in_progress: isInProgress ? "yes" : undefined,
          status:
            typeof e.status === "string" ? (e.status as string) : undefined,
          transparency:
            typeof e.transparency === "string"
              ? (e.transparency as string)
              : undefined,
          calendar_id: "primary",
        },
      };
      const enrichedEvent = {
        id: e.id,
        summary,
        status: e.status,
        start: e.start,
        end: e.end,
        start_display: display.start_display,
        end_display: display.end_display,
        starts_in_minutes: startsInMinutes,
        is_in_progress: isInProgress,
        calendar_id: "primary",
      };
      const occurrenceKey = eventOccurrenceKey(e);
      if (occurrenceKey && recentlyEmittedKeys.has(occurrenceKey)) {
        suppressedSignals.push(signal);
        suppressedEnriched.push(enrichedEvent);
        continue;
      }
      signals.push(signal);
      enriched.push(enrichedEvent);
    }

    const result: Record<string, unknown> = {
      events: enriched,
      applied_window: {
        time_min: args.time_min,
        time_max: args.time_max,
        reminder_window_minutes: input.reminderWindowMinutes,
      },
    };
    if (suppressedEnriched.length > 0) {
      result.suppressed_events = suppressedEnriched;
      result.suppression_reason =
        "same_event_occurrence_already_emitted_recently";
    }

    return {
      toolName: this.toolName,
      arguments: args,
      result,
      status: "executed",
      signals,
      suppressedSignals,
      fallbackHeadline: "calendar_events",
    };
  },
};
