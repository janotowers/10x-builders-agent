import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

type SessionChannel = "web" | "cron" | "heartbeat";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readHeartbeatPayload(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return asRecord(value);
}

function summarizeHeartbeatPayload(value: unknown): string {
  const payload = readHeartbeatPayload(value);
  const response = asString(payload.response).trim();
  if (response) return response;
  const error = asString(payload.error).trim();
  return error || "Sin resumen guardado.";
}

function parseAfter(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const after = parseAfter(url.searchParams.get("after"));

  const { data: profile } = await supabase
    .from("profiles")
    .select("business_brain")
    .eq("id", user.id)
    .maybeSingle();
  const businessBrain = asRecord(profile?.business_brain);

  const { data: sessionRows } = await supabase
    .from("agent_sessions")
    .select("id, channel")
    .eq("user_id", user.id)
    .in("channel", ["web", "cron", "heartbeat"])
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(10);

  const activeSessions = ((sessionRows ?? []) as Array<{
    id?: unknown;
    channel?: unknown;
  }>).filter(
    (session): session is { id: string; channel: SessionChannel } =>
      typeof session.id === "string" &&
      (session.channel === "web" ||
        session.channel === "cron" ||
        session.channel === "heartbeat")
  );
  const automatedSessions = activeSessions.filter(
    (session) => session.channel === "cron" || session.channel === "heartbeat"
  );
  const sessionIds = activeSessions.map((session) => session.id);
  const automatedSessionIds = automatedSessions.map((session) => session.id);
  const channelBySessionId = new Map(
    activeSessions.map((session) => [session.id, session.channel])
  );

  let messages: Array<Record<string, unknown>> = [];
  if (automatedSessionIds.length > 0) {
    let query = supabase
      .from("agent_messages")
      .select("id, session_id, role, content, created_at, turn_id, structured_payload")
      .in("session_id", automatedSessionIds)
      .eq("role", "assistant")
      .order("created_at", { ascending: true })
      .limit(30);
    if (after) query = query.gt("created_at", after);
    const { data } = await query;
    messages = (data ?? []).map((message: Record<string, unknown>) => {
      const channel = channelBySessionId.get(String(message.session_id));
      const payload = asRecord(message.structured_payload);
      return {
        id: typeof message.id === "string" ? message.id : undefined,
        role: String(message.role ?? ""),
        content: String(message.content ?? ""),
        created_at: String(message.created_at ?? ""),
        turn_id: typeof message.turn_id === "string" ? message.turn_id : null,
        structured_payload: {
          ...payload,
          source: channel === "heartbeat" ? "heartbeat" : "scheduled_task",
          channel,
        },
      };
    });
  }

  let toolCalls: Array<Record<string, unknown>> = [];
  if (sessionIds.length > 0) {
    const { data } = await supabase
      .from("tool_calls")
      .select("id, turn_id, tool_name, arguments_json, result_json, status, requires_confirmation, created_at, finished_at")
      .in("session_id", sessionIds)
      .order("created_at", { ascending: false })
      .limit(80);
    toolCalls = (data ?? []) as Array<Record<string, unknown>>;
  }

  const heartbeat = asRecord(businessBrain.heartbeat);
  const { data: heartbeatRuns } = await supabase
    .from("heartbeat_runs")
    .select("status, started_at, finished_at, payload, error")
    .eq("user_id", user.id)
    .order("started_at", { ascending: false })
    .limit(15);
  const normalizedHeartbeatRuns = ((heartbeatRuns ?? []) as Array<Record<string, unknown>>)
    .filter(
      (run) =>
        typeof run.started_at === "string" &&
        (run.status === "running" ||
          run.status === "completed" ||
          run.status === "error")
    )
    .map((run) => ({
      status: run.status as "running" | "completed" | "error",
      startedAt: run.started_at as string,
      finishedAt: typeof run.finished_at === "string" ? run.finished_at : null,
      summary:
        typeof run.error === "string" && run.error
          ? run.error
          : summarizeHeartbeatPayload(run.payload),
    }));

  const { data: scheduledTasks } = await supabase
    .from("scheduled_tasks")
    .select(
      "id, prompt, user_request, display_title, schedule_type, status, next_run_at, last_failure_error"
    )
    .eq("user_id", user.id)
    .in("status", ["active", "paused"])
    .order("next_run_at", { ascending: true, nullsFirst: false })
    .limit(50);
  const taskRows = (scheduledTasks ?? []) as Array<Record<string, unknown>>;
  const taskIds = taskRows
    .map((task) => task.id)
    .filter((id): id is string => typeof id === "string");
  let runningTaskIds = new Set<string>();
  if (taskIds.length > 0) {
    const { data: activeRuns } = await supabase
      .from("scheduled_task_runs")
      .select("task_id")
      .in("task_id", taskIds)
      .eq("status", "running");
    runningTaskIds = new Set(
      ((activeRuns ?? []) as Array<{ task_id?: unknown }>)
        .map((row) => row.task_id)
        .filter((id): id is string => typeof id === "string")
    );
  }
  type DisplayStatus = "active" | "paused" | "completed" | "failed" | "running";
  const resolveDisplayStatus = (task: Record<string, unknown>): DisplayStatus => {
    if (typeof task.id === "string" && runningTaskIds.has(task.id)) {
      return "running";
    }
    return task.status as DisplayStatus;
  };
  const activeTasks = taskRows.filter(
    (task) => resolveDisplayStatus(task) === "active"
  );
  const pausedTasks = taskRows.filter(
    (task) => resolveDisplayStatus(task) === "paused"
  );
  const normalizedScheduledTasks = taskRows
    .filter(
      (task) =>
        typeof task.id === "string" &&
        typeof task.prompt === "string" &&
        (task.schedule_type === "one_time" ||
          task.schedule_type === "recurring") &&
        (task.status === "active" || task.status === "paused")
    )
    .map((task) => ({
      id: task.id as string,
      prompt: task.prompt as string,
      userRequest:
        typeof task.user_request === "string" ? task.user_request : null,
      displayTitle:
        typeof task.display_title === "string" ? task.display_title : null,
      scheduleType: task.schedule_type as "one_time" | "recurring",
      nextRunAt:
        typeof task.next_run_at === "string" ? task.next_run_at : null,
      status: resolveDisplayStatus(task),
    }));
  const lastFailureTask = taskRows.find(
    (task) => typeof task.last_failure_error === "string" && task.last_failure_error
  );

  return NextResponse.json({
    messages,
    toolCalls,
    heartbeatStatus: {
      enabled: heartbeat.enabled === true,
      intervalMinutes:
        typeof heartbeat.interval_minutes === "number"
          ? Math.max(5, Math.min(24 * 60, Math.floor(heartbeat.interval_minutes)))
          : 30,
      runs: normalizedHeartbeatRuns,
      lastRun: normalizedHeartbeatRuns[0] ?? null,
    },
    scheduledTaskSummary: {
      activeCount: activeTasks.length,
      pausedCount: pausedTasks.length,
      runningCount: runningTaskIds.size,
      tasks: normalizedScheduledTasks,
      nextTask:
        normalizedScheduledTasks.find(
          (task) =>
            (task.status === "active" || task.status === "running") &&
            task.nextRunAt
        ) ?? null,
      lastFailure:
        typeof lastFailureTask?.last_failure_error === "string"
          ? lastFailureTask.last_failure_error
          : null,
    },
  });
}
