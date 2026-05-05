import { redirect } from "next/navigation";
import { defaultSkillsRoot, loadGlobalSkillRegistry, TOOL_CATALOG } from "@agents/agent";
import { createClient } from "@/lib/supabase/server";
import { ChatInterface } from "./chat-interface";

type RecentToolCall = {
  id: string;
  turn_id?: string | null;
  tool_name: string;
  status: string;
  requires_confirmation: boolean;
  created_at: string;
  finished_at: string | null;
};

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

type ScheduledTaskSummary = {
  activeCount: number;
  pausedCount: number;
  tasks?: Array<{
    id: string;
    prompt: string;
    userRequest?: string | null;
    displayTitle?: string | null;
    scheduleType: "one_time" | "recurring";
    nextRunAt: string | null;
    status: "active" | "paused" | "completed" | "failed";
  }>;
  nextTask?: {
    id: string;
    prompt: string;
    userRequest?: string | null;
    displayTitle?: string | null;
    scheduleType: "one_time" | "recurring";
    nextRunAt: string | null;
    status: "active" | "paused" | "completed" | "failed";
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

export default async function ChatPage() {
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

  const { data: messages } = await supabase
    .from("agent_sessions")
    .select("id")
    .eq("user_id", user.id)
    .eq("channel", "web")
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  let sessionMessages: Array<{
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
  if (messages?.id) {
    const { data } = await supabase
      .from("agent_messages")
      .select("role, content, created_at, turn_id, structured_payload")
      .eq("session_id", messages.id)
      .order("created_at", { ascending: false })
      .limit(50);
    sessionMessages = (data ?? []).reverse();

    const { data: toolCalls } = await supabase
      .from("tool_calls")
      .select("id, turn_id, tool_name, status, requires_confirmation, created_at, finished_at")
      .eq("session_id", messages.id)
      .order("created_at", { ascending: false })
      .limit(80);
    recentToolCalls = (toolCalls ?? []) as RecentToolCall[];

    const { data: pendingMessages } = await supabase
      .from("agent_messages")
      .select("structured_payload")
      .eq("session_id", messages.id)
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
        if (stillPending) {
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
    }));
  heartbeatStatus = {
    ...heartbeatStatus,
    runs: normalizedHeartbeatRuns,
    lastRun: normalizedHeartbeatRuns[0] ?? null,
  };

  const { data: scheduledTasks } = await supabase
    .from("scheduled_tasks")
    .select(
      "id, prompt, user_request, display_title, schedule_type, status, next_run_at, last_failure_error, updated_at"
    )
    .eq("user_id", user.id)
    .in("status", ["active", "paused"])
    .order("next_run_at", { ascending: true, nullsFirst: false })
    .limit(50);
  const taskRows = (scheduledTasks ?? []) as Array<Record<string, unknown>>;
  const activeTasks = taskRows.filter((task) => task.status === "active");
  const pausedTasks = taskRows.filter((task) => task.status === "paused");
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
      status: task.status as "active" | "paused",
    }));
  const nextTask = normalizedScheduledTasks.find(
    (task) => task.status === "active" && task.nextRunAt
  );
  const lastFailureTask = taskRows.find(
    (task) => typeof task.last_failure_error === "string" && task.last_failure_error
  );
  scheduledTaskSummary = {
    activeCount: activeTasks.length,
    pausedCount: pausedTasks.length,
    tasks: normalizedScheduledTasks,
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

  return (
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
    />
  );
}
