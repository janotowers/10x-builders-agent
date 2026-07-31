/**
 * Paridad conversacional Web ↔ Telegram: cuando un caso tiene binding web,
 * los follow-ups operativos deben verse en el timeline del chat (no solo en
 * inbox/Telegram vía notify).
 */
import {
  addMessage,
  getConversationBindingForCase,
  getOrCreateSession,
  type DbClient,
} from "@agents/db";
import type { OperationalCaseConversationBinding } from "@agents/types";
import { WEB_HITL_MIRROR_KINDS } from "./web-hitl-client";

export type ActiveCaseInternalChannel = "web" | "telegram";

function bindingActivityMs(
  binding: OperationalCaseConversationBinding | null | undefined
): number {
  if (!binding) return Number.NEGATIVE_INFINITY;
  for (const value of [binding.last_user_message_at, binding.updated_at]) {
    if (!value) continue;
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  return Number.NEGATIVE_INFINITY;
}

export function resolveActiveCaseInternalChannel(params: {
  webBinding: OperationalCaseConversationBinding | null | undefined;
  telegramBinding: OperationalCaseConversationBinding | null | undefined;
}): ActiveCaseInternalChannel | null {
  const webMs = bindingActivityMs(params.webBinding);
  const telegramMs = bindingActivityMs(params.telegramBinding);
  if (!Number.isFinite(webMs) && !Number.isFinite(telegramMs)) return null;
  // Empate conservador: Web evita un push Telegram sorpresivo.
  return webMs >= telegramMs ? "web" : "telegram";
}

export async function getActiveCaseInternalChannel(params: {
  db: DbClient;
  caseId: string;
}): Promise<ActiveCaseInternalChannel | null> {
  const [webBinding, telegramBinding] = await Promise.all([
    getConversationBindingForCase(params.db, {
      caseId: params.caseId,
      channel: "web",
    }),
    getConversationBindingForCase(params.db, {
      caseId: params.caseId,
      channel: "telegram",
    }),
  ]);
  return resolveActiveCaseInternalChannel({ webBinding, telegramBinding });
}

export function resolveWebChatSessionIdForMirror(params: {
  bindingSessionId: string | null | undefined;
  fallbackSessionId: string | null | undefined;
}): string | null {
  const fromBinding =
    typeof params.bindingSessionId === "string" && params.bindingSessionId.trim()
      ? params.bindingSessionId.trim()
      : null;
  if (fromBinding) return fromBinding;
  const fallback =
    typeof params.fallbackSessionId === "string" && params.fallbackSessionId.trim()
      ? params.fallbackSessionId.trim()
      : null;
  return fallback;
}

export async function mirrorCaseAssistantMessageToWebChat(params: {
  db: DbClient;
  userId: string;
  caseId: string;
  text: string;
  kind?: string;
  notificationId?: string | null;
  /** Botones HITL (pueden incluir variant, notes, body, etc.). */
  actions?: Array<Record<string, unknown> & { id: string; label: string }>;
  attachments?: Array<{
    fileName: string;
    downloadUrl?: string;
    contentType?: string;
    sizeBytes?: number;
    href?: string;
    label?: string;
  }>;
}): Promise<{ mirrored: boolean; sessionId: string | null }> {
  const text = params.text.trim();
  if (!text) return { mirrored: false, sessionId: null };

  const binding = await getConversationBindingForCase(params.db, {
    caseId: params.caseId,
    channel: "web",
  });
  // Sin binding web: el caso no se está operando en chat web; no spameamos
  // la sesión web genérica (p. ej. flujo solo-Telegram).
  if (!binding) return { mirrored: false, sessionId: null };

  const fallbackSession = await getOrCreateSession(params.db, params.userId, "web");
  const sessionId = resolveWebChatSessionIdForMirror({
    bindingSessionId: binding.session_id,
    fallbackSessionId: fallbackSession.id,
  });
  if (!sessionId) return { mirrored: false, sessionId: null };

  // HITL con botones/adjunto: dedupe por kind+caso (el texto puede variar).
  if (params.kind && WEB_HITL_MIRROR_KINDS.has(params.kind)) {
    const { data: existingReview } = await params.db
      .from("agent_messages")
      .select("id")
      .eq("session_id", sessionId)
      .eq("role", "assistant")
      .eq("structured_payload->>source", "operational_case")
      .eq("structured_payload->>case_id", params.caseId)
      .eq("structured_payload->>kind", params.kind)
      .order("created_at", { ascending: false })
      .limit(1);
    if (Array.isArray(existingReview) && existingReview.length > 0) {
      return { mirrored: true, sessionId };
    }
  } else {
    const { data: existing } = await params.db
      .from("agent_messages")
      .select("id")
      .eq("session_id", sessionId)
      .eq("role", "assistant")
      .eq("content", text)
      .eq("structured_payload->>source", "operational_case")
      .eq("structured_payload->>case_id", params.caseId)
      .order("created_at", { ascending: false })
      .limit(1);
    if (Array.isArray(existing) && existing.length > 0) {
      return { mirrored: true, sessionId };
    }
  }

  await addMessage(params.db, sessionId, "assistant", text, {
    structured_payload: {
      source: "operational_case",
      kind: params.kind ?? null,
      case_id: params.caseId,
      ...(typeof params.notificationId === "string" && params.notificationId.trim()
        ? { notification_id: params.notificationId.trim() }
        : {}),
      ...(params.actions && params.actions.length > 0
        ? { actions: params.actions }
        : {}),
      ...(params.attachments && params.attachments.length > 0
        ? { attachments: params.attachments }
        : {}),
    },
  });
  return { mirrored: true, sessionId };
}
