"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  effectiveInternalNotificationKind,
  hiddenInboxNotificationKinds,
  internalNotificationKindConfig,
} from "@/lib/internal-notifications/registry";
import {
  normalizeNotificationActionUrl,
  pendingActionLinkLabel,
  prepareNotificationBodyMarkdown,
  shouldShowAssociatedActionLink,
} from "@/lib/notifications/pending-action-display";
import type {
  InternalNotificationDisplay,
  PendingToolConfirmationDisplay,
} from "@/lib/notifications/pending-inbox-types";

type PendingInboxClientProps = {
  initialNotifications: InternalNotificationDisplay[];
  initialPendingToolConfirmations: PendingToolConfirmationDisplay[];
  initialCaseFilter?: string | null;
  initialFocusId?: string | null;
};

export function PendingInboxClient({
  initialNotifications,
  initialPendingToolConfirmations,
  initialCaseFilter = null,
  initialFocusId = null,
}: PendingInboxClientProps) {
  const [notifications, setNotifications] =
    useState<InternalNotificationDisplay[]>(initialNotifications);
  const [pendingToolConfirmations, setPendingToolConfirmations] = useState<
    PendingToolConfirmationDisplay[]
  >(initialPendingToolConfirmations);
  const [pendientesCaseFilter, setPendientesCaseFilter] = useState<string | null>(
    initialCaseFilter
  );
  const [pendientesFocusId, setPendientesFocusId] = useState<string | null>(
    initialFocusId
  );
  const [notificationInputs, setNotificationInputs] = useState<Record<string, string>>({});
  const [notificationActionStatus, setNotificationActionStatus] =
    useState<Record<string, string>>({});
  const [notificationCleanupStatus, setNotificationCleanupStatus] = useState<string | null>(
    null
  );
  const pendingItemRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const hiddenNotificationKinds = useMemo(
    () => new Set(hiddenInboxNotificationKinds()),
    []
  );
  const visibleNotifications = useMemo(
    () =>
      notifications.filter(
        (notification) => !hiddenNotificationKinds.has(notification.kind)
      ),
    [notifications, hiddenNotificationKinds]
  );

  async function refreshNotifications(caseFilterOverride?: string | null) {
    const activeFilter =
      caseFilterOverride !== undefined ? caseFilterOverride : pendientesCaseFilter;
    const query = activeFilter
      ? `?case_id=${encodeURIComponent(activeFilter)}`
      : "";
    const res = await fetch(`/api/notifications${query}`);
    const data = (await res.json().catch(() => ({}))) as {
      notifications?: InternalNotificationDisplay[];
      pendingToolConfirmations?: PendingToolConfirmationDisplay[];
    };
    if (res.ok && Array.isArray(data.notifications)) {
      setNotifications(data.notifications);
    }
    if (res.ok && Array.isArray(data.pendingToolConfirmations)) {
      setPendingToolConfirmations(data.pendingToolConfirmations);
    }
  }

  useEffect(() => {
    if (!pendientesFocusId) return;
    const element = pendingItemRefs.current[pendientesFocusId];
    if (!element) return;
    window.requestAnimationFrame(() => {
      element.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  }, [pendientesFocusId, notifications, pendingToolConfirmations]);

  async function updateNotificationStatus(
    id: string,
    status: "read" | "actioned" | "dismissed"
  ) {
    const res = await fetch("/api/notifications", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, status }),
    });
    if (res.ok) {
      setNotifications((current) => current.filter((item) => item.id !== id));
    }
  }

  async function cleanupSettingsTestNotifications() {
    setNotificationCleanupStatus("Limpiando pendientes de prueba...");
    const res = await fetch("/api/notifications?scope=settings-test", {
      method: "DELETE",
    });
    const data = (await res.json().catch(() => ({}))) as {
      deleted?: number;
      error?: string;
    };
    if (res.ok) {
      setNotificationCleanupStatus(
        `Pendientes de prueba eliminados: ${data.deleted ?? 0}.`
      );
      await refreshNotifications();
    } else {
      setNotificationCleanupStatus(
        data.error ?? "No se pudieron limpiar los pendientes de prueba."
      );
    }
  }

  async function submitPriceApprovalDecision(
    notificationId: string,
    payload: { action?: "approve" | "reject"; text?: string }
  ) {
    setNotificationActionStatus((current) => ({
      ...current,
      [notificationId]: "Procesando...",
    }));
    const res = await fetch("/api/business-decisions/price-approval", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        notification_id: notificationId,
        ...payload,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      message?: string;
    };
    setNotificationActionStatus((current) => ({
      ...current,
      [notificationId]: data.message ?? (res.ok ? "Listo." : "No se pudo procesar."),
    }));
    if (res.ok && data.ok !== false) {
      await refreshNotifications();
    }
  }

  async function submitContractReviewDecision(
    notificationId: string,
    action: "approve_send" | "request_changes"
  ) {
    setNotificationActionStatus((current) => ({
      ...current,
      [notificationId]: "Procesando...",
    }));
    const res = await fetch("/api/business-decisions/contract-review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        notification_id: notificationId,
        action,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      message?: string;
      error?: string;
    };
    setNotificationActionStatus((current) => ({
      ...current,
      [notificationId]:
        data.message ?? data.error ?? (res.ok ? "Listo." : "No se pudo procesar."),
    }));
    if (res.ok && data.ok !== false) {
      await refreshNotifications();
    }
  }

  async function submitToolConfirmationDecision(
    pending: PendingToolConfirmationDisplay,
    action: "approve" | "reject"
  ) {
    setNotificationActionStatus((current) => ({
      ...current,
      [pending.toolCallId]: "Procesando...",
    }));
    const res = await fetch("/api/chat/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        toolCallId: pending.toolCallId,
        action,
        channel: "case_runner",
      }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
    };
    setNotificationActionStatus((current) => ({
      ...current,
      [pending.toolCallId]:
        data.error ??
        (res.ok
          ? action === "approve"
            ? "Aprobado. El agente continuó el caso."
            : "Rechazado."
          : "No se pudo procesar."),
    }));
    if (res.ok) {
      await refreshNotifications();
    }
  }

  const pendingInboxCount =
    visibleNotifications.length + pendingToolConfirmations.length;
  const flowRelatedCount =
    pendingToolConfirmations.filter((item) => item.caseId).length +
    visibleNotifications.filter((item) => item.caseId).length;
  const overdueCount = visibleNotifications.filter((item) => {
    if (!item.due_at) return false;
    const due = new Date(item.due_at).getTime();
    return !Number.isNaN(due) && due < Date.now();
  }).length;

  return (
    <section className="rounded-[1.5rem] border border-violet-100 bg-white/85 p-4 text-sm shadow-sm backdrop-blur-xl dark:border-white/10 dark:bg-white/[0.06]">
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 dark:border-amber-300/20 dark:bg-amber-300/10">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-100">
            Por aprobar
          </p>
          <p className="mt-1 text-lg font-semibold text-amber-900 dark:text-amber-50">
            {pendingToolConfirmations.length}
          </p>
        </div>
        <div className="rounded-xl border border-violet-200 bg-violet-50 px-3 py-2 dark:border-violet-300/20 dark:bg-violet-300/10">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-violet-700 dark:text-violet-100">
            Notificaciones
          </p>
          <p className="mt-1 text-lg font-semibold text-violet-900 dark:text-violet-50">
            {visibleNotifications.length}
          </p>
        </div>
        <div className="rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 dark:border-sky-300/20 dark:bg-sky-300/10">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-sky-700 dark:text-sky-100">
            De flujo
          </p>
          <p className="mt-1 text-lg font-semibold text-sky-900 dark:text-sky-50">
            {flowRelatedCount}
          </p>
        </div>
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 dark:border-rose-300/20 dark:bg-rose-300/10">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-rose-700 dark:text-rose-100">
            Vencidos
          </p>
          <p className="mt-1 text-lg font-semibold text-rose-900 dark:text-rose-50">
            {overdueCount}
          </p>
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold text-slate-950 dark:text-white">
            Pendientes
          </h2>
          <p className="text-xs text-slate-500 dark:text-white/50">
            Notificaciones y aprobaciones pendientes de revisión ({pendingInboxCount}).
          </p>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={() => void cleanupSettingsTestNotifications()}
            className="rounded-full border border-rose-200 px-3 py-1 text-xs font-semibold text-rose-700 hover:bg-rose-50 dark:border-rose-300/20 dark:text-rose-100 dark:hover:bg-rose-300/10"
          >
            Limpiar pruebas
          </button>
          <button
            type="button"
            onClick={() => void refreshNotifications()}
            className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50 dark:border-white/10 dark:text-white/70 dark:hover:bg-white/10"
          >
            Refrescar
          </button>
        </div>
      </div>
      {notificationCleanupStatus ? (
        <p className="mt-2 rounded-2xl bg-slate-50 p-2 text-xs text-slate-500 dark:bg-white/5 dark:text-white/60">
          {notificationCleanupStatus}
        </p>
      ) : null}
      {pendientesCaseFilter ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-violet-100 bg-violet-50/70 px-3 py-2 text-xs text-violet-900 dark:border-violet-300/20 dark:bg-violet-300/10 dark:text-violet-100">
          <span>Mostrando pendientes del flujo seleccionado.</span>
          <button
            type="button"
            onClick={() => {
              setPendientesCaseFilter(null);
              setPendientesFocusId(null);
              void refreshNotifications(null);
            }}
            className="font-semibold underline"
          >
            Ver todos
          </button>
        </div>
      ) : null}
      <div className="mt-3 max-h-[min(65vh,40rem)] overflow-y-auto pr-1">
        {visibleNotifications.length === 0 &&
        pendingToolConfirmations.length === 0 ? (
          <p className="rounded-2xl bg-slate-50 p-3 text-xs text-slate-500 dark:bg-white/5 dark:text-white/60">
            No tienes pendientes internos sin leer.
          </p>
        ) : (
          <div className="grid gap-2">
            {pendingToolConfirmations.map((pending) => (
              <div
                key={pending.toolCallId}
                ref={(element) => {
                  pendingItemRefs.current[pending.toolCallId] = element;
                }}
                className={`rounded-2xl border bg-amber-50/80 p-3 text-xs dark:bg-amber-300/10 ${
                  pendientesFocusId === pending.toolCallId
                    ? "border-amber-400 ring-2 ring-amber-300 dark:border-amber-300/40"
                    : "border-amber-200 dark:border-amber-300/20"
                }`}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="font-semibold text-amber-900 dark:text-amber-100">
                      Aprobación del agente
                    </p>
                    <p className="mt-1 text-amber-800 dark:text-amber-100/80">
                      {pending.message}
                    </p>
                    {pending.caseContextLine ? (
                      <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-100/70">
                        {pending.caseContextLine}
                      </p>
                    ) : (
                      <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-100/70">
                        Tool: <span className="font-mono">{pending.toolName}</span>
                        {pending.caseId ? ` · caso ${pending.caseId}` : ""}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    <button
                      type="button"
                      onClick={() =>
                        void submitToolConfirmationDecision(pending, "approve")
                      }
                      className="rounded-full bg-emerald-600 px-2 py-1 font-semibold text-white hover:bg-emerald-700"
                    >
                      Aprobar
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        void submitToolConfirmationDecision(pending, "reject")
                      }
                      className="rounded-full border border-rose-200 px-2 py-1 font-semibold text-rose-700 hover:bg-rose-50 dark:border-rose-300/20 dark:text-rose-100 dark:hover:bg-rose-300/10"
                    >
                      Rechazar
                    </button>
                  </div>
                </div>
                {notificationActionStatus[pending.toolCallId] ? (
                  <p className="mt-2 text-[11px] text-amber-700 dark:text-amber-100/70">
                    {notificationActionStatus[pending.toolCallId]}
                  </p>
                ) : null}
              </div>
            ))}
            {visibleNotifications.map((notification) => (
              <div
                key={notification.id}
                ref={(element) => {
                  pendingItemRefs.current[notification.id] = element;
                }}
                className={`min-w-0 rounded-2xl border bg-white p-3 text-xs dark:bg-white/5 ${
                  pendientesFocusId === notification.id
                    ? "border-violet-400 ring-2 ring-violet-300 dark:border-violet-300/40"
                    : "border-slate-200 dark:border-white/10"
                }`}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-slate-900 dark:text-white">
                      {internalNotificationKindConfig(notification.kind, {
                        body: notification.body,
                        title: notification.title,
                      }).label}
                    </p>
                    {notification.title !== notification.kind ? (
                      <p className="mt-0.5 text-[11px] text-slate-400">
                        {notification.title}
                      </p>
                    ) : null}
                    {notification.caseContextLine ? (
                      <p className="mt-1 text-[11px] text-slate-500 dark:text-white/50">
                        {notification.caseContextLine}
                      </p>
                    ) : null}
                    <div className="prose prose-sm mt-1 max-w-none break-words text-slate-600 dark:text-white/70 prose-a:break-words prose-a:text-violet-700 prose-a:underline dark:prose-a:text-violet-200">
                      <ReactMarkdown
                        components={{
                          a: ({ href, children }) => (
                            <a href={href} target="_blank" rel="noopener noreferrer">
                              {children}
                            </a>
                          ),
                        }}
                      >
                        {prepareNotificationBodyMarkdown(notification.body)}
                      </ReactMarkdown>
                    </div>
                    <p className="mt-1 text-[11px] text-slate-400">
                      Prioridad: {notification.priority}
                      {notification.due_at
                        ? ` · vence ${new Date(notification.due_at).toLocaleString()}`
                        : ""}
                    </p>
                    {effectiveInternalNotificationKind({
                      kind: notification.kind,
                      body: notification.body,
                      title: notification.title,
                    }) === "price_approval" ? (
                      <div className="mt-3 space-y-2 rounded-2xl border border-amber-100 bg-amber-50/70 p-2 dark:border-amber-300/20 dark:bg-amber-300/10">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-700 dark:text-amber-100">
                          Aprobacion de precio
                        </p>
                        <div className="flex flex-wrap gap-1">
                          <button
                            type="button"
                            onClick={() =>
                              void submitPriceApprovalDecision(notification.id, {
                                action: "approve",
                              })
                            }
                            className="rounded-full bg-emerald-600 px-2 py-1 font-semibold text-white hover:bg-emerald-700"
                          >
                            Aprobar
                          </button>
                        </div>
                        <div className="flex flex-col gap-1 sm:flex-row">
                          <input
                            value={notificationInputs[notification.id] ?? ""}
                            onChange={(event) =>
                              setNotificationInputs((current) => ({
                                ...current,
                                [notification.id]: event.target.value,
                              }))
                            }
                            placeholder="Ej. AJUSTAR PRECIO salida=23500 ideal=22000 minimo=18000"
                            className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs outline-none focus:border-violet-300 dark:border-white/10 dark:bg-slate-950"
                          />
                          <button
                            type="button"
                            onClick={() =>
                              void submitPriceApprovalDecision(notification.id, {
                                text: notificationInputs[notification.id] ?? "",
                              })
                            }
                            className="rounded-xl border border-violet-200 px-3 py-2 font-semibold text-violet-700 hover:bg-violet-50 dark:border-violet-300/20 dark:text-violet-100"
                          >
                            Ajustar y aprobar
                          </button>
                        </div>
                        {notificationActionStatus[notification.id] ? (
                          <p className="text-[11px] text-slate-500 dark:text-white/60">
                            {notificationActionStatus[notification.id]}
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                    {notification.kind === "contract_review" ? (
                      <div className="mt-3 space-y-2 rounded-2xl border border-violet-100 bg-violet-50/70 p-2 dark:border-violet-300/20 dark:bg-violet-300/10">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-violet-700 dark:text-violet-100">
                          Revisión de contrato
                        </p>
                        <div className="flex flex-wrap gap-1">
                          <button
                            type="button"
                            onClick={() =>
                              void submitContractReviewDecision(
                                notification.id,
                                "approve_send"
                              )
                            }
                            className="rounded-full bg-emerald-600 px-2 py-1 font-semibold text-white hover:bg-emerald-700"
                          >
                            Aprobar y enviar
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              void submitContractReviewDecision(
                                notification.id,
                                "request_changes"
                              )
                            }
                            className="rounded-full border border-violet-200 px-2 py-1 font-semibold text-violet-700 hover:bg-violet-50 dark:border-violet-300/20 dark:text-violet-100"
                          >
                            Pedir cambios
                          </button>
                        </div>
                        {notificationActionStatus[notification.id] ? (
                          <p className="text-[11px] text-slate-500 dark:text-white/60">
                            {notificationActionStatus[notification.id]}
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-1">
                    {shouldShowAssociatedActionLink({
                      kind: "internal_notification",
                      notification_kind: notification.kind,
                      action_url: notification.action_url,
                      body: notification.body,
                    }) ? (
                      <a
                        href={
                          normalizeNotificationActionUrl(notification.action_url) ??
                          notification.action_url ??
                          "#"
                        }
                        target="_blank"
                        rel="noopener noreferrer"
                        className="rounded-full bg-violet-700 px-2 py-1 font-semibold text-white hover:bg-violet-800"
                      >
                        {pendingActionLinkLabel(
                          {
                            kind: "internal_notification",
                            notification_kind: notification.kind,
                            action_url: notification.action_url,
                          },
                          "action_url"
                        )}
                      </a>
                    ) : null}
                    <button
                      type="button"
                      onClick={() =>
                        void updateNotificationStatus(notification.id, "read")
                      }
                      className="rounded-full border border-slate-200 px-2 py-1 font-semibold text-slate-600 hover:bg-slate-50 dark:border-white/10 dark:text-white/70"
                    >
                      Leida
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        void updateNotificationStatus(notification.id, "actioned")
                      }
                      className="rounded-full border border-emerald-200 px-2 py-1 font-semibold text-emerald-700 hover:bg-emerald-50"
                    >
                      Atendida
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
