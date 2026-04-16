"use client";

import { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";

interface Message {
  role: string;
  content: string;
  created_at?: string;
}

interface PendingConfirmation {
  toolCallId: string;
  toolName: string;
  message: string;
  args: Record<string, unknown>;
}

interface Props {
  agentName: string;
  initialMessages: Message[];
  initialPendingConfirmation?: PendingConfirmation | null;
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

export function ChatInterface({
  agentName,
  initialMessages,
  initialPendingConfirmation = null,
}: Props) {
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [confirmation, setConfirmation] = useState<PendingConfirmation | null>(
    initialPendingConfirmation
  );
  const [confirming, setConfirming] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, confirmation]);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || loading) return;

    const userMsg: Message = { role: "user", content: text };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });

      const data = await res.json();

      if (data.response) {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: data.response },
        ]);
      }

      if (data.pendingConfirmation) {
        setConfirmation(data.pendingConfirmation);
      }
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: "Error al procesar tu mensaje. Intenta de nuevo.",
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

      const data = await res.json();

      if (data.ok && data.response) {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: data.response },
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
          },
        ]);
      } else if (action === "reject" && !data.response) {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: "Acción cancelada." },
        ]);
      }
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Error al procesar la confirmación." },
      ]);
    } finally {
      setConfirmation(keepPending);
      setConfirming(false);
    }
  }

  return (
    <div className="flex flex-1 flex-col">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto max-w-2xl space-y-4">
          {messages.length === 0 && (
            <div className="text-center text-sm text-neutral-400 py-20">
              <p className="text-lg font-medium text-neutral-600 dark:text-neutral-300">
                Hola! Soy {agentName}
              </p>
              <p className="mt-1">Escribe un mensaje para comenzar.</p>
            </div>
          )}
          {messages.map((msg, i) => (
            <div
              key={i}
              className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[80%] rounded-lg px-4 py-2.5 text-sm leading-relaxed ${
                  msg.role === "user"
                    ? "bg-blue-600 text-white"
                    : "bg-neutral-100 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100"
                }`}
              >
                {msg.role === "assistant" ? (
                  <div className="prose prose-sm dark:prose-invert max-w-none prose-p:my-1 prose-li:my-0.5 prose-ol:my-1 prose-ul:my-1 prose-a:text-blue-600 dark:prose-a:text-blue-400 prose-a:underline">
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
            </div>
          ))}

          {/* Confirmation prompt */}
          {confirmation && (
            <div className="flex justify-start">
              <div className="max-w-[80%] rounded-lg border border-yellow-300 bg-yellow-50 px-4 py-3 text-sm dark:border-yellow-700 dark:bg-yellow-950/30">
                <p className="mb-3 text-neutral-900 dark:text-neutral-100">
                  {confirmation.message}
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => handleConfirm("approve")}
                    disabled={confirming}
                    className="rounded-md bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
                  >
                    {confirming ? "Ejecutando..." : "Aprobar"}
                  </button>
                  <button
                    onClick={() => handleConfirm("reject")}
                    disabled={confirming}
                    className="rounded-md border border-red-300 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950"
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            </div>
          )}

          {loading && (
            <div className="flex justify-start">
              <div className="rounded-lg bg-neutral-100 px-4 py-2.5 text-sm dark:bg-neutral-800">
                <span className="animate-pulse">Pensando...</span>
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* Input */}
      <div className="border-t border-neutral-200 px-4 py-3 dark:border-neutral-800">
        <form onSubmit={handleSend} className="mx-auto flex max-w-2xl gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Escribe tu mensaje..."
            disabled={loading || !!confirmation}
            className="flex-1 rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900"
          />
          <button
            type="submit"
            disabled={loading || !input.trim() || !!confirmation}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            Enviar
          </button>
        </form>
      </div>
    </div>
  );
}
