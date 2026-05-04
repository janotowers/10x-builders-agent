import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  createServerClient,
  decryptToken,
  getGoogleCalendarAccessToken,
  getPendingToolCall,
} from "@agents/db";
import { runAgent } from "@agents/agent";

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { toolCallId, action } = await request.json();

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

    const { data: profile } = await supabase
      .from("profiles")
      .select(
        "name, agent_system_prompt, timezone, email, phone, business_brain, is_ungga_admin"
      )
      .eq("id", user.id)
      .single();

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

    // Retrieve the checkpointThreadId stored when the interrupt was created
    const { data: pendingMsg } = await db
      .from("agent_messages")
      .select("structured_payload")
      .eq("session_id", toolCall.session_id)
      .not("structured_payload", "is", null)
      .order("created_at", { ascending: false })
      .limit(5);
    const spEntry = pendingMsg?.find(
      (m) =>
        (m.structured_payload as Record<string, unknown>)?.type ===
        "pending_confirmation"
    );
    const storedCheckpointThreadId = (
      spEntry?.structured_payload as {
        pendingConfirmation?: { checkpointThreadId?: string };
      }
    )?.pendingConfirmation?.checkpointThreadId;

    const result = await runAgent({
      resumeDecision: action === "approve" ? "approve" : "reject",
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
      channel: "web",
      googleCalendarAccessToken,
    });

    return NextResponse.json({
      ok: true,
      response: result.pendingConfirmation ? null : result.response,
      turnId: result.turnId,
      appliedSkills: result.appliedSkills,
      memoryUsed: result.memoryUsed,
      toolCalls: result.toolCalls,
      pendingConfirmation: result.pendingConfirmation,
    });
  } catch (error) {
    console.error("Confirm API error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
