"use client";

import { useState, useRef, useLayoutEffect, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import {
  formatSkillForUserPanel,
  formatSkillRole,
  type AppliedSkillDisplay,
} from "@/lib/skill-display";
import { formatToolForUserPanel } from "@/lib/tool-display";

interface Message {
  role: string;
  content: string;
  created_at?: string;
  turn_id?: string | null;
  structured_payload?: Record<string, unknown> | null;
}

interface PendingConfirmation {
  toolCallId: string;
  toolName: string;
  message: string;
  args: Record<string, unknown>;
  turnId?: string | null;
  appliedSkills?: AppliedSkillDisplay[];
}

interface RecentToolCall {
  id: string;
  turn_id?: string | null;
  tool_name: string;
  status: string;
  requires_confirmation: boolean;
  created_at: string;
  finished_at?: string | null;
}

interface Props {
  agentName: string;
  agentAvatarUrl?: string;
  agentEmoji?: string;
  userAvatarUrl?: string;
  userName?: string;
  initialMessages: Message[];
  initialToolCalls?: RecentToolCall[];
  initialPendingConfirmation?: PendingConfirmation | null;
}

function ChatAvatar({
  imageUrl,
  fallback,
  label,
  tone,
}: {
  imageUrl?: string;
  fallback: string;
  label: string;
  tone: "agent" | "user";
}) {
  return (
    <div
      className={`mt-1 flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full text-xs font-bold ${
        tone === "agent"
          ? "bg-violet-700 text-white shadow-sm shadow-violet-900/20"
          : "bg-white/80 text-neutral-700 ring-1 ring-neutral-200 dark:bg-white/10 dark:text-neutral-100 dark:ring-white/10"
      }`}
      title={label}
    >
      {imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={imageUrl} alt={label} className="h-full w-full object-cover" />
      ) : (
        fallback
      )}
    </div>
  );
}

function formatConfirmFailureMessage(result: Record<string, unknown> | undefined): string {
  if (!result) return "Error desconocido";
  const base = typeof result.error === "string" ? result.error : "Error";
  const details = result.details;
  if (details && typeof details === "object") {
    const d = details as Record<string, unknown>;
    if (typeof d.message === "string") {
      return `${base}: ${d.message}`;
    }
  }
  if (typeof result.status === "number") {
    return `${base} (HTTP ${result.status})`;
  }
  return base;
}

function formatToolStatus(status: string): string {
  const labels: Record<string, string> = {
    pending_confirmation: "requiere aprobación",
    approved: "aprobada",
    rejected: "rechazada",
    executed: "ejecutada",
    failed: "falló",
  };
  return labels[status] ?? status;
}

function toolStatusClass(status: string): string {
  if (status === "executed") return "bg-emerald-500";
  if (status === "failed" || status === "rejected") return "bg-red-500";
  if (status === "pending_confirmation") return "bg-amber-500";
  return "bg-violet-500";
}

function formatToolTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("es-MX", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function parseAppliedSkills(value: unknown): AppliedSkillDisplay[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const row = item as Record<string, unknown>;
      if (typeof row.id !== "string" || row.id.length === 0) return null;
      return {
        id: row.id,
        role: row.role === "included" ? "included" : "primary",
      } satisfies AppliedSkillDisplay;
    })
    .filter((item): item is AppliedSkillDisplay => Boolean(item));
}

function appliedSkillsFromMessage(message: Message | undefined): AppliedSkillDisplay[] {
  const payload = message?.structured_payload;
  if (!payload) return [];
  const explicit = parseAppliedSkills(payload.appliedSkills);
  if (explicit.length > 0) return explicit;
  return typeof payload.activeSkill === "string"
    ? [{ id: payload.activeSkill, role: "primary" }]
    : [];
}

function skillsForLastCompletedTurn(
  msgs: Message[],
  preferredTurnId?: string | null,
  preferredSkills?: AppliedSkillDisplay[]
): AppliedSkillDisplay[] {
  if (preferredSkills && preferredSkills.length > 0) return preferredSkills;
  if (preferredTurnId) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]?.turn_id !== preferredTurnId) continue;
      return appliedSkillsFromMessage(msgs[i]);
    }
  }

  for (let i = msgs.length - 1; i >= 0; i--) {
    const role = msgs[i]?.role;
    if (role !== "assistant" && role !== "user") continue;
    return appliedSkillsFromMessage(msgs[i]);
  }
  return [];
}

/** Prefer persisted turn correlation; timestamp matching only supports old rows.
 */
function toolsForLastCompletedTurn(
  msgs: Message[],
  calls: RecentToolCall[],
  preferredTurnId?: string | null
): RecentToolCall[] {
  const sortByCreatedAt = (rows: RecentToolCall[]): RecentToolCall[] =>
    [...rows].sort((a, b) => {
      const ta = new Date(a.created_at).getTime();
      const tb = new Date(b.created_at).getTime();
      return ta - tb;
    });

  if (preferredTurnId) {
    return sortByCreatedAt(calls.filter((c) => c.turn_id === preferredTurnId));
  }

  // Anchor to the most recent user message: that is the turn currently in
  // focus. If it carries `turn_id`, filter strictly by it; this also lets
  // us return [] (i.e. clear the panel) the moment a new user message is
  // sent before any tools have been recorded for it.
  let lastUserIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]?.role === "user") {
      lastUserIdx = i;
      break;
    }
  }

  const lastUserTurnId = lastUserIdx >= 0 ? msgs[lastUserIdx]?.turn_id : null;
  if (lastUserTurnId) {
    return sortByCreatedAt(calls.filter((c) => c.turn_id === lastUserTurnId));
  }

  let lastAssistantIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]?.role === "assistant") {
      lastAssistantIdx = i;
      break;
    }
  }
  if (lastUserIdx < 0 || lastAssistantIdx < 0 || calls.length === 0) return [];

  const turnId = msgs[lastAssistantIdx]?.turn_id;
  if (turnId) {
    return sortByCreatedAt(calls.filter((c) => c.turn_id === turnId));
  }

  const userTs = msgs[lastUserIdx]?.created_at;
  const assistantTs = msgs[lastAssistantIdx]?.created_at;
  if (!userTs || !assistantTs) return [];

  const userMs = new Date(userTs).getTime();
  const assistantMs = new Date(assistantTs).getTime();
  if (Number.isNaN(userMs) || Number.isNaN(assistantMs)) return [];

  const skewMs = 5 * 60 * 1000;
  const windowStartMs = userMs - skewMs;
  const windowEndMs = Math.max(userMs, assistantMs) + skewMs;

  const matches = calls.filter((c) => {
    const t = new Date(c.created_at).getTime();
    if (Number.isNaN(t)) return false;
    return t >= windowStartMs && t <= windowEndMs;
  });

  return sortByCreatedAt(matches);
}

function mergeToolCalls(
  prev: RecentToolCall[],
  additions: RecentToolCall[],
  maxTotal = 80
): RecentToolCall[] {
  const fuzzyMatchMs = 2500;
  const seenIds = new Set<string>();
  const out: RecentToolCall[] = [];

  const push = (row: RecentToolCall) => {
    const key = row.id.startsWith("turn-")
      ? `${row.tool_name}:${row.created_at}`
      : row.id;
    if (seenIds.has(key)) return;
    seenIds.add(key);
    out.push(row);
  };

  const stripOptimisticDuplicate = (serverRow: RecentToolCall) => {
    const tServer = new Date(serverRow.created_at).getTime();
    if (Number.isNaN(tServer)) return;
    for (let i = out.length - 1; i >= 0; i--) {
      const row = out[i]!;
      if (!row.id.startsWith("turn-")) continue;
      if (row.tool_name !== serverRow.tool_name) continue;
      const tOpt = new Date(row.created_at).getTime();
      if (Number.isNaN(tOpt)) continue;
      if (Math.abs(tServer - tOpt) <= fuzzyMatchMs) {
        out.splice(i, 1);
        const optKey = `${row.tool_name}:${row.created_at}`;
        seenIds.delete(optKey);
        break;
      }
    }
  };

  for (const row of additions) {
    stripOptimisticDuplicate(row);
    push(row);
  }
  for (const row of prev) push(row);
  return out.slice(0, maxTotal);
}

function createClientTurnId(): string {
  return crypto.randomUUID();
}

export function ChatInterface({
  agentName,
  agentAvatarUrl,
  agentEmoji,
  userAvatarUrl,
  userName,
  initialMessages,
  initialToolCalls = [],
  initialPendingConfirmation = null,
}: Props) {
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [toolCalls, setToolCalls] = useState<RecentToolCall[]>(initialToolCalls);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [confirmation, setConfirmation] = useState<PendingConfirmation | null>(
    initialPendingConfirmation
  );
  const [confirming, setConfirming] = useState(false);
  const messagesViewportRef = useRef<HTMLDivElement>(null);
  const didInitialScrollRef = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const agentInitial =
    agentEmoji || agentName.slice(0, 1).toUpperCase() || "G";
  const agentStatus = confirmation
    ? "Esperando aprobación"
    : loading
      ? "Trabajando"
      : "En línea";
  const agentStatusDescription = confirmation
    ? "Gu necesita tu autorización para continuar con una acción."
    : loading
      ? "Gu está procesando tu solicitud y preparando la siguiente respuesta."
      : "Listo para recibir nuevas peticiones y ejecutar tareas con contexto.";

  const toolsThisTurn = useMemo(
    () => toolsForLastCompletedTurn(messages, toolCalls, confirmation?.turnId),
    [messages, toolCalls, confirmation?.turnId]
  );
  const skillsThisTurn = useMemo(
    () =>
      skillsForLastCompletedTurn(
        messages,
        confirmation?.turnId,
        confirmation?.appliedSkills
      ),
    [messages, confirmation?.turnId, confirmation?.appliedSkills]
  );

  useLayoutEffect(() => {
    const viewport = messagesViewportRef.current;
    if (!viewport) return;
    viewport.scrollTo({
      top: viewport.scrollHeight,
      behavior: didInitialScrollRef.current ? "smooth" : "auto",
    });
    didInitialScrollRef.current = true;
  }, [messages.length, confirmation?.toolCallId, loading]);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || loading) return;
    const clientTurnId = createClientTurnId();

    const userMsg: Message = {
      role: "user",
      content: text,
      created_at: new Date().toISOString(),
      turn_id: clientTurnId,
      structured_payload: { appliedSkills: [] },
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, turnId: clientTurnId }),
      });

      const data = (await res.json()) as {
        response?: string | null;
        turnId?: string;
        appliedSkills?: AppliedSkillDisplay[];
        pendingConfirmation?: PendingConfirmation | null;
        toolCalls?: string[];
        error?: string;
      };

      if (!res.ok) {
        const errText =
          typeof data.error === "string"
            ? data.error
            : `Error HTTP ${res.status}`;
        const errIso = new Date().toISOString();
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant" as const,
            content: `Error: ${errText}`,
            created_at: errIso,
            turn_id: data.turnId ?? clientTurnId,
            structured_payload: { appliedSkills: data.appliedSkills ?? [] },
          },
        ]);
        return;
      }

      if (data.pendingConfirmation) {
        setConfirmation(data.pendingConfirmation);
      }

      const assistantIso = new Date().toISOString();

      // Usar typeof === 'string' (no truthiness): null/undefined no son respuesta; "" sí debe mostrarse.
      const assistantText = data.response;
      if (typeof assistantText === "string") {
        const content =
          assistantText.length > 0
            ? assistantText
            : "Respuesta vacía del asistente. Si esperabas una tarjeta de confirmación, revisa debajo del chat.";
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant" as const,
            content,
            created_at: assistantIso,
            turn_id: data.turnId ?? clientTurnId,
            structured_payload: { appliedSkills: data.appliedSkills ?? [] },
          },
        ]);
      } else if (!data.pendingConfirmation) {
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant" as const,
            content:
              "Respuesta incompleta del servidor (sin texto). Recarga la página o revisa la consola del servidor.",
            created_at: assistantIso,
            turn_id: data.turnId ?? clientTurnId,
            structured_payload: { appliedSkills: data.appliedSkills ?? [] },
          },
        ]);
      }

      if (Array.isArray(data.toolCalls) && data.toolCalls.length > 0) {
        const optimistic = data.toolCalls.map((name, index) => ({
          id: `turn-${assistantIso}-${index}-${name}`,
          turn_id: data.turnId ?? clientTurnId,
          tool_name: name,
          status: "executed",
          requires_confirmation: false,
          created_at: assistantIso,
          finished_at: assistantIso,
        }));
        setToolCalls((prev) => mergeToolCalls(prev, optimistic));
      }
    } catch {
      const errIso = new Date().toISOString();
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: "Error al procesar tu mensaje. Intenta de nuevo.",
          created_at: errIso,
          turn_id: clientTurnId,
          structured_payload: { appliedSkills: [] },
        },
      ]);
    } finally {
      setLoading(false);
    }
  }

  async function handleConfirm(action: "approve" | "reject") {
    if (!confirmation) return;
    setConfirming(true);
    let keepPending: PendingConfirmation | null = null;

    try {
      const res = await fetch("/api/chat/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          toolCallId: confirmation.toolCallId,
          action,
        }),
      });

      const data = (await res.json()) as {
        ok?: boolean;
        response?: string | null;
        turnId?: string;
        appliedSkills?: AppliedSkillDisplay[];
        pendingConfirmation?: PendingConfirmation | null;
        toolCalls?: string[];
        error?: string;
      };

      const assistantIso = new Date().toISOString();

      const responseText =
        typeof data.response === "string" ? data.response : null;
      if (data.ok && responseText && responseText.length > 0) {
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: responseText,
            created_at: assistantIso,
            turn_id: data.turnId ?? confirmation.turnId ?? null,
            structured_payload: {
              appliedSkills:
                data.appliedSkills ?? confirmation.appliedSkills ?? [],
            },
          },
        ]);
      }

      if (data.pendingConfirmation) {
        keepPending = data.pendingConfirmation as PendingConfirmation;
      }

      if (!data.ok) {
        const msg =
          typeof data.error === "string"
            ? data.error
            : formatConfirmFailureMessage(undefined);
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: `Error al ejecutar: ${msg}`,
            created_at: assistantIso,
            turn_id: data.turnId ?? confirmation.turnId ?? null,
            structured_payload: {
              appliedSkills:
                data.appliedSkills ?? confirmation.appliedSkills ?? [],
            },
          },
        ]);
      } else if (action === "reject" && !data.response) {
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: "Acción cancelada.",
            created_at: assistantIso,
            turn_id: data.turnId ?? confirmation.turnId ?? null,
            structured_payload: {
              appliedSkills:
                data.appliedSkills ?? confirmation.appliedSkills ?? [],
            },
          },
        ]);
      }

      if (Array.isArray(data.toolCalls) && data.toolCalls.length > 0) {
        const turnId = data.turnId ?? confirmation.turnId ?? null;
        const optimistic = data.toolCalls.map((name, index) => ({
          id: `turn-${assistantIso}-${index}-${name}`,
          turn_id: turnId,
          tool_name: name,
          status: "executed",
          requires_confirmation: false,
          created_at: assistantIso,
          finished_at: assistantIso,
        }));
        setToolCalls((prev) => mergeToolCalls(prev, optimistic));
      }
    } catch {
      const errIso = new Date().toISOString();
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: "Error al procesar la confirmación.",
          created_at: errIso,
        },
      ]);
    } finally {
      setConfirmation(keepPending);
      setConfirming(false);
    }
  }

  return (
    <div className="h-screen overflow-hidden bg-[#f8f4ff] text-slate-950 dark:bg-[#090411] dark:text-white">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -left-32 top-16 h-72 w-72 rounded-full bg-violet-500/20 blur-3xl" />
        <div className="absolute right-0 top-0 h-96 w-96 rounded-full bg-fuchsia-500/20 blur-3xl" />
      </div>

      <div className="relative flex h-full">
        <main className="flex min-h-0 min-w-0 flex-1 flex-col px-3 py-3 sm:px-5 sm:py-5">
          <header className="mb-4 flex items-center justify-between gap-3 rounded-[2rem] border border-white/70 bg-white/70 px-4 py-3 shadow-sm backdrop-blur-xl dark:border-white/10 dark:bg-white/5">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex h-12 w-20 shrink-0 items-center justify-center rounded-2xl border border-violet-100 bg-white px-3 shadow-sm dark:border-white/10 dark:bg-white/90">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="/ungga-logo.png"
                  alt="Logo de la cuenta"
                  className="max-h-9 w-full object-contain"
                />
              </div>
              <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-gradient-to-br from-violet-700 to-fuchsia-600 text-sm font-bold text-white shadow-lg shadow-violet-900/20">
                {agentAvatarUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={agentAvatarUrl} alt="Avatar del colaborador IA" className="h-full w-full object-cover" />
                ) : (
                  agentInitial
                )}
              </div>
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-[0.28em] text-violet-700 dark:text-violet-200">
                  Consola Ungga
                </p>
                <h1 className="truncate text-lg font-semibold text-slate-950 dark:text-white">
                  {agentName}
                </h1>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="hidden rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700 dark:border-emerald-400/20 dark:bg-emerald-400/10 dark:text-emerald-200 sm:inline-flex">
                {agentStatus}
              </span>
              <a
                href="/memory"
                className="hidden rounded-full border border-slate-200 bg-white/70 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-white dark:border-white/10 dark:bg-white/5 dark:text-white/70 dark:hover:bg-white/10 sm:inline-flex"
              >
                Memoria
              </a>
              <a
                href="/settings"
                className="rounded-full border border-slate-200 bg-white/70 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-white dark:border-white/10 dark:bg-white/5 dark:text-white/70 dark:hover:bg-white/10"
              >
                Ajustes
              </a>
              <form action="/api/auth/signout" method="POST">
                <button
                  type="submit"
                  className="rounded-full border border-slate-200 bg-white/70 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-white dark:border-white/10 dark:bg-white/5 dark:text-white/70 dark:hover:bg-white/10"
                >
                  Salir
                </button>
              </form>
            </div>
          </header>

          <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 xl:grid-cols-[minmax(0,0.95fr)_460px] 2xl:grid-cols-[minmax(0,0.9fr)_520px]">
            <section className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[2rem] border border-white/70 bg-white/75 shadow-xl shadow-violet-950/5 backdrop-blur-xl dark:border-white/10 dark:bg-white/[0.06]">
              <div className="border-b border-slate-200/70 px-5 py-4 dark:border-white/10">
                <p className="text-sm font-semibold text-slate-900 dark:text-white">
                  Conversación
                </p>
                <p className="text-xs text-slate-500 dark:text-white/50">
                  Apóyate en Gu, tu colaborador digital.
                </p>
              </div>

              {/* Messages */}
              <div ref={messagesViewportRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-6">
                <div className="mx-auto max-w-2xl space-y-4">
          {messages.length === 0 && (
            <div className="mx-auto max-w-md rounded-3xl border border-violet-100 bg-violet-50/80 px-6 py-10 text-center text-sm text-slate-500 dark:border-white/10 dark:bg-white/5 dark:text-white/60">
              <p className="text-lg font-semibold text-slate-900 dark:text-white">
                Hola, soy {agentName}
              </p>
              <p className="mt-2">Estoy listo para ayudarte a organizar, decidir y ejecutar tareas.</p>
            </div>
          )}
          {messages.map((msg, i) => (
            <div
              key={i}
              className={`flex items-start gap-2 ${msg.role === "user" ? "justify-end" : "justify-start"}`}
            >
              {msg.role !== "user" && (
                <ChatAvatar
                  imageUrl={agentAvatarUrl}
                  fallback={agentInitial}
                  label={`Avatar de ${agentName}`}
                  tone="agent"
                />
              )}
              <div
                className={`max-w-[82%] rounded-3xl px-4 py-3 text-sm leading-relaxed shadow-sm ${
                  msg.role === "user"
                    ? "bg-gradient-to-br from-violet-700 to-fuchsia-600 text-white shadow-violet-900/20"
                    : "border border-slate-200/70 bg-white text-slate-900 dark:border-white/10 dark:bg-white/10 dark:text-white"
                }`}
              >
                {msg.role === "assistant" ? (
                  <div className="prose prose-sm max-w-none prose-p:my-1 prose-li:my-0.5 prose-ol:my-1 prose-ul:my-1 prose-a:text-violet-700 prose-a:underline dark:prose-invert dark:prose-a:text-violet-200">
                    <ReactMarkdown
                      components={{
                        a: ({ href, children }) => (
                          <a href={href} target="_blank" rel="noopener noreferrer">
                            {children}
                          </a>
                        ),
                      }}
                    >
                      {msg.content}
                    </ReactMarkdown>
                  </div>
                ) : (
                  <p className="whitespace-pre-wrap">{msg.content}</p>
                )}
              </div>
              {msg.role === "user" && (
                <ChatAvatar
                  imageUrl={userAvatarUrl}
                  fallback={(userName || "U").slice(0, 1).toUpperCase()}
                  label="Avatar del usuario"
                  tone="user"
                />
              )}
            </div>
          ))}

          {/* Confirmation prompt */}
          {confirmation && (
            <div className="flex items-start justify-start gap-2">
              <ChatAvatar
                imageUrl={agentAvatarUrl}
                fallback={agentInitial}
                label={`Avatar de ${agentName}`}
                tone="agent"
              />
              <div className="max-w-[82%] rounded-3xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm shadow-sm dark:border-amber-400/20 dark:bg-amber-400/10">
                <p className="mb-3 text-slate-900 dark:text-white">
                  {confirmation.message}
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => handleConfirm("approve")}
                    disabled={confirming}
                    className="rounded-full bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                  >
                    {confirming ? "Ejecutando..." : "Aprobar"}
                  </button>
                  <button
                    onClick={() => handleConfirm("reject")}
                    disabled={confirming}
                    className="rounded-full border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-400/30 dark:text-red-200 dark:hover:bg-red-400/10"
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            </div>
          )}

          {loading && (
            <div className="flex items-start justify-start gap-2">
              <ChatAvatar
                imageUrl={agentAvatarUrl}
                fallback={agentInitial}
                label={`Avatar de ${agentName}`}
                tone="agent"
              />
              <div className="rounded-3xl border border-slate-200/70 bg-white px-4 py-3 text-sm shadow-sm dark:border-white/10 dark:bg-white/10">
                <span className="animate-pulse">Pensando...</span>
              </div>
            </div>
          )}
          <div ref={bottomRef} />
                </div>
              </div>

              {/* Input */}
              <div className="border-t border-slate-200/70 bg-white/80 px-4 py-4 dark:border-white/10 dark:bg-white/[0.03]">
                <form onSubmit={handleSend} className="mx-auto flex max-w-2xl items-center gap-2 rounded-2xl border border-slate-200 bg-white p-2 shadow-sm dark:border-white/10 dark:bg-white/10">
                  <button
                    type="button"
                    aria-label="Adjuntar archivo"
                    title="Adjuntar archivo"
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-slate-500 hover:bg-violet-50 hover:text-violet-700 dark:text-white/60 dark:hover:bg-white/10 dark:hover:text-white"
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="h-5 w-5"
                      aria-hidden="true"
                    >
                      <path d="M21.44 11.05 12.25 20.24a6 6 0 1 1-8.49-8.49l9.19-9.19a4 4 0 1 1 5.66 5.66l-9.2 9.19a2 2 0 1 1-2.83-2.83l8.49-8.48" />
                    </svg>
                  </button>
                  <input
                    type="text"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder={confirmation ? "Resuelve la confirmación para continuar..." : "Dile a Gu qué necesitas..."}
                    disabled={loading || !!confirmation}
                    className="min-w-0 flex-1 bg-transparent px-3 py-2 text-sm text-slate-900 outline-none placeholder:text-slate-400 disabled:opacity-50 dark:text-white dark:placeholder:text-white/40"
                  />
                  <button
                    type="button"
                    aria-label="Mensaje de voz"
                    title="Mensaje de voz"
                    className="hidden h-10 w-10 shrink-0 items-center justify-center rounded-xl text-violet-700 hover:bg-violet-50 dark:text-violet-200 dark:hover:bg-white/10 sm:flex"
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="h-5 w-5"
                      aria-hidden="true"
                    >
                      <rect x="9" y="3" width="6" height="11" rx="3" />
                      <path d="M5 11a7 7 0 0 0 14 0" />
                      <line x1="12" y1="18" x2="12" y2="22" />
                      <line x1="8" y1="22" x2="16" y2="22" />
                    </svg>
                  </button>
                  <button
                    type="submit"
                    aria-label="Enviar mensaje"
                    title="Enviar"
                    disabled={loading || !input.trim() || !!confirmation}
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-violet-700 to-fuchsia-600 text-white shadow-lg shadow-violet-900/20 transition hover:from-violet-800 hover:to-fuchsia-700 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="h-5 w-5"
                      aria-hidden="true"
                    >
                      <path d="m4 12 16-8-6 18-3-7-7-3z" />
                    </svg>
                  </button>
                </form>
              </div>
            </section>

            <aside className="hidden min-h-0 flex-col gap-4 overflow-y-auto pr-1 xl:flex">
              <section className="rounded-[2rem] border border-white/70 bg-[#32107a] p-5 text-white shadow-xl shadow-violet-950/10 dark:border-white/10">
                <div className="flex items-center gap-4">
                  <div className="flex h-24 w-24 shrink-0 items-center justify-center overflow-hidden rounded-[1.75rem] bg-white/10 ring-1 ring-white/20">
                    {agentAvatarUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={agentAvatarUrl} alt="Avatar de Gu" className="h-full w-full object-cover" />
                    ) : (
                      <span className="text-4xl font-black">{agentInitial}</span>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-3">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-violet-100">
                        Colaborador en acción
                      </p>
                      <span className="shrink-0 rounded-full bg-white/15 px-3 py-1 text-xs font-semibold">
                        {agentStatus}
                      </span>
                    </div>
                    <h2 className="mt-2 truncate text-xl font-bold">{agentName}</h2>
                    <p className="mt-1 line-clamp-2 text-sm leading-5 text-violet-100">
                      {agentStatusDescription}
                    </p>
                  </div>
                </div>
                <div className="mt-4 grid grid-cols-3 rounded-2xl bg-white/10 text-center text-xs ring-1 ring-white/10">
                  <div className="px-3 py-3">
                    <p className="text-base font-bold">
                      {messages.length}
                      {messages.length >= 50 ? "+" : ""}
                    </p>
                    <p className="text-violet-100">mensajes</p>
                  </div>
                  <div className="border-x border-white/10 px-3 py-3">
                    <p className="text-base font-bold">{confirmation ? "1" : "0"}</p>
                    <p className="text-violet-100">pendientes</p>
                  </div>
                  <div className="px-3 py-3">
                    <p className="text-base font-bold">{loading ? "on" : "ok"}</p>
                    <p className="text-violet-100">estado</p>
                  </div>
                </div>
              </section>

              <section className="rounded-[2rem] border border-white/70 bg-white/75 p-5 shadow-xl shadow-violet-950/5 backdrop-blur-xl dark:border-white/10 dark:bg-white/[0.06]">
                <h3 className="text-sm font-semibold text-slate-950 dark:text-white">
                  Flujo actual
                </h3>
                <div className="mt-4 space-y-1 text-sm">
                  <div className="flex items-start gap-3 rounded-2xl px-3 py-2">
                    <span className="mt-1.5 inline-flex h-2.5 w-2.5 shrink-0 rounded-full bg-emerald-500" />
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-slate-800 dark:text-white">Contexto listo</p>
                      <p className="text-xs text-slate-500 dark:text-white/60">Perfil, herramientas y memoria disponibles para el turno.</p>
                    </div>
                  </div>
                  <div
                    className={`flex items-start gap-3 rounded-2xl px-3 py-2 transition ${
                      loading
                        ? "bg-violet-100/80 ring-1 ring-violet-200 dark:bg-violet-400/15 dark:ring-violet-400/30"
                        : ""
                    }`}
                  >
                    <span
                      className={`relative mt-1.5 inline-flex h-2.5 w-2.5 shrink-0 items-center justify-center rounded-full ${
                        loading
                          ? "bg-violet-500 shadow-[0_0_0_4px_rgba(139,92,246,0.18)]"
                          : "bg-slate-300 dark:bg-white/20"
                      }`}
                    >
                      {loading && (
                        <span className="absolute inline-flex h-3.5 w-3.5 animate-ping rounded-full bg-violet-500/60" />
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2 font-medium text-slate-800 dark:text-white">
                        {loading ? "Procesando solicitud" : "Procesamiento"}
                        {loading && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-violet-600 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
                            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
                            En vivo
                          </span>
                        )}
                      </p>
                      <p className="text-xs text-slate-500 dark:text-white/60">
                        {loading
                          ? "Gu está trabajando. En esta fase la UI muestra el resultado cuando termina el turno."
                          : "Por ahora el backend responde al terminar el turno."}
                      </p>
                      {loading && (
                        <div className="mt-2 h-1 overflow-hidden rounded-full bg-violet-200/70 dark:bg-violet-400/20">
                          <div className="h-full w-1/2 animate-pulse rounded-full bg-violet-500" />
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-start gap-3 rounded-2xl px-3 py-2">
                    <span
                      className={`mt-1.5 inline-flex h-2.5 w-2.5 shrink-0 rounded-full ${
                        confirmation ? "bg-amber-500" : "bg-slate-300 dark:bg-white/20"
                      }`}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-slate-800 dark:text-white">Confirmación humana</p>
                      <p className="text-xs text-slate-500 dark:text-white/60">
                        Las acciones sensibles aparecen aquí antes de ejecutarse.
                      </p>
                    </div>
                  </div>
                </div>
              </section>

              <section className="rounded-[2rem] border border-white/70 bg-white/75 p-5 shadow-xl shadow-violet-950/5 backdrop-blur-xl dark:border-white/10 dark:bg-white/[0.06]">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-950 dark:text-white">
                      Habilidades aplicadas
                    </h3>
                    <p className="mt-1 text-xs text-slate-500 dark:text-white/60">
                      Playbooks que Gu cargó para resolver este turno.
                    </p>
                  </div>
                  <span className="rounded-full bg-violet-100 px-3 py-1 text-xs font-semibold text-violet-700 dark:bg-violet-400/10 dark:text-violet-200">
                    {skillsThisTurn.length}
                  </span>
                </div>

                <div className="mt-4 space-y-2">
                  {skillsThisTurn.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-slate-200 px-4 py-4 text-center text-xs text-slate-500 dark:border-white/10 dark:text-white/50">
                      Sin habilidad especializada para este último mensaje.
                    </div>
                  ) : (
                    skillsThisTurn.map((skill) => (
                      <div
                        key={`${skill.id}-${skill.role}`}
                        className="flex items-center gap-3 rounded-2xl bg-white/70 px-3 py-3 text-sm ring-1 ring-slate-100 dark:bg-white/5 dark:ring-white/10"
                      >
                        <span
                          className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                            skill.role === "primary" ? "bg-violet-500" : "bg-sky-400"
                          }`}
                        />
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium text-slate-800 dark:text-white">
                            {formatSkillForUserPanel(skill.id)}
                          </p>
                          <p className="mt-1 text-xs text-slate-500 dark:text-white/60">
                            {formatSkillRole(skill.role)}
                          </p>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </section>

              <section className="rounded-[2rem] border border-white/70 bg-white/75 p-5 shadow-xl shadow-violet-950/5 backdrop-blur-xl dark:border-white/10 dark:bg-white/[0.06]">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-950 dark:text-white">
                      Herramientas del último turno
                    </h3>
                    <p className="mt-1 text-xs text-slate-500 dark:text-white/60">
                      Lo que Gu usó para contestar tu último mensaje.
                    </p>
                  </div>
                  <span className="rounded-full bg-violet-100 px-3 py-1 text-xs font-semibold text-violet-700 dark:bg-violet-400/10 dark:text-violet-200">
                    {toolsThisTurn.length}
                  </span>
                </div>

                <div className="mt-4 space-y-2">
                  {toolsThisTurn.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-slate-200 px-4 py-5 text-center text-xs text-slate-500 dark:border-white/10 dark:text-white/50">
                      {loading
                        ? "Esperando herramientas de este turno…"
                        : "Sin herramientas registradas para el último mensaje (o la respuesta fue solo con contexto)."}
                    </div>
                  ) : (
                    toolsThisTurn.map((tool) => (
                      <div
                        key={tool.id}
                        className="flex items-center gap-3 rounded-2xl bg-white/70 px-3 py-3 text-sm ring-1 ring-slate-100 dark:bg-white/5 dark:ring-white/10"
                      >
                        <span
                          className={`h-2.5 w-2.5 shrink-0 rounded-full ${toolStatusClass(tool.status)}`}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-start justify-between gap-3">
                            <p className="truncate font-medium text-slate-800 dark:text-white">
                              {formatToolForUserPanel(tool.tool_name)}
                            </p>
                            <span className="shrink-0 text-[11px] text-slate-400 dark:text-white/40">
                              {formatToolTime(tool.created_at)}
                            </span>
                          </div>
                          <p className="mt-1 text-xs text-slate-500 dark:text-white/60">
                            {formatToolStatus(tool.status)}
                            {tool.requires_confirmation ? " · HITL" : ""}
                          </p>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </section>

              <section className="rounded-[2rem] border border-violet-100 bg-white/80 p-5 shadow-xl shadow-violet-950/5 backdrop-blur-xl dark:border-white/10 dark:bg-white/[0.06]">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-950 dark:text-white">
                      Presencia y heartbeat
                    </h3>
                    <p className="mt-1 text-xs text-slate-500 dark:text-white/60">
                      Cómo se sentirá hablar con Gu como un colaborador real.
                    </p>
                  </div>
                  <span className="rounded-full bg-violet-100 px-3 py-1 text-xs font-semibold text-violet-700 dark:bg-violet-400/10 dark:text-violet-200">
                    futuro
                  </span>
                </div>
                <div className="mt-4 grid grid-cols-2 gap-3 text-xs">
                  <div className="rounded-2xl bg-violet-50 p-3 text-violet-900 dark:bg-violet-400/10 dark:text-violet-100">
                    <p className="font-semibold">Voz en vivo</p>
                    <p className="mt-1 opacity-70">Conversación por voz en tiempo real, como una llamada.</p>
                  </div>
                  <div className="rounded-2xl bg-emerald-50 p-3 text-emerald-900 dark:bg-emerald-400/10 dark:text-emerald-100">
                    <p className="font-semibold">Heartbeat</p>
                    <p className="mt-1 opacity-70">Trabajo proactivo de Gu cuando nadie le está hablando.</p>
                  </div>
                  <div className="rounded-2xl bg-violet-50 p-3 text-violet-900 dark:bg-violet-400/10 dark:text-violet-100">
                    <p className="font-semibold">Avisos autónomos</p>
                    <p className="mt-1 opacity-70">Notificaciones cuando Gu termina algo o detecta un evento.</p>
                  </div>
                  <div className="rounded-2xl bg-violet-50 p-3 text-violet-900 dark:bg-violet-400/10 dark:text-violet-100">
                    <p className="font-semibold">Estado en vivo</p>
                    <p className="mt-1 opacity-70">Indicadores visuales de pasos, tools y memoria.</p>
                  </div>
                </div>
              </section>

              <section className="rounded-[2rem] border border-white/70 bg-white/75 p-5 shadow-xl shadow-violet-950/5 backdrop-blur-xl dark:border-white/10 dark:bg-white/[0.06]">
                <h3 className="text-sm font-semibold text-slate-950 dark:text-white">
                  Próximamente
                </h3>
                <div className="mt-3 flex flex-wrap gap-2 text-xs font-semibold text-violet-700 dark:text-violet-200">
                  <span className="rounded-full bg-violet-100 px-3 py-1 dark:bg-violet-400/10">memoria activa</span>
                  <span className="rounded-full bg-violet-100 px-3 py-1 dark:bg-violet-400/10">eventos en vivo</span>
                  <span className="rounded-full bg-violet-100 px-3 py-1 dark:bg-violet-400/10">voz realtime</span>
                  <span className="rounded-full bg-violet-100 px-3 py-1 dark:bg-violet-400/10">heartbeat</span>
                </div>
              </section>
            </aside>
          </div>
        </main>
      </div>
    </div>
  );
}
