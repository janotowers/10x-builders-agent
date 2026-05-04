import type { DbClient } from "../client";
import type { AgentMessage, MessageRole } from "@agents/types";

export async function addMessage(
  db: DbClient,
  sessionId: string,
  role: MessageRole,
  content: string,
  extra?: {
    tool_call_id?: string;
    structured_payload?: Record<string, unknown>;
    turn_id?: string | null;
  }
) {
  const { data, error } = await db
    .from("agent_messages")
    .insert({ session_id: sessionId, role, content, ...extra })
    .select()
    .single();
  if (error) throw error;
  return data as AgentMessage;
}

export async function getSessionMessages(
  db: DbClient,
  sessionId: string,
  limit = 50
) {
  const { data, error } = await db
    .from("agent_messages")
    .select("*")
    .eq("session_id", sessionId)
    // Fetch the most recent rows first; applying `limit` to ascending order
    // would return the oldest messages and lose the immediate conversation
    // context ("and in March" after "leads in April").
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as AgentMessage[]).reverse();
}
