import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ChatInterface } from "./chat-interface";

type RecentToolCall = {
  id: string;
  tool_name: string;
  status: string;
  requires_confirmation: boolean;
  created_at: string;
  finished_at: string | null;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
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

  let sessionMessages: Array<{ role: string; content: string; created_at: string }> = [];
  let recentToolCalls: RecentToolCall[] = [];
  let initialPendingConfirmation:
    | {
        toolCallId: string;
        toolName: string;
        message: string;
        args: Record<string, unknown>;
        checkpointThreadId: string;
      }
    | null = null;
  if (messages?.id) {
    const { data } = await supabase
      .from("agent_messages")
      .select("role, content, created_at")
      .eq("session_id", messages.id)
      .order("created_at", { ascending: false })
      .limit(50);
    sessionMessages = (data ?? []).reverse();

    const { data: toolCalls } = await supabase
      .from("tool_calls")
      .select("id, tool_name, status, requires_confirmation, created_at, finished_at")
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
          checkpointThreadId: string;
        };
      };
      if (sp.pendingConfirmation) {
        const { data: stillPending } = await supabase
          .from("tool_calls")
          .select("id")
          .eq("id", sp.pendingConfirmation.toolCallId)
          .eq("status", "pending_confirmation")
          .maybeSingle();
        if (stillPending) {
          initialPendingConfirmation = sp.pendingConfirmation;
        }
      }
    }
  }

  return (
    <ChatInterface
      agentName={profile.agent_name as string}
      agentAvatarUrl={agentAvatarUrl}
      agentEmoji={agentEmoji}
      userAvatarUrl={userAvatarUrl}
      userName={(profile.name as string) ?? ""}
      initialMessages={sessionMessages}
      initialToolCalls={recentToolCalls}
      initialPendingConfirmation={initialPendingConfirmation}
    />
  );
}
