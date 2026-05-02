import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  createServerClient,
  decryptToken,
  getGoogleCalendarAccessToken,
} from "@agents/db";
import { runAgent } from "@agents/agent";
import { maybeCatchUpFlush, fireAndForgetFlush } from "@/lib/memory/trigger";

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { message } = await request.json();
    if (!message || typeof message !== "string") {
      return NextResponse.json({ error: "Message required" }, { status: 400 });
    }

    const db = createServerClient();

    const { data: profile } = await supabase
      .from("profiles")
      .select(
        "name, agent_system_prompt, agent_name, timezone, email, phone, business_brain, is_ungga_admin"
      )
      .eq("id", user.id)
      .single();

    const { data: toolSettings } = await supabase
      .from("user_tool_settings")
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
        githubToken = decryptToken(
          githubIntegration.encrypted_tokens as string
        );
      } catch (e) {
        console.error("Failed to decrypt GitHub token:", e);
      }
    }

    let session = await supabase
      .from("agent_sessions")
      .select("*")
      .eq("user_id", user.id)
      .eq("channel", "web")
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(1)
      .single()
      .then((r) => r.data);

    if (!session) {
      const { data } = await supabase
        .from("agent_sessions")
        .insert({
          user_id: user.id,
          channel: "web",
          status: "active",
          budget_tokens_used: 0,
          budget_tokens_limit: 100000,
        })
        .select()
        .single();
      session = data;
    }

    if (!session) {
      return NextResponse.json(
        { error: "Failed to create session" },
        { status: 500 }
      );
    }

    const googleCalendarAccessToken =
      (await getGoogleCalendarAccessToken(db, user.id)) ?? undefined;

    // Catch-up de memoria larga ANTES de runAgent: si la sesión está fría
    // (idle ≥ CATCHUP_IDLE_MIN) o hay otra sesión del usuario sin flushear,
    // consolida esos hechos ahora para que la inyección del turno los vea.
    // Se absorbe su latencia aquí UNA vez (primer turno tras el hueco).
    await maybeCatchUpFlush({
      db,
      userId: user.id,
      sessionId: session.id,
      channel: "web",
    });

    const result = await runAgent({
      message,
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

    // Flush POST fire-and-forget: solo si el turno cerró (sin pendingConfirmation).
    // Un turno con HITL pendiente no "terminó" todavía; el flush se lanzará
    // cuando el usuario apruebe/rechace y el resume devuelva sin pending.
    if (!result.pendingConfirmation) {
      fireAndForgetFlush({
        db,
        userId: user.id,
        sessionId: session.id,
        memoryFlushPending: result.memoryFlushPending,
      });
    }

    return NextResponse.json({
      response: result.pendingConfirmation ? null : result.response,
      pendingConfirmation: result.pendingConfirmation,
      toolCalls: result.toolCalls,
    });
  } catch (error) {
    console.error("Chat API error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
