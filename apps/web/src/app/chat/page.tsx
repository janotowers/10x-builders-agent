import { redirect } from "next/navigation";
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

  let sessionMessages: Array<{
    role: string;
    content: string;
    created_at: string;
    turn_id?: string | null;
    structured_payload?: Record<string, unknown> | null;
  }> = [];
  let recentToolCalls: RecentToolCall[] = [];
  let recentLearnings: RecentLearning[] = [];
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
      initialRecentLearnings={recentLearnings}
    />
  );
}
