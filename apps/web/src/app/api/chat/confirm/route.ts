import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  createServerClient,
  decryptToken,
  getGoogleCalendarAccessToken,
  getOperationalCase,
  getPendingToolCall,
  updateToolCallStatus,
} from "@agents/db";
import { runAgent } from "@agents/agent";
import { operationalCaseDocumentRequestTargetFromContext } from "@agents/types";
import { publishTurnEvent } from "@/lib/agent-turn-events";
import {
  findExistingScheduledTaskForConfirmation,
  isScheduleTaskConfirmation,
} from "@/lib/scheduled-task-confirmation";
import { ensureAgentToolDepsWired } from "@/lib/agent/wire-tool-deps";
import { findPendingConfirmationCheckpoint } from "@/lib/agent/pending-confirmation-checkpoint";
import {
  isAgentE2EToolCall,
} from "@/lib/operational-cases/settings-test-tool-policy";
import { buildPublicationAwareE2EToolApprovalPolicy } from "@/lib/operational-cases/publication-tool-policy";
import { finalizeCaseAfterToolDecision } from "@/lib/operational-cases/finalize-case-after-tool-decision";

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
      await finalizeCaseAfterToolDecision(db, {
        toolCall,
        userId: user.id,
        decision: "reject",
      });
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

    const caseId =
      typeof toolCall.metadata_jsonb?.case_id === "string"
        ? toolCall.metadata_jsonb.case_id
        : typeof toolCall.arguments_json?.case_id === "string"
          ? toolCall.arguments_json.case_id
          : undefined;
    const resumeCase = caseId ? await getOperationalCase(db, caseId) : null;
    const resumeContext =
      resumeCase?.user_id === user.id ? (resumeCase.context_jsonb ?? {}) : {};
    const resumePricing =
      resumeContext.pricing_proposal &&
      typeof resumeContext.pricing_proposal === "object" &&
      !Array.isArray(resumeContext.pricing_proposal)
        ? (resumeContext.pricing_proposal as Record<string, unknown>)
        : {};
    const e2eResumePolicy = isAgentE2EToolCall(toolCall)
      ? buildPublicationAwareE2EToolApprovalPolicy({
          context: resumeContext,
          documentRequestTarget:
            operationalCaseDocumentRequestTargetFromContext(resumeContext),
          autoExecuteContractDraftGeneration:
            resumeCase?.current_step === "contract_pending" &&
            resumePricing.approval_status === "approved",
        })
      : undefined;

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
      channel:
        channel === "case_runner" || isAgentE2EToolCall(toolCall)
          ? "case_runner"
          : "web",
      googleCalendarAccessToken,
      caseId,
      toolCallSource: isAgentE2EToolCall(toolCall) ? "agent_e2e" : undefined,
      toolApprovalPolicy: e2eResumePolicy,
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
    await finalizeCaseAfterToolDecision(db, {
      toolCall,
      userId: user.id,
      decision: "approve",
    });

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
