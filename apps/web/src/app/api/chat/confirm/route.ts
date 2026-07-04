import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  countPendingToolCallsForCase,
  createServerClient,
  decryptToken,
  getGoogleCalendarAccessToken,
  getOperationalCase,
  getPendingToolCall,
  resolveUnreadInternalNotificationsByKindForCaseWithReminders,
  updateOperationalCase,
  updateToolCallStatus,
} from "@agents/db";
import { runAgent } from "@agents/agent";
import { publishTurnEvent } from "@/lib/agent-turn-events";
import {
  findExistingScheduledTaskForConfirmation,
  isScheduleTaskConfirmation,
} from "@/lib/scheduled-task-confirmation";
import { ensureAgentToolDepsWired } from "@/lib/agent/wire-tool-deps";
import { findPendingConfirmationCheckpoint } from "@/lib/agent/pending-confirmation-checkpoint";

const TOOL_CONFIRMATION_PENDING_KIND = "tool_confirmation_pending";
const TOOL_CALL_SELECT =
  "id, turn_id, tool_name, arguments_json, result_json, status, requires_confirmation, created_at, finished_at, executor_kind";

async function loadTurnToolCalls(
  supabase: Awaited<ReturnType<typeof createClient>>,
  params: { sessionId: string; turnId?: string | null }
): Promise<Array<Record<string, unknown>>> {
  if (!params.turnId) return [];
  const { data, error } = await supabase
    .from("tool_calls")
    .select(TOOL_CALL_SELECT)
    .eq("session_id", params.sessionId)
    .eq("turn_id", params.turnId)
    .order("created_at", { ascending: true });
  if (error) {
    console.error("[chat-confirm] load turn tool calls failed:", error);
    return [];
  }
  return (data ?? []) as Array<Record<string, unknown>>;
}

function toolCallCaseId(toolCall: {
  arguments_json?: unknown;
  metadata_jsonb?: unknown;
}): string | null {
  const args = toolCall.arguments_json;
  if (
    args &&
    typeof args === "object" &&
    !Array.isArray(args) &&
    typeof (args as Record<string, unknown>).case_id === "string"
  ) {
    const caseId = ((args as Record<string, unknown>).case_id as string).trim();
    if (caseId) return caseId;
  }
  const metadata = toolCall.metadata_jsonb;
  if (
    metadata &&
    typeof metadata === "object" &&
    !Array.isArray(metadata) &&
    typeof (metadata as Record<string, unknown>).case_id === "string"
  ) {
    const caseId = ((metadata as Record<string, unknown>).case_id as string).trim();
    if (caseId) return caseId;
  }
  return null;
}

async function finalizeCaseAfterToolDecision(
  db: ReturnType<typeof createServerClient>,
  params: { toolCall: { arguments_json?: unknown; metadata_jsonb?: unknown }; userId: string }
) {
  const caseId = toolCallCaseId(params.toolCall);
  if (!caseId) return;
  const pending = await countPendingToolCallsForCase(db, caseId);
  if (pending > 0) return;

  await resolveUnreadInternalNotificationsByKindForCaseWithReminders(db, {
    userId: params.userId,
    caseId,
    kind: TOOL_CONFIRMATION_PENDING_KIND,
    status: "actioned",
  });

  const opCase = await getOperationalCase(db, caseId);
  if (
    !opCase ||
    opCase.user_id !== params.userId ||
    !["active", "waiting_internal", "waiting_external"].includes(opCase.status)
  ) {
    return;
  }
  await updateOperationalCase(db, opCase.id, opCase.version, {
    nextActionAt: new Date().toISOString(),
  });
}

export async function POST(request: Request) {
  try {
    ensureAgentToolDepsWired();
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { toolCallId, action, channel } = await request.json();

    if (!toolCallId || !["approve", "reject"].includes(action)) {
      return NextResponse.json(
        { error: "toolCallId and action (approve|reject) required" },
        { status: 400 }
      );
    }

    const db = createServerClient();
    const toolCall = await getPendingToolCall(db, toolCallId);

    if (!toolCall) {
      return NextResponse.json(
        { error: "Tool call not found or already resolved" },
        { status: 404 }
      );
    }

    const { data: session } = await supabase
      .from("agent_sessions")
      .select("id, user_id")
      .eq("id", toolCall.session_id)
      .single();
    if (!session || session.user_id !== user.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (action === "reject") {
      await updateToolCallStatus(db, toolCall.id as string, "rejected", {
        message: "Acción cancelada por el usuario.",
        source: "chat_confirm",
      });
      await finalizeCaseAfterToolDecision(db, { toolCall, userId: user.id });
      const turnId = (toolCall.turn_id as string | null) ?? undefined;
      return NextResponse.json({
        ok: true,
        response: "Acción cancelada.",
        turnId,
        appliedSkills: [],
        memoryUsed: [],
        toolCalls: await loadTurnToolCalls(supabase, {
          sessionId: session.id,
          turnId,
        }),
        pendingConfirmation: null,
      });
    }

    const { data: profile } = await supabase
      .from("profiles")
      .select(
        "name, agent_system_prompt, timezone, email, phone, business_brain, is_ungga_admin"
      )
      .eq("id", user.id)
      .single();

    const toolArgs =
      toolCall.arguments_json &&
      typeof toolCall.arguments_json === "object" &&
      !Array.isArray(toolCall.arguments_json)
        ? (toolCall.arguments_json as Record<string, unknown>)
        : null;
    if (
      action === "approve" &&
      toolCall.tool_name === "schedule_task" &&
      toolArgs
    ) {
      const existingTask = await findExistingScheduledTaskForConfirmation(db, {
        userId: user.id,
        args: toolArgs,
        fallbackTimezone: (profile?.timezone as string | null) ?? null,
      });
      if (existingTask) {
        await updateToolCallStatus(db, toolCall.id as string, "executed", {
          ok: true,
          already_scheduled: true,
          task_id: existingTask.id,
          next_run_at: existingTask.next_run_at,
        });
        const turnId = (toolCall.turn_id as string | null) ?? undefined;
        return NextResponse.json({
          ok: true,
          response: "Listo, esa tarea ya estaba programada.",
          turnId,
          appliedSkills: [],
          memoryUsed: [],
          toolCalls: await loadTurnToolCalls(supabase, {
            sessionId: session.id,
            turnId,
          }),
          pendingConfirmation: null,
        });
      }
    }

    const { data: toolSettings } = await supabase
      .from("user_tool_settings")
      .select("*")
      .eq("user_id", user.id);

    const { data: skillSettings } = await supabase
      .from("user_skill_settings")
      .select("*")
      .eq("user_id", user.id);

    const { data: integrations } = await supabase
      .from("user_integrations")
      .select("*")
      .eq("user_id", user.id)
      .eq("status", "active");

    const githubIntegration = integrations?.find(
      (i: Record<string, unknown>) =>
        i.provider === "github" && i.status === "active"
    );
    let githubToken: string | undefined;
    if (githubIntegration?.encrypted_tokens) {
      try {
        githubToken = decryptToken(githubIntegration.encrypted_tokens as string);
      } catch (e) {
        console.error("Failed to decrypt GitHub token:", e);
      }
    }

    const googleCalendarAccessToken =
      (await getGoogleCalendarAccessToken(db, user.id)) ?? undefined;

    const storedCheckpointThreadId = await findPendingConfirmationCheckpoint(db, {
      sessionId: toolCall.session_id as string,
      toolCallId: toolCall.id as string,
      turnId: (toolCall.turn_id as string | null) ?? null,
    });
    if (!storedCheckpointThreadId) {
      return NextResponse.json(
        { error: "Confirmation checkpoint not found for this tool call" },
        { status: 409 }
      );
    }

    const result = await runAgent({
      resumeDecision: "approve",
      checkpointThreadId: storedCheckpointThreadId,
      turnId: (toolCall.turn_id as string | null) ?? undefined,
      userId: user.id,
      sessionId: session.id,
      systemPrompt:
        (profile?.agent_system_prompt as string) ?? "Eres un asistente útil.",
      db,
      enabledTools: (toolSettings ?? []).map((t: Record<string, unknown>) => ({
        id: t.id as string,
        user_id: t.user_id as string,
        tool_id: t.tool_id as string,
        enabled: t.enabled as boolean,
        config_json: (t.config_json as Record<string, unknown>) ?? {},
      })),
      enabledSkills: (skillSettings ?? []).map((s: Record<string, unknown>) => ({
        id: s.id as string,
        user_id: s.user_id as string,
        skill_id: s.skill_id as string,
        enabled: s.enabled as boolean,
        config_json: (s.config_json as Record<string, unknown>) ?? {},
      })),
      integrations: (integrations ?? []).map((i: Record<string, unknown>) => ({
        id: i.id as string,
        user_id: i.user_id as string,
        provider: i.provider as string,
        scopes: (i.scopes as string[]) ?? [],
        status: i.status as "active" | "revoked" | "expired",
        created_at: i.created_at as string,
      })),
      githubToken,
      userTimezone: (profile?.timezone as string) ?? undefined,
      userName: (profile?.name as string | null) ?? null,
      userEmail: (profile?.email as string | null) ?? null,
      userPhone: (profile?.phone as string | null) ?? null,
      businessBrain:
        (profile?.business_brain as Record<string, unknown> | null) ?? {},
      isUnggaAdmin: (profile?.is_ungga_admin as boolean | null) ?? false,
      channel: channel === "case_runner" ? "case_runner" : "web",
      googleCalendarAccessToken,
      onEvent: (event) => {
        const eventTurnId =
          event.turnId ?? ((toolCall.turn_id as string | null) ?? undefined);
        if (eventTurnId) publishTurnEvent(eventTurnId, event);
      },
    });

    let pendingConfirmation = result.pendingConfirmation;
    if (
      pendingConfirmation &&
      isScheduleTaskConfirmation({
        toolName: pendingConfirmation.toolName,
        args: pendingConfirmation.args,
      })
    ) {
      const existingTask = await findExistingScheduledTaskForConfirmation(db, {
        userId: user.id,
        args: pendingConfirmation.args,
        fallbackTimezone: (profile?.timezone as string | null) ?? null,
      });
      if (existingTask) {
        await updateToolCallStatus(
          db,
          pendingConfirmation.toolCallId,
          "executed",
          {
            ok: true,
            already_scheduled: true,
            task_id: existingTask.id,
            next_run_at: existingTask.next_run_at,
          }
        );
        pendingConfirmation = null;
      }
    }
    await finalizeCaseAfterToolDecision(db, { toolCall, userId: user.id });

    return NextResponse.json({
      ok: true,
      response: pendingConfirmation ? null : result.response,
      turnId: result.turnId,
      appliedSkills: result.appliedSkills,
      memoryUsed: result.memoryUsed,
      toolCalls: await loadTurnToolCalls(supabase, {
        sessionId: session.id,
        turnId: result.turnId,
      }),
      pendingConfirmation,
    });
  } catch (error) {
    console.error("Confirm API error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
