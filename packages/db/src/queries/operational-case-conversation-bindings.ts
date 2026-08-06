import type { DbClient } from "../client";
import type {
  OperationalCaseConversationBinding,
  OperationalCaseConversationBindingStatus,
} from "@agents/types";

export interface UpsertConversationBindingInput {
  userId: string;
  caseId: string;
  caseType: string;
  channel: "telegram" | "web";
  chatId?: number | null;
  sessionId?: string | null;
  status?: OperationalCaseConversationBindingStatus;
  awaitingFields?: unknown[];
  lastAgentPrompt?: string | null;
  pendingMessage?: Record<string, unknown>;
  candidateRoutes?: Array<Record<string, unknown>>;
  metadata?: Record<string, unknown>;
  expiresAt?: string | null;
}

export async function upsertConversationBinding(
  db: DbClient,
  input: UpsertConversationBindingInput
): Promise<OperationalCaseConversationBinding> {
  const now = new Date().toISOString();
  const activeStatuses: OperationalCaseConversationBindingStatus[] = [
    "awaiting_user",
    "clarification_needed",
  ];
  const { data: existing, error: existingError } = await db
    .from("operational_case_conversation_bindings")
    .select("*")
    .eq("case_id", input.caseId)
    .eq("channel", input.channel)
    .in("status", activeStatuses)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existingError) throw existingError;

  const payload = {
    user_id: input.userId,
    case_id: input.caseId,
    case_type: input.caseType,
    channel: input.channel,
    chat_id: input.chatId ?? null,
    session_id: input.sessionId ?? null,
    status: input.status ?? "awaiting_user",
    awaiting_fields_jsonb: input.awaitingFields ?? [],
    last_agent_prompt: input.lastAgentPrompt ?? null,
    pending_message_jsonb: input.pendingMessage ?? {},
    candidate_routes_jsonb: input.candidateRoutes ?? [],
    metadata_jsonb: input.metadata ?? {},
    expires_at: input.expiresAt ?? null,
    updated_at: now,
  };

  if (existing) {
    const { data, error } = await db
      .from("operational_case_conversation_bindings")
      .update(payload)
      .eq("id", (existing as OperationalCaseConversationBinding).id)
      .select("*")
      .single();
    if (error) throw error;
    return data as OperationalCaseConversationBinding;
  }

  const { data, error } = await db
    .from("operational_case_conversation_bindings")
    .insert({
      ...payload,
      created_at: now,
    })
    .select("*")
    .single();
  if (error) throw error;
  return data as OperationalCaseConversationBinding;
}

export async function findPendingConversationBindings(
  db: DbClient,
  params: {
    userId: string;
    channel: "telegram" | "web";
    chatId?: number | null;
    statuses?: OperationalCaseConversationBindingStatus[];
    limit?: number;
  }
): Promise<OperationalCaseConversationBinding[]> {
  const statuses = params.statuses ?? ["awaiting_user", "clarification_needed"];
  // Default 30 (antes 10): bindings de casos terminados aún no expirados
  // pueden llenar una ventana chica y expulsar a los de casos vivos; la
  // expiración perezosa vive en resolveRoutableConversationBindings.
  let query = db
    .from("operational_case_conversation_bindings")
    .select("*")
    .eq("user_id", params.userId)
    .eq("channel", params.channel)
    .in("status", statuses)
    .order("updated_at", { ascending: false })
    .limit(Math.max(1, Math.min(params.limit ?? 30, 100)));
  if (params.chatId !== undefined && params.chatId !== null) {
    query = query.eq("chat_id", params.chatId);
  }
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as OperationalCaseConversationBinding[];
}

export async function getConversationBindingById(
  db: DbClient,
  bindingId: string
): Promise<OperationalCaseConversationBinding | null> {
  const { data, error } = await db
    .from("operational_case_conversation_bindings")
    .select("*")
    .eq("id", bindingId)
    .maybeSingle();
  if (error) throw error;
  return (data as OperationalCaseConversationBinding | null) ?? null;
}

export async function getConversationBindingForCase(
  db: DbClient,
  params: {
    caseId: string;
    channel?: "telegram" | "web";
    statuses?: OperationalCaseConversationBindingStatus[];
  }
): Promise<OperationalCaseConversationBinding | null> {
  let query = db
    .from("operational_case_conversation_bindings")
    .select("*")
    .eq("case_id", params.caseId)
    .order("updated_at", { ascending: false })
    .limit(1);
  if (params.channel) {
    query = query.eq("channel", params.channel);
  }
  if (params.statuses && params.statuses.length > 0) {
    query = query.in("status", params.statuses);
  }
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return (data as OperationalCaseConversationBinding | null) ?? null;
}

/** Marca el canal/sesión que recibió el último turno sin borrar su envelope. */
export async function touchConversationBindingForCase(
  db: DbClient,
  params: {
    caseId: string;
    channel: "telegram" | "web";
    sessionId?: string | null;
    lastUserMessageAt?: string;
  }
): Promise<void> {
  const binding = await getConversationBindingForCase(db, {
    caseId: params.caseId,
    channel: params.channel,
    statuses: ["awaiting_user", "clarification_needed"],
  });
  if (!binding) return;
  const now = params.lastUserMessageAt ?? new Date().toISOString();
  const patch: Record<string, unknown> = {
    updated_at: now,
    last_user_message_at: now,
  };
  if (params.sessionId !== undefined) {
    patch.session_id = params.sessionId;
  }
  const { error } = await db
    .from("operational_case_conversation_bindings")
    .update(patch)
    .eq("id", binding.id);
  if (error) throw error;
}

export async function setConversationBindingStatus(
  db: DbClient,
  params: {
    bindingId: string;
    status: OperationalCaseConversationBindingStatus;
    pendingMessage?: Record<string, unknown>;
    candidateRoutes?: Array<Record<string, unknown>>;
    metadataMerge?: Record<string, unknown>;
    lastUserMessageAt?: string | null;
  }
): Promise<OperationalCaseConversationBinding | null> {
  const patch: Record<string, unknown> = {
    status: params.status,
    updated_at: new Date().toISOString(),
  };
  if (params.pendingMessage !== undefined) {
    patch.pending_message_jsonb = params.pendingMessage;
  }
  if (params.candidateRoutes !== undefined) {
    patch.candidate_routes_jsonb = params.candidateRoutes;
  }
  if (params.lastUserMessageAt !== undefined) {
    patch.last_user_message_at = params.lastUserMessageAt;
  }
  if (params.metadataMerge) {
    const { data: current, error: currentError } = await db
      .from("operational_case_conversation_bindings")
      .select("metadata_jsonb")
      .eq("id", params.bindingId)
      .maybeSingle();
    if (currentError) throw currentError;
    patch.metadata_jsonb = {
      ...((current?.metadata_jsonb as Record<string, unknown>) ?? {}),
      ...params.metadataMerge,
    };
  }
  const { data, error } = await db
    .from("operational_case_conversation_bindings")
    .update(patch)
    .eq("id", params.bindingId)
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return (data as OperationalCaseConversationBinding | null) ?? null;
}

export function shortOperationalCaseId(caseId: string): string {
  if (!caseId) return "";
  return caseId.length <= 8 ? caseId : `…${caseId.slice(-8)}`;
}
