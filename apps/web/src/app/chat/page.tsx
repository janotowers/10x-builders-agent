import { redirect } from "next/navigation";
import { defaultSkillsRoot, loadGlobalSkillRegistry, TOOL_CATALOG } from "@agents/agent";
import {
  findExistingScheduledTaskForConfirmation,
  isScheduleTaskConfirmation,
} from "@/lib/scheduled-task-confirmation";
import { sortScheduledTasksForDisplay } from "@/lib/scheduled-task-display-order";
import { createClient } from "@/lib/supabase/server";
import { hiddenInboxNotificationKinds } from "@/lib/internal-notifications/registry";
import { AppShell } from "@/components/app-shell";
import { ChatInterface } from "./chat-interface";

type RecentToolCall = {
  id: string;
  turn_id?: string | null;
  tool_name: string;
  arguments_json?: Record<string, unknown> | null;
  result_json?: Record<string, unknown> | null;
  status: string;
  requires_confirmation: boolean;
  created_at: string;
  finished_at: string | null;
};

type SessionChannel = "web" | "cron" | "heartbeat";

type AppliedSkill = {
  id: string;
  role: "primary" | "included";
};

type AppliedMemory = {
  source: "short_term" | "long_term";
  type?: "episodic" | "semantic" | "procedural";
  content: string;
  count?: number;
  previews?: Array<{
    role: string;
    content: string;
    created_at?: string;
  }>;
};

type RecentLearning = {
  id: string;
  type: "episodic" | "semantic" | "procedural";
  content: string;
  created_at: string;
};

type AvailableSkill = {
  id: string;
  scope: "business" | "personal" | "shared";
};

type AvailableTool = {
  id: string;
  requiresIntegration?: string | null;
};

type HeartbeatStatus = {
  enabled: boolean;
  intervalMinutes: number;
  runs?: Array<{
    status: "running" | "completed" | "error";
    startedAt: string;
    finishedAt?: string | null;
    summary: string;
  }>;
  lastRun?: {
    status: "running" | "completed" | "error";
    startedAt: string;
    finishedAt?: string | null;
    summary: string;
  } | null;
};

type ScheduledTaskDisplayStatus =
  | "active"
  | "paused"
  | "completed"
  | "failed"
  | "running";

type ScheduledTaskSummary = {
  activeCount: number;
  pausedCount: number;
  runningCount?: number;
  tasks?: Array<{
    id: string;
    prompt: string;
    userRequest?: string | null;
    displayTitle?: string | null;
    skillId?: string | null;
    scheduleType: "one_time" | "recurring";
    nextRunAt: string | null;
    status: ScheduledTaskDisplayStatus;
  }>;
  nextTask?: {
    id: string;
    prompt: string;
    userRequest?: string | null;
    displayTitle?: string | null;
    skillId?: string | null;
    scheduleType: "one_time" | "recurring";
    nextRunAt: string | null;
    status: ScheduledTaskDisplayStatus;
  } | null;
  lastFailure?: string | null;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
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

async function signedProfileAssetUrl(
  supabase: Awaited<ReturnType<typeof createClient>>,
  path: unknown
): Promise<string> {
  if (typeof path !== "string" || !path) return "";
  if (path.startsWith("http")) return path;
  const { data } = await supabase.storage
    .from("profile-assets")
    .createSignedUrl(path, 60 * 60);
  return data?.signedUrl ?? "";
}

export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<{
    pendientes?: string;
    case?: string;
    focus?: string;
  }>;
}) {
  const sp = await searchParams;
  if (sp.pendientes === "1") {
    const params = new URLSearchParams();
    if (sp.case?.trim()) params.set("case", sp.case.trim());
    if (sp.focus?.trim()) params.set("focus", sp.focus.trim());
    const query = params.toString();
    redirect(query ? `/chat/pending?${query}` : "/chat/pending");
  }
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();

  if (!profile?.onboarding_completed) redirect("/onboarding");
  const businessBrain = asRecord(profile.business_brain);
  const agentIdentity = asRecord(businessBrain.agent_identity);
  const soul = asRecord(businessBrain.soul);
  const businessContext = asRecord(businessBrain.business_context);
  const operatingPreferences = asRecord(businessBrain.operating_preferences);
  const agentEmoji =
    typeof agentIdentity.emoji === "string" ? agentIdentity.emoji : "";
  const agentAvatarUrl = await signedProfileAssetUrl(
    supabase,
    agentIdentity.avatar_path || agentIdentity.avatar_url
  );
  const userAvatarUrl = await signedProfileAssetUrl(
    supabase,
    profile.avatar_path || profile.avatar_url
  );

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
  const sessionIds = activeSessions.map((session) => session.id);
  const channelBySessionId = new Map(
    activeSessions.map((session) => [session.id, session.channel])
  );
  const webSession = activeSessions.find((session) => session.channel === "web");

  let sessionMessages: Array<{
    id?: string;
    role: string;
    content: string;
    created_at: string;
    turn_id?: string | null;
    structured_payload?: Record<string, unknown> | null;
  }> = [];
  let recentToolCalls: RecentToolCall[] = [];
  let recentLearnings: RecentLearning[] = [];
  let availableSkills: AvailableSkill[] = [];
  let availableTools: AvailableTool[] = [];
  let heartbeatStatus: HeartbeatStatus = {
    enabled: asRecord(businessBrain.heartbeat).enabled === true,
    intervalMinutes:
      typeof asRecord(businessBrain.heartbeat).interval_minutes === "number"
        ? Math.max(
            5,
            Math.min(
              24 * 60,
              Math.floor(asRecord(businessBrain.heartbeat).interval_minutes as number)
            )
          )
        : 30,
    runs: [],
    lastRun: null,
  };
  let scheduledTaskSummary: ScheduledTaskSummary = {
    activeCount: 0,
    pausedCount: 0,
    tasks: [],
    nextTask: null,
    lastFailure: null,
  };
  let initialPendingConfirmation:
    | {
        toolCallId: string;
        toolName: string;
        message: string;
        args: Record<string, unknown>;
        turnId?: string | null;
        appliedSkills?: AppliedSkill[];
        memoryUsed?: AppliedMemory[];
        checkpointThreadId: string;
      }
    | null = null;
  if (sessionIds.length > 0) {
    const { data } = await supabase
      .from("agent_messages")
      .select("id, session_id, role, content, created_at, turn_id, structured_payload")
      .in("session_id", sessionIds)
      .order("created_at", { ascending: false })
      .limit(100);
    sessionMessages = (data ?? [])
      .filter((message: Record<string, unknown>) => {
        const channel = channelBySessionId.get(String(message.session_id));
        // Automated turns persist their internal prompt as a user message. The
        // chat timeline should show what Gu emitted to the user, not the runner
        // prompt that triggered it.
        return channel === "web" || message.role === "assistant";
      })
      .map((message: Record<string, unknown>) => {
        const channel = channelBySessionId.get(String(message.session_id));
        const payload = asRecord(message.structured_payload);
        const automatedSource =
          channel === "cron"
            ? "scheduled_task"
            : channel === "heartbeat"
              ? "heartbeat"
              : null;
        return {
          id: typeof message.id === "string" ? message.id : undefined,
          role: String(message.role ?? ""),
          content: String(message.content ?? ""),
          created_at: String(message.created_at ?? ""),
          turn_id:
            typeof message.turn_id === "string" ? message.turn_id : null,
          structured_payload: automatedSource
            ? {
                ...payload,
                source: automatedSource,
                channel,
              }
            : Object.keys(payload).length > 0
              ? payload
              : null,
        };
      })
      .reverse();

    const { data: toolCalls } = await supabase
      .from("tool_calls")
      .select(
        "id, turn_id, tool_name, arguments_json, result_json, status, requires_confirmation, created_at, finished_at, executor_kind"
      )
      .in("session_id", sessionIds)
      .order("created_at", { ascending: false })
      .limit(80);
    recentToolCalls = (toolCalls ?? []) as RecentToolCall[];
  }

  if (webSession?.id) {
    const { data: pendingMessages } = await supabase
      .from("agent_messages")
      .select("structured_payload")
      .eq("session_id", webSession.id)
      .not("structured_payload", "is", null)
      .order("created_at", { ascending: false })
      .limit(5);

    const pendingMsg = pendingMessages?.find(
      (m) =>
        (m.structured_payload as Record<string, unknown>)?.type ===
        "pending_confirmation"
    );
    if (pendingMsg) {
      const sp = pendingMsg.structured_payload as {
        pendingConfirmation?: {
          toolCallId: string;
          toolName: string;
          message: string;
          args: Record<string, unknown>;
          turnId?: string | null;
          appliedSkills?: AppliedSkill[];
          memoryUsed?: AppliedMemory[];
          checkpointThreadId: string;
        };
      };
      if (sp.pendingConfirmation) {
        const { data: stillPending } = await supabase
          .from("tool_calls")
          .select("id, turn_id")
          .eq("id", sp.pendingConfirmation.toolCallId)
          .eq("status", "pending_confirmation")
          .maybeSingle();
        const scheduleConfirmation = {
          toolName: sp.pendingConfirmation.toolName,
          args: sp.pendingConfirmation.args,
        };
        const alreadyScheduled = isScheduleTaskConfirmation(scheduleConfirmation)
          ? await findExistingScheduledTaskForConfirmation(supabase, {
              userId: user.id,
              args: scheduleConfirmation.args,
              fallbackTimezone: (profile?.timezone as string | null) ?? null,
            })
          : null;
        if (stillPending && !alreadyScheduled) {
          initialPendingConfirmation = {
            ...sp.pendingConfirmation,
            turnId:
              sp.pendingConfirmation.turnId ??
              ((stillPending.turn_id as string | null) ?? null),
          };
        }
      }
    }
  }

  const { data: memories } = await supabase
    .from("memories")
    .select("id, type, content, created_at")
    .eq("user_id", user.id)
    .is("archived_at", null)
    .order("created_at", { ascending: false })
    .limit(5);
  recentLearnings = (memories ?? []) as RecentLearning[];

  const { data: heartbeatRuns } = await supabase
    .from("heartbeat_runs")
    .select("status, started_at, finished_at, payload, error")
    .eq("user_id", user.id)
    .order("started_at", { ascending: false })
    .limit(15);
  const heartbeatRunRows = (heartbeatRuns ?? []) as Array<{
    status?: string;
    started_at?: string;
    finished_at?: string | null;
    payload?: unknown;
    error?: string | null;
  }>;
  const normalizedHeartbeatRuns = heartbeatRunRows
    .filter(
      (run) =>
        run.started_at &&
        (run.status === "running" ||
          run.status === "completed" ||
          run.status === "error")
    )
    .map((run) => ({
      status: run.status as "running" | "completed" | "error",
      startedAt: run.started_at!,
      finishedAt: run.finished_at ?? null,
      summary: run.error ?? summarizeHeartbeatPayload(run.payload),
      details: readHeartbeatPayload(run.payload),
    }));
  heartbeatStatus = {
    ...heartbeatStatus,
    runs: normalizedHeartbeatRuns,
    lastRun: normalizedHeartbeatRuns[0] ?? null,
  };

  const scheduledTasksResult = await supabase
    .from("scheduled_tasks")
    .select(
      "id, prompt, user_request, display_title, skill_id, schedule_type, status, next_run_at, last_failure_error, updated_at"
    )
    .eq("user_id", user.id)
    .in("status", ["active", "paused"])
    .order("next_run_at", { ascending: true, nullsFirst: false })
    .limit(50);
  let scheduledTasks = scheduledTasksResult.data as
    | Array<Record<string, unknown>>
    | null;
  let scheduledTasksError = scheduledTasksResult.error;
  if (scheduledTasksError) {
    console.warn(
      "[chat] scheduled_tasks query with skill columns failed; retrying legacy projection:",
      scheduledTasksError.message
    );
    const fallback = await supabase
      .from("scheduled_tasks")
      .select(
        "id, prompt, user_request, display_title, schedule_type, status, next_run_at, last_failure_error, updated_at"
      )
      .eq("user_id", user.id)
      .in("status", ["active", "paused"])
      .order("next_run_at", { ascending: true, nullsFirst: false })
      .limit(50);
    scheduledTasks = fallback.data as Array<Record<string, unknown>> | null;
    scheduledTasksError = fallback.error;
  }
  if (scheduledTasksError) {
    console.error("[chat] scheduled_tasks query failed:", scheduledTasksError);
  }
  const taskRows = (scheduledTasks ?? []) as Array<Record<string, unknown>>;
  const taskIds = taskRows
    .map((task) => task.id)
    .filter((id): id is string => typeof id === "string");
  // The cron lock flips status='paused' transiently while a run is in flight;
  // detect those tasks via a currently-running task_run so the UI shows
  // "Ejecutándose ahora" instead of "Pausada".
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
  const resolveDisplayStatus = (task: Record<string, unknown>): ScheduledTaskDisplayStatus => {
    if (typeof task.id === "string" && runningTaskIds.has(task.id)) {
      return "running";
    }
    return task.status as ScheduledTaskDisplayStatus;
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
      skillId: typeof task.skill_id === "string" ? task.skill_id : null,
      scheduleType: task.schedule_type as "one_time" | "recurring",
      nextRunAt:
        typeof task.next_run_at === "string" ? task.next_run_at : null,
      status: resolveDisplayStatus(task),
    }));
  const orderedScheduledTasks =
    sortScheduledTasksForDisplay(normalizedScheduledTasks);
  const nextTask = orderedScheduledTasks.find(
    (task) =>
      (task.status === "active" || task.status === "running") && task.nextRunAt
  );
  const lastFailureTask = taskRows.find(
    (task) => typeof task.last_failure_error === "string" && task.last_failure_error
  );
  scheduledTaskSummary = {
    activeCount: activeTasks.length,
    pausedCount: pausedTasks.length,
    runningCount: runningTaskIds.size,
    tasks: orderedScheduledTasks,
    nextTask: nextTask ?? null,
    lastFailure:
      typeof lastFailureTask?.last_failure_error === "string"
        ? lastFailureTask.last_failure_error
        : null,
  };

  const { data: toolSettings } = await supabase
    .from("user_tool_settings")
    .select("tool_id, enabled")
    .eq("user_id", user.id);
  const enabledToolIds = new Set(
    (toolSettings ?? [])
      .filter((row: Record<string, unknown>) => row.enabled === true)
      .map((row: Record<string, unknown>) => row.tool_id)
      .filter((toolId): toolId is string => typeof toolId === "string")
  );
  availableTools = TOOL_CATALOG.filter((tool) => enabledToolIds.has(tool.id)).map(
    (tool) => ({
      id: tool.id,
      requiresIntegration: tool.requires_integration ?? null,
    })
  );

  const { data: skillSettings } = await supabase
    .from("user_skill_settings")
    .select("skill_id, enabled")
    .eq("user_id", user.id);
  const skillEnabledById = new Map(
    (skillSettings ?? [])
      .filter((row: Record<string, unknown>) => typeof row.skill_id === "string")
      .map((row: Record<string, unknown>) => [
        row.skill_id as string,
        row.enabled !== false,
      ])
  );

  try {
    const skillRegistry = await loadGlobalSkillRegistry(defaultSkillsRoot(), {
      onParseError: () => {},
    });
    availableSkills = skillRegistry
      .list()
      .filter((skill) => skillEnabledById.get(skill.name) !== false)
      .map((skill) => ({
        id: skill.name,
        scope: skill.scope,
      }));
  } catch {
    availableSkills = [];
  }

  const hiddenNotificationKinds = hiddenInboxNotificationKinds();
  let unreadNotificationsQuery = supabase
    .from("internal_user_notifications")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .eq("status", "unread");
  if (hiddenNotificationKinds.length > 0) {
    unreadNotificationsQuery = unreadNotificationsQuery.not(
      "kind",
      "in",
      `(${hiddenNotificationKinds.join(",")})`
    );
  }
  const { count: pendingInboxCount } = await unreadNotificationsQuery;

  return (
    <AppShell
      viewportFill
      title="Conversación"
      description="Habla con Gu y revisa el contexto operativo de cada turno."
    >
      <ChatInterface
        agentName={profile.agent_name as string}
        agentAvatarUrl={agentAvatarUrl}
        agentEmoji={agentEmoji}
        userAvatarUrl={userAvatarUrl}
        userName={(profile.name as string) ?? ""}
        baseContext={{
          identity: {
            name: asString(agentIdentity.name) || (profile.agent_name as string),
            role: asString(agentIdentity.role),
            shortDescription: asString(agentIdentity.short_description),
          },
          soul: {
            voice: asString(soul.voice),
            tone: asString(soul.tone),
            style: asString(soul.style),
            brevity: asString(soul.brevity),
          },
          businessContext: {
            kind: asString(businessContext.kind),
            markets: asStringArray(businessContext.markets),
            notes: asString(businessContext.notes),
          },
          operatingPreferences: asString(operatingPreferences.text),
        }}
        availableSkills={availableSkills}
        availableTools={availableTools}
        initialMessages={sessionMessages}
        initialToolCalls={recentToolCalls}
        initialPendingConfirmation={initialPendingConfirmation}
        initialRecentLearnings={recentLearnings}
        heartbeatStatus={heartbeatStatus}
        scheduledTaskSummary={scheduledTaskSummary}
        pendingInboxCount={pendingInboxCount ?? 0}
      />
    </AppShell>
  );
}
