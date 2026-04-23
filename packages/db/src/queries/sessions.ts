import type { DbClient } from "../client";
import type { AgentSession, Channel } from "@agents/types";

export async function createSession(
  db: DbClient,
  userId: string,
  channel: Channel
) {
  const { data, error } = await db
    .from("agent_sessions")
    .insert({
      user_id: userId,
      channel,
      status: "active",
      budget_tokens_used: 0,
      budget_tokens_limit: 100000,
    })
    .select()
    .single();
  if (error) throw error;
  return data as AgentSession;
}

export async function getActiveSession(
  db: DbClient,
  userId: string,
  channel: Channel
) {
  const { data } = await db
    .from("agent_sessions")
    .select("*")
    .eq("user_id", userId)
    .eq("channel", channel)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .single();
  return data as AgentSession | null;
}

export async function getOrCreateSession(
  db: DbClient,
  userId: string,
  channel: Channel
) {
  const existing = await getActiveSession(db, userId, channel);
  if (existing) return existing;
  return createSession(db, userId, channel);
}

export async function updateSessionTokens(
  db: DbClient,
  sessionId: string,
  tokensUsed: number
) {
  const { error } = await db
    .from("agent_sessions")
    .update({
      budget_tokens_used: tokensUsed,
      updated_at: new Date().toISOString(),
    })
    .eq("id", sessionId);
  if (error) throw error;
}

// ============================================================
// Long-term memory — watermark state on `agent_sessions`.
// Columnas añadidas en la migración 00005_memories.sql.
// ============================================================

export interface SessionFlushState {
  /** ISO timestamp del último flush que avanzó la marca (o null si nunca). */
  lastFlushedAt: string | null;
  /** Id del último agent_message procesado por un flush (o null). */
  lastFlushedMessageId: string | null;
  /** ISO timestamp del último agent_message insertado en esta sesión. */
  lastMessageAt: string | null;
  /**
   * Embedding del `HumanMessage` del turno anterior. Lo persiste el nodo de
   * inyección y lo lee el helper de trigger para detectar topic-shift sin
   * recomputar embeddings.
   */
  lastUserInputEmbedding: number[] | null;
  /** Canal de la sesión (web/telegram/cron). */
  channel: "web" | "telegram" | "cron";
}

export async function getFlushState(
  db: DbClient,
  sessionId: string
): Promise<SessionFlushState | null> {
  const { data, error } = await db
    .from("agent_sessions")
    .select(
      "last_flushed_at, last_flushed_message_id, last_message_at, last_user_input_embedding, channel"
    )
    .eq("id", sessionId)
    .single();
  if (error) {
    if (error.code === "PGRST116") return null; // no rows
    throw error;
  }
  if (!data) return null;
  return {
    lastFlushedAt: (data.last_flushed_at as string | null) ?? null,
    lastFlushedMessageId:
      (data.last_flushed_message_id as string | null) ?? null,
    lastMessageAt: (data.last_message_at as string | null) ?? null,
    lastUserInputEmbedding:
      (data.last_user_input_embedding as number[] | null) ?? null,
    channel: data.channel as SessionFlushState["channel"],
  };
}

export async function updateFlushWatermark(
  db: DbClient,
  sessionId: string,
  input: { lastFlushedAt: string; lastFlushedMessageId: string | null }
): Promise<void> {
  const { error } = await db
    .from("agent_sessions")
    .update({
      last_flushed_at: input.lastFlushedAt,
      last_flushed_message_id: input.lastFlushedMessageId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", sessionId);
  if (error) throw error;
}

export async function updateLastUserInputEmbedding(
  db: DbClient,
  sessionId: string,
  embedding: number[]
): Promise<void> {
  const { error } = await db
    .from("agent_sessions")
    .update({
      last_user_input_embedding: embedding,
      updated_at: new Date().toISOString(),
    })
    .eq("id", sessionId);
  if (error) throw error;
}

/**
 * Busca la sesión más reciente (web o telegram) con mensajes sin flushear
 * para el usuario dado, excluyendo la sesión actual. Sirve para el "catch-up
 * por cambio de canal": si el usuario alterna Web ↔ Telegram, el helper de
 * trigger dispara un flush en la otra sesión antes de que el nuevo turno
 * arranque, para que la inyección vea memoria fresca.
 */
export async function findStaleSiblingSession(
  db: DbClient,
  userId: string,
  excludeSessionId: string
): Promise<{
  id: string;
  channel: "web" | "telegram" | "cron";
  lastFlushedAt: string | null;
  lastMessageAt: string | null;
} | null> {
  const { data, error } = await db
    .from("agent_sessions")
    .select("id, channel, last_flushed_at, last_message_at, status")
    .eq("user_id", userId)
    .neq("id", excludeSessionId)
    .in("channel", ["web", "telegram"])
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(5);
  if (error) throw error;
  for (const row of data ?? []) {
    const lastMsg = row.last_message_at as string | null;
    const lastFlush = row.last_flushed_at as string | null;
    if (!lastMsg) continue;
    // Solo nos interesa si hay mensajes posteriores al último flush.
    if (!lastFlush || new Date(lastMsg) > new Date(lastFlush)) {
      return {
        id: row.id as string,
        channel: row.channel as "web" | "telegram" | "cron",
        lastFlushedAt: lastFlush,
        lastMessageAt: lastMsg,
      };
    }
  }
  return null;
}
