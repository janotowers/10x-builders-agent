/**
 * Google Tasks prefetcher.
 *
 * Mirrors the `calendar_list_tasks` tool's read shape so the persisted
 * `tool_calls` row renders the same way in the chat panel (counted as
 * "N tareas") with a "Determinístico" badge.
 */
import { googleCalendarJson } from "../../tools/calendar-api";
import type {
  HeartbeatPrefetcher,
  HeartbeatPrefetchEnv,
  HeartbeatPrefetchInput,
  HeartbeatPrefetchOutput,
  HeartbeatPrefetchSignal,
} from "./types";

const GOOGLE_TASKS_READONLY_SCOPE =
  "https://www.googleapis.com/auth/tasks.readonly";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function googleTaskDueMs(task: Record<string, unknown>): number | null {
  const due = task.due;
  if (typeof due !== "string" || !due.trim()) return null;
  const ms = Date.parse(due);
  return Number.isFinite(ms) ? ms : null;
}

function formatGoogleTaskDue(due: unknown, timeZone: string): string {
  if (typeof due !== "string" || !due.trim()) return "";
  const instant = new Date(due);
  if (Number.isNaN(instant.getTime())) return due;
  try {
    return new Intl.DateTimeFormat("es-MX", {
      timeZone,
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(instant);
  } catch {
    return due;
  }
}

export const calendarTasksPrefetcher: HeartbeatPrefetcher = {
  kind: "calendar_tasks",
  toolName: "calendar_list_tasks",
  isAvailable(env: HeartbeatPrefetchEnv): boolean {
    if (!env.googleCalendarAccessToken) return false;
    return env.integrations.some(
      (i) =>
        i.provider === "google_calendar" &&
        i.status === "active" &&
        i.scopes.includes(GOOGLE_TASKS_READONLY_SCOPE)
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
      due_min: now.toISOString(),
      due_max: new Date(horizonMs).toISOString(),
      show_completed: false,
    };

    const listsResponse = await googleCalendarJson(
      token,
      "https://tasks.googleapis.com/tasks/v1/users/@me/lists?maxResults=100"
    );
    if (listsResponse.status >= 400) {
      return {
        toolName: this.toolName,
        arguments: args,
        result: {
          error: "Google Tasks API error",
          status: listsResponse.status,
          details: listsResponse.data,
        },
        status: "failed",
        signals: [],
      };
    }

    const rawLists = asRecord(listsResponse.data).items;
    const lists = Array.isArray(rawLists) ? rawLists.map(asRecord) : [];
    const taskLists: Array<{ id: string; title: string }> = [];
    const tasks: Array<Record<string, unknown>> = [];
    const signals: HeartbeatPrefetchSignal[] = [];

    for (const list of lists) {
      const id = typeof list.id === "string" ? list.id : "";
      if (!id) continue;
      const title =
        typeof list.title === "string" && list.title.trim()
          ? (list.title as string)
          : id;
      taskLists.push({ id, title });

      const query = new URLSearchParams({
        maxResults: "50",
        showDeleted: "false",
        showHidden: "false",
        showCompleted: "false",
        dueMin: args.due_min,
        dueMax: args.due_max,
      });
      const tasksResponse = await googleCalendarJson(
        token,
        `https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(id)}/tasks?${query.toString()}`
      );
      if (tasksResponse.status >= 400) {
        return {
          toolName: this.toolName,
          arguments: args,
          result: {
            error: "Google Tasks API error",
            status: tasksResponse.status,
            tasklist_id: id,
            details: tasksResponse.data,
          },
          status: "failed",
          signals: [],
        };
      }

      const rawTasks = asRecord(tasksResponse.data).items;
      const items = Array.isArray(rawTasks) ? rawTasks.map(asRecord) : [];
      for (const task of items) {
        if (task.status === "completed") continue;
        const dueMs = googleTaskDueMs(task);
        if (dueMs === null || dueMs < nowMs - 60_000 || dueMs > horizonMs) {
          continue;
        }
        const dueDisplay = formatGoogleTaskDue(task.due, env.timezone);
        const titleStr =
          typeof task.title === "string" && task.title.trim()
            ? (task.title as string)
            : "Tarea sin título";
        const minutesAhead = Math.max(0, Math.round((dueMs - nowMs) / 60_000));
        const taskId =
          typeof task.id === "string" ? (task.id as string) : `task-${signals.length}`;

        signals.push({
          id: taskId,
          title: titleStr,
          whenDisplay: dueDisplay || `en ${minutesAhead} min`,
          minutesAhead,
          details: {
            due_in_minutes: minutesAhead,
            due: dueDisplay,
            status:
              typeof task.status === "string" ? (task.status as string) : undefined,
            tasklist: title,
            tasklist_id: id,
          },
        });
        tasks.push({
          id: task.id,
          title: titleStr,
          notes: task.notes,
          status: task.status,
          due: task.due,
          due_display: dueDisplay,
          tasklist_id: id,
          tasklist_title: title,
          due_in_minutes: minutesAhead,
        });
      }
    }

    return {
      toolName: this.toolName,
      arguments: args,
      result: {
        tasks,
        tasklists: taskLists,
        applied_window: {
          due_min: args.due_min,
          due_max: args.due_max,
          reminder_window_minutes: input.reminderWindowMinutes,
        },
        display_hint:
          "Muestra al usuario due_display cuando exista. Estas son Google Tasks, no tareas programadas internas de Gu.",
      },
      status: "executed",
      signals,
      fallbackHeadline: "calendar_tasks",
    };
  },
};
