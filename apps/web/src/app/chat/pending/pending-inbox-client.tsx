"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  escalationPolicyForNotificationKind,
  hiddenInboxNotificationKinds,
  internalNotificationKindConfig,
  maxReminderAttemptsForNotificationKind,
  reminderCooldownHoursForNotificationKind,
} from "@/lib/internal-notifications/registry";
import {
  computePendingInboxVisibleCounts,
  findHitlLinkedNotifications,
  listRenderableNotifications,
  REMINDER_KIND,
  TOOL_CONFIRMATION_PENDING_KIND,
} from "@/lib/notifications/pending-inbox-dedupe";
import {
  caseActionUrl,
  normalizeNotificationActionUrl,
  pendingActionLinkLabel,
  prepareNotificationBodyMarkdown,
  shouldShowAssociatedActionLink,
  toolConfirmationCardTitle,
  toolConfirmationToolLine,
} from "@/lib/notifications/pending-action-display";
import { pendingInlineActionKind } from "@/lib/notifications/pending-action-registry";
import type {
  InternalNotificationDisplay,
  PendingInboxCounts,
  PendingToolConfirmationDisplay,
  ResolvedNotificationDisplay,
} from "@/lib/notifications/pending-inbox-types";

type PendingInboxClientProps = {
  initialNotifications: InternalNotificationDisplay[];
  initialPendingToolConfirmations: PendingToolConfirmationDisplay[];
  initialCounts: PendingInboxCounts;
  initialCaseFilter?: string | null;
  initialFocusId?: string | null;
};

const PENDING_INBOX_POLL_MS =
  process.env.NODE_ENV === "production" ? 60_000 : 30_000;

function nextReminderEstimate(
  latestReminderIso: string | null | undefined,
  createdAtIso: string,
  cooldownHours: number
) {
  const baseIso = latestReminderIso ?? createdAtIso;
  const base = new Date(baseIso);
  if (Number.isNaN(base.getTime())) return null;
  const estimate = new Date(base.getTime() + cooldownHours * 60 * 60_000);
  if (estimate.getTime() <= Date.now()) return null;
  return estimate.toISOString();
}

function dueBadgeState(dueAtIso: string | null | undefined) {
  if (!dueAtIso) {
    return {
      label: "Sin vencimiento",
      className:
        "border-slate-200 bg-slate-50 text-slate-600 dark:border-white/10 dark:bg-white/5 dark:text-white/60",
    };
  }
  const dueAt = new Date(dueAtIso);
  if (Number.isNaN(dueAt.getTime())) {
    return {
      label: "Vencimiento no disponible",
      className:
        "border-slate-200 bg-slate-50 text-slate-600 dark:border-white/10 dark:bg-white/5 dark:text-white/60",
    };
  }
  if (dueAt.getTime() <= Date.now()) {
    return {
      label: "Vencido",
      className:
        "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-300/20 dark:bg-rose-300/10 dark:text-rose-100",
    };
  }
  return {
    label: "Pendiente",
    className:
      "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-300/20 dark:bg-amber-300/10 dark:text-amber-100",
  };
}

function formatDateTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, {
    dateStyle: "short",
    timeStyle: "short",
  });
}

function latestNotificationDate(notifications: InternalNotificationDisplay[]) {
  return notifications.reduce<number | null>((latest, notification) => {
    const timestamp = new Date(notification.created_at).getTime();
    if (Number.isNaN(timestamp)) return latest;
    return latest === null || timestamp > latest ? timestamp : latest;
  }, null);
}

function notificationActivityTime(
  notification: InternalNotificationDisplay,
  reminders: InternalNotificationDisplay[]
) {
  const created = new Date(notification.created_at).getTime();
  const refreshed = notification.lastRefreshedAt
    ? new Date(notification.lastRefreshedAt).getTime()
    : 0;
  const latestReminder = latestNotificationDate(reminders);
  return Math.max(
    Number.isNaN(created) ? 0 : created,
    Number.isNaN(refreshed) ? 0 : refreshed,
    latestReminder ?? 0
  );
}

export function PendingInboxClient({
  initialNotifications,
  initialPendingToolConfirmations,
  initialCounts,
  initialCaseFilter = null,
  initialFocusId = null,
}: PendingInboxClientProps) {
  const [notifications, setNotifications] =
    useState<InternalNotificationDisplay[]>(initialNotifications);
  const [pendingToolConfirmations, setPendingToolConfirmations] = useState<
    PendingToolConfirmationDisplay[]
  >(initialPendingToolConfirmations);
  const [counts, setCounts] = useState<PendingInboxCounts>(initialCounts);
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
  const [expandedReminderGroups, setExpandedReminderGroups] = useState<
    Record<string, boolean>
  >({});
  const [expandedHitlActivity, setExpandedHitlActivity] = useState<
    Record<string, boolean>
  >({});
  const [showResolved, setShowResolved] = useState(false);
  const [resolvedNotifications, setResolvedNotifications] = useState<
    ResolvedNotificationDisplay[]
  >([]);
  const [resolvedLoading, setResolvedLoading] = useState(false);
  const [inboxMenuOpen, setInboxMenuOpen] = useState(false);
  // Dates are formatted with the runtime locale/timezone (toLocaleString).
  // The server renders in UTC/en-US while the browser uses local settings,
  // which causes a hydration mismatch. Render dates only after mount so SSR
  // and the first client render agree, then fill in the localized values.
  const [hydrated, setHydrated] = useState(false);
  const pendingItemRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const inboxMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!inboxMenuOpen) return;
    function onPointerDown(event: MouseEvent) {
      if (!inboxMenuRef.current?.contains(event.target as Node)) {
        setInboxMenuOpen(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [inboxMenuOpen]);

  const fmtDate = (value: string | null | undefined) =>
    hydrated ? formatDateTime(value) : null;

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

  const refreshNotifications = useCallback(
    async (caseFilterOverride?: string | null) => {
      const activeFilter =
        caseFilterOverride !== undefined ? caseFilterOverride : pendientesCaseFilter;
      const query = activeFilter
        ? `?case_id=${encodeURIComponent(activeFilter)}`
        : "";
      const res = await fetch(`/api/notifications${query}`);
      const data = (await res.json().catch(() => ({}))) as {
        notifications?: InternalNotificationDisplay[];
        pendingToolConfirmations?: PendingToolConfirmationDisplay[];
        counts?: PendingInboxCounts;
      };
      if (res.ok && Array.isArray(data.notifications)) {
        setNotifications(data.notifications);
      }
      if (res.ok && Array.isArray(data.pendingToolConfirmations)) {
        setPendingToolConfirmations(data.pendingToolConfirmations);
      }
      if (res.ok && data.counts) {
        setCounts(data.counts);
      }
    },
    [pendientesCaseFilter]
  );

  useEffect(() => {
    let intervalId: number | null = null;
    let inFlight = false;

    async function tick() {
      if (document.visibilityState !== "visible" || inFlight) return;
      inFlight = true;
      try {
        await refreshNotifications();
      } catch {
        // Best-effort; the next tick will retry.
      } finally {
        inFlight = false;
      }
    }

    function startPolling() {
      if (intervalId !== null) return;
      intervalId = window.setInterval(() => {
        void tick();
      }, PENDING_INBOX_POLL_MS);
    }

    function stopPolling() {
      if (intervalId === null) return;
      window.clearInterval(intervalId);
      intervalId = null;
    }

    function onVisibilityChange() {
      if (document.visibilityState === "visible") {
        void tick();
        startPolling();
      } else {
        stopPolling();
      }
    }

    if (document.visibilityState === "visible") {
      startPolling();
    }
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      stopPolling();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [refreshNotifications]);

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
      if (showResolved) {
        await loadResolvedNotifications();
      }
    }
  }

  async function loadResolvedNotifications() {
    setResolvedLoading(true);
    try {
      const res = await fetch("/api/notifications?view=resolved");
      const data = (await res.json().catch(() => ({}))) as {
        notifications?: ResolvedNotificationDisplay[];
      };
      if (res.ok && Array.isArray(data.notifications)) {
        setResolvedNotifications(data.notifications);
      }
    } finally {
      setResolvedLoading(false);
    }
  }

  async function toggleResolvedPanel() {
    const next = !showResolved;
    setShowResolved(next);
    if (next) {
      await loadResolvedNotifications();
    }
  }

  async function restoreNotification(id: string) {
    const res = await fetch("/api/notifications", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, status: "unread" }),
    });
    if (res.ok) {
      setResolvedNotifications((current) =>
        current.filter((item) => item.id !== id)
      );
      await refreshNotifications();
    }
  }

  async function cleanupSettingsTestNotifications() {
    setNotificationCleanupStatus("Limpiando pendientes de prueba...");
    const res = await fetch("/api/notifications?scope=settings-test", {
      method: "DELETE",
    });
    const data = (await res.json().catch(() => ({}))) as {
      deleted?: number;
      rejected_tool_calls?: number;
      dismissed_orphan_reminders?: number;
      error?: string;
    };
    if (res.ok) {
      setNotificationCleanupStatus(
        `Pendientes de laboratorio eliminados: ${data.deleted ?? 0}. Solicitudes del agente canceladas: ${data.rejected_tool_calls ?? 0}. Recordatorios huérfanos cerrados: ${data.dismissed_orphan_reminders ?? 0}.`
      );
      await refreshNotifications();
    } else {
      setNotificationCleanupStatus(
        data.error ?? "No se pudieron limpiar los pendientes de prueba."
      );
    }
  }

  async function cleanupResolvedHistory() {
    setNotificationCleanupStatus("Limpiando historial de atendidos...");
    const res = await fetch("/api/notifications?scope=resolved-history", {
      method: "DELETE",
    });
    const data = (await res.json().catch(() => ({}))) as {
      deleted_resolved_history?: number;
      error?: string;
    };
    if (res.ok) {
      setNotificationCleanupStatus(
        `Historial de atendidos eliminado: ${data.deleted_resolved_history ?? 0} registros.`
      );
      setResolvedNotifications([]);
      await refreshNotifications();
    } else {
      setNotificationCleanupStatus(
        data.error ?? "No se pudo limpiar el historial de atendidos."
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

  async function submitListingDescriptionReviewDecision(
    notificationId: string,
    payload: { action?: "approve"; text?: string }
  ) {
    setNotificationActionStatus((current) => ({
      ...current,
      [notificationId]: "Procesando...",
    }));
    const res = await fetch("/api/business-decisions/listing-description-review", {
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

  async function submitComparablesExpansionDecision(
    notificationId: string,
    payload: {
      action?: "use_current_comparables" | "use_avaclick_primary" | "expand_search";
      text?: string;
    }
  ) {
    setNotificationActionStatus((current) => ({
      ...current,
      [notificationId]: "Procesando...",
    }));
    const res = await fetch("/api/business-decisions/comparables-expansion-decision", {
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

  async function submitContractReviewDecision(
    notificationId: string,
    payload: { action?: "approve_send" | "request_changes"; text?: string }
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
        ...payload,
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

  async function submitContractDataReviewDecision(
    notificationId: string,
    payload: { text?: string }
  ) {
    setNotificationActionStatus((current) => ({
      ...current,
      [notificationId]: "Procesando...",
    }));
    const res = await fetch("/api/business-decisions/contract-data-review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        notification_id: notificationId,
        text: payload.text ?? "",
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

  async function submitPropertyDataReviewDecision(
    notificationId: string,
    payload: { action?: "confirm"; text?: string }
  ) {
    setNotificationActionStatus((current) => ({
      ...current,
      [notificationId]: "Procesando...",
    }));
    const res = await fetch("/api/business-decisions/property-data-review", {
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

  const notificationById = useMemo(() => {
    const map = new Map<string, InternalNotificationDisplay>();
    for (const notification of visibleNotifications) {
      map.set(notification.id, notification);
    }
    return map;
  }, [visibleNotifications]);
  const remindersBySource = useMemo(() => {
    const map = new Map<string, InternalNotificationDisplay[]>();
    for (const notification of visibleNotifications) {
      if (notification.kind !== REMINDER_KIND || !notification.sourceNotificationId) {
        continue;
      }
      if (!notificationById.has(notification.sourceNotificationId)) continue;
      const current = map.get(notification.sourceNotificationId) ?? [];
      current.push(notification);
      map.set(notification.sourceNotificationId, current);
    }
    for (const reminders of map.values()) {
      reminders.sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );
    }
    return map;
  }, [visibleNotifications, notificationById]);
  const pendingHitlCaseIds = useMemo(
    () =>
      new Set(
        pendingToolConfirmations
          .map((pending) => pending.caseId)
          .filter((caseId): caseId is string => Boolean(caseId))
      ),
    [pendingToolConfirmations]
  );
  const pendingHitlToolCallIds = useMemo(
    () => new Set(pendingToolConfirmations.map((pending) => pending.toolCallId)),
    [pendingToolConfirmations]
  );
  const renderedNotifications = useMemo(
    () =>
      listRenderableNotifications(
        visibleNotifications,
        pendingToolConfirmations,
        hiddenNotificationKinds
      )
        .map((notification) => notificationById.get(notification.id))
        .filter(
          (notification): notification is InternalNotificationDisplay =>
            Boolean(notification)
        )
        .sort(
          (a, b) =>
            notificationActivityTime(b, remindersBySource.get(b.id) ?? []) -
            notificationActivityTime(a, remindersBySource.get(a.id) ?? [])
        ),
    [
      visibleNotifications,
      pendingToolConfirmations,
      hiddenNotificationKinds,
      notificationById,
      remindersBySource,
    ]
  );
  const hitlLinkedByToolCallId = useMemo(() => {
    const map = new Map<
      string,
      {
        notifications: InternalNotificationDisplay[];
        reminders: InternalNotificationDisplay[];
      }
    >();
    for (const pending of pendingToolConfirmations) {
      const linkedNotifications = findHitlLinkedNotifications(
        pending,
        visibleNotifications
      );
      const reminders = linkedNotifications.flatMap(
        (notification) => remindersBySource.get(notification.id) ?? []
      );
      reminders.sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );
      map.set(pending.toolCallId, {
        notifications: linkedNotifications,
        reminders,
      });
    }
    return map;
  }, [pendingToolConfirmations, visibleNotifications, remindersBySource]);
  const visibleCounts = useMemo(
    () =>
      computePendingInboxVisibleCounts(
        visibleNotifications,
        pendingToolConfirmations,
        { hiddenKinds: hiddenNotificationKinds }
      ),
    [visibleNotifications, pendingToolConfirmations, hiddenNotificationKinds]
  );
  const totalPendingCount = counts.uniquePendingTotal ?? visibleCounts.uniquePendingTotal;
  const standaloneCount = Math.max(
    totalPendingCount - counts.flowRelatedTotal,
    0
  );
  const loadedCardCount = visibleCounts.uniquePendingTotal;
  const hasMoreNotificationRows =
    counts.notificationRowsTotal > visibleNotifications.length;
  const resolvedNotificationGroups = useMemo(() => {
    const groups = new Map<
      string,
      {
        key: string;
        notifications: ResolvedNotificationDisplay[];
        representative: ResolvedNotificationDisplay;
      }
    >();
    for (const notification of resolvedNotifications) {
      const key = `${notification.kind}:${notification.caseId ?? notification.id}`;
      const current = groups.get(key);
      if (current) {
        current.notifications.push(notification);
        current.notifications.sort(
          (a, b) =>
            new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
        );
        current.representative = current.notifications[0];
      } else {
        groups.set(key, {
          key,
          notifications: [notification],
          representative: notification,
        });
      }
    }
    return Array.from(groups.values()).sort(
      (a, b) =>
        new Date(b.representative.updated_at).getTime() -
        new Date(a.representative.updated_at).getTime()
    );
  }, [resolvedNotifications]);

  return (
    <section className="rounded-[1.5rem] border border-violet-100 bg-white/85 p-4 text-sm shadow-sm backdrop-blur-xl dark:border-white/10 dark:bg-white/[0.06]">
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-xl border border-violet-200 bg-violet-50 px-3 py-2 dark:border-violet-300/20 dark:bg-violet-300/10">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-violet-700 dark:text-violet-100">
            Total pendientes
          </p>
          <p className="mt-1 text-lg font-semibold text-violet-900 dark:text-violet-50">
            {totalPendingCount}
          </p>
          <p className="mt-0.5 text-[11px] text-violet-700/70 dark:text-violet-100/70">
            Accionables únicos en pantalla, sin recordatorios ni avisos duplicados de HITL.
          </p>
        </div>
        <div className="rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 dark:border-sky-300/20 dark:bg-sky-300/10">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-sky-700 dark:text-sky-100">
            Notificaciones accionables
          </p>
          <p className="mt-1 text-lg font-semibold text-sky-900 dark:text-sky-50">
            {counts.actionableNotificationsTotal}
          </p>
          <p className="mt-0.5 text-[11px] text-sky-700/70 dark:text-sky-100/70">
            Decisiones, avisos o revisiones para ti.
          </p>
        </div>
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 dark:border-amber-300/20 dark:bg-amber-300/10">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-100">
            Aprobaciones HITL
          </p>
          <p className="mt-1 text-lg font-semibold text-amber-900 dark:text-amber-50">
            {counts.pendingToolConfirmationsTotal}
          </p>
          <p className="mt-0.5 text-[11px] text-amber-700/70 dark:text-amber-100/70">
            Acciones sensibles del agente que requieren tu OK.
          </p>
        </div>
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 dark:border-rose-300/20 dark:bg-rose-300/10">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-rose-700 dark:text-rose-100">
            Vencidos
          </p>
          <p className="mt-1 text-lg font-semibold text-rose-900 dark:text-rose-50">
            {counts.overdueTotal}
          </p>
          <p className="mt-0.5 text-[11px] text-rose-700/70 dark:text-rose-100/70">
            Ya pasaron su fecha límite.
          </p>
        </div>
      </div>
      <p className="mt-2 text-xs text-slate-500 dark:text-white/50">
        {counts.flowRelatedTotal} ligados a flujos operativos · {standaloneCount} independientes.
      </p>

      <div className="mt-4 flex items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold text-slate-950 dark:text-white">
            Pendientes
          </h2>
          <p className="text-xs text-slate-500 dark:text-white/50">
            Mostrando {loadedCardCount}{" "}
            {loadedCardCount === 1 ? "elemento" : "elementos"} en pantalla
            (decisiones de negocio, avisos y aprobaciones HITL). Los recordatorios
            repetidos y los avisos inbox duplicados de HITL se agrupan dentro del
            pendiente original — expándelos con «ver recordatorios» o «ver avisos del sistema».
          </p>
        </div>
        <div className="relative shrink-0" ref={inboxMenuRef}>
          <button
            type="button"
            aria-expanded={inboxMenuOpen}
            aria-haspopup="menu"
            onClick={() => setInboxMenuOpen((open) => !open)}
            className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50 dark:border-white/10 dark:text-white/70 dark:hover:bg-white/10"
          >
            Opciones
            <span className="ml-1 text-[10px] opacity-60" aria-hidden>
              ▾
            </span>
          </button>
          {inboxMenuOpen ? (
            <div
              role="menu"
              className="absolute right-0 top-full z-20 mt-1 min-w-[15rem] overflow-hidden rounded-xl border border-slate-200 bg-white py-1 text-xs shadow-lg dark:border-white/10 dark:bg-slate-950"
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setInboxMenuOpen(false);
                  void toggleResolvedPanel();
                }}
                className="block w-full px-3 py-2 text-left font-medium text-slate-700 hover:bg-slate-50 dark:text-white/80 dark:hover:bg-white/10"
              >
                {showResolved
                  ? "Ocultar atendidos recientes"
                  : "Ver atendidos recientes"}
              </button>
              <div
                role="separator"
                className="my-1 border-t border-slate-100 dark:border-white/10"
              />
              <p className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400 dark:text-white/40">
                Limpiar bandeja
              </p>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setInboxMenuOpen(false);
                  void cleanupResolvedHistory();
                }}
                className="block w-full px-3 py-2 text-left text-slate-600 hover:bg-slate-50 dark:text-white/70 dark:hover:bg-white/10"
              >
                Historial de atendidos
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setInboxMenuOpen(false);
                  void cleanupSettingsTestNotifications();
                }}
                className="block w-full px-3 py-2 text-left text-rose-700 hover:bg-rose-50 dark:text-rose-100 dark:hover:bg-rose-300/10"
              >
                Pendientes de laboratorio
              </button>
            </div>
          ) : null}
        </div>
      </div>
      {notificationCleanupStatus ? (
        <p className="mt-2 rounded-2xl bg-slate-50 p-2 text-xs text-slate-500 dark:bg-white/5 dark:text-white/60">
          {notificationCleanupStatus}
        </p>
      ) : null}
      {hasMoreNotificationRows ? (
        <p className="mt-2 rounded-2xl bg-amber-50 p-2 text-xs text-amber-800 ring-1 ring-amber-100 dark:bg-amber-300/10 dark:text-amber-100 dark:ring-amber-300/20">
          Hay {counts.notificationRowsTotal} notificaciones sin leer en total. Se muestran las más recientes y los recordatorios relacionados se agrupan para que no oculten la acción principal.
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
        {renderedNotifications.length === 0 &&
        pendingToolConfirmations.length === 0 ? (
          <p className="rounded-2xl bg-slate-50 p-3 text-xs text-slate-500 dark:bg-white/5 dark:text-white/60">
            No tienes pendientes internos sin leer.
          </p>
        ) : (
          <div className="grid gap-2">
            {pendingToolConfirmations.map((pending) => {
              const linkedActivity =
                hitlLinkedByToolCallId.get(pending.toolCallId) ?? {
                  notifications: [],
                  reminders: [],
                };
              const activityCount =
                linkedActivity.notifications.length +
                linkedActivity.reminders.length;
              const primaryLinkedNotification = linkedActivity.notifications[0];
              const activityExpanded = Boolean(
                expandedHitlActivity[pending.toolCallId]
              );
              const linkedDueBadge = dueBadgeState(primaryLinkedNotification?.due_at);
              const linkedLatestReminderAt = fmtDate(
                primaryLinkedNotification?.lastReminderAt ??
                  linkedActivity.reminders[0]?.created_at
              );
              const linkedNextReminderAt = primaryLinkedNotification
                ? fmtDate(
                    nextReminderEstimate(
                      primaryLinkedNotification.lastReminderAt ??
                        linkedActivity.reminders[0]?.created_at,
                      primaryLinkedNotification.created_at,
                      reminderCooldownHoursForNotificationKind(
                        TOOL_CONFIRMATION_PENDING_KIND
                      )
                    )
                  )
                : null;

              return (
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
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-semibold text-amber-900 dark:text-amber-100">
                        {toolConfirmationCardTitle()}
                      </p>
                      <span className="rounded-full border border-amber-300/60 bg-amber-100/80 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800 dark:border-amber-200/20 dark:bg-amber-200/10 dark:text-amber-50">
                        Requiere tu OK
                      </span>
                    </div>
                    <p className="mt-1 text-amber-800 dark:text-amber-100/80">
                      {pending.message}
                    </p>
                    {pending.caseContextLine ? (
                      <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-100/70">
                        {pending.caseContextLine}
                      </p>
                    ) : (
                      <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-100/70">
                        {toolConfirmationToolLine(pending.toolName)}
                        {pending.caseId ? ` · caso ${pending.caseId}` : ""}
                      </p>
                    )}
                    {pending.caseId ? (
                      <a
                        href={caseActionUrl(pending.caseId)}
                        className="mt-1 inline-block text-[11px] font-semibold text-amber-800 underline decoration-amber-300/60 underline-offset-2 hover:text-amber-950 dark:text-amber-100 dark:hover:text-white"
                      >
                        Ver flujo operativo
                      </a>
                    ) : null}
                    <p className="mt-1 text-[11px] text-amber-700/70 dark:text-amber-100/60">
                      Solicitado: {fmtDate(pending.createdAt) ?? "fecha no disponible"}
                      {" · "}
                      Aprobar ejecuta la acción; rechazar la cancela y el agente sigue sin hacerla.
                    </p>
                    {activityCount > 0 ? (
                      <div className="mt-2">
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedHitlActivity((current) => ({
                              ...current,
                              [pending.toolCallId]: !current[pending.toolCallId],
                            }))
                          }
                          className="rounded-full bg-amber-100/80 px-2 py-0.5 text-[10px] font-semibold text-amber-800 ring-1 ring-amber-200 hover:bg-amber-100 dark:bg-amber-300/10 dark:text-amber-50 dark:ring-amber-300/20 dark:hover:bg-amber-300/20"
                        >
                          {activityCount} aviso{activityCount === 1 ? "" : "s"} del sistema
                          {activityExpanded ? " · ocultar" : " · ver"}
                        </button>
                        {primaryLinkedNotification ? (
                          <p className="mt-1 text-[11px] text-amber-700/80 dark:text-amber-100/70">
                            Inbox: {linkedDueBadge.label.toLowerCase()}
                            {linkedLatestReminderAt
                              ? ` · último recordatorio ${linkedLatestReminderAt}`
                              : ""}
                            {linkedNextReminderAt
                              ? ` · próximo recordatorio aprox. ${linkedNextReminderAt}`
                              : ""}
                            {primaryLinkedNotification.refreshCount &&
                            primaryLinkedNotification.refreshCount > 0
                              ? ` · actualizada ${primaryLinkedNotification.refreshCount} ${primaryLinkedNotification.refreshCount === 1 ? "vez" : "veces"}`
                              : ""}
                          </p>
                        ) : null}
                        {activityExpanded ? (
                          <div className="mt-2 rounded-2xl border border-amber-200/80 bg-amber-100/50 p-2 text-[11px] text-amber-900 dark:border-amber-300/20 dark:bg-amber-300/10 dark:text-amber-100">
                            <p className="font-semibold">Historial de avisos</p>
                            <div className="mt-1 space-y-1.5">
                              {linkedActivity.notifications.map((notification) => (
                                <div
                                  key={notification.id}
                                  className="rounded-xl bg-white/70 p-2 dark:bg-white/5"
                                >
                                  <p className="font-medium">
                                    Aviso inbox ·{" "}
                                    {fmtDate(notification.created_at) ??
                                      "fecha no disponible"}
                                  </p>
                                  <div className="prose prose-sm mt-1 max-w-none break-words text-amber-900 dark:text-amber-100 prose-p:my-1">
                                    <ReactMarkdown>
                                      {prepareNotificationBodyMarkdown(notification.body)}
                                    </ReactMarkdown>
                                  </div>
                                </div>
                              ))}
                              {linkedActivity.reminders.map((reminder) => (
                                <div
                                  key={reminder.id}
                                  className="rounded-xl bg-white/70 p-2 dark:bg-white/5"
                                >
                                  <p className="font-medium">
                                    Recordatorio ·{" "}
                                    {fmtDate(reminder.created_at) ??
                                      "fecha no disponible"}
                                  </p>
                                  <div className="prose prose-sm mt-1 max-w-none break-words text-amber-900 dark:text-amber-100 prose-p:my-1">
                                    <ReactMarkdown>
                                      {prepareNotificationBodyMarkdown(reminder.body)}
                                    </ReactMarkdown>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
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
              );
            })}
            {renderedNotifications.map((notification) => {
              const reminders = remindersBySource.get(notification.id) ?? [];
              const latestReminder = reminders[0];
              const notificationConfig = internalNotificationKindConfig(
                notification.kind,
                {
                  body: notification.body,
                  title: notification.title,
                }
              );
              const notificationLabel = notificationConfig.label;
              const isInformational = notificationConfig.informational === true;
              const receivedAt = fmtDate(notification.created_at);
              const dueAt = fmtDate(notification.due_at);
              const latestReminderAt = fmtDate(latestReminder?.created_at);
              const nextReminderAt = fmtDate(
                nextReminderEstimate(
                  latestReminder?.created_at ?? notification.lastReminderAt,
                  notification.created_at,
                  reminderCooldownHoursForNotificationKind(notification.kind)
                )
              );
              const lastRefreshedAt = fmtDate(notification.lastRefreshedAt);
              const dueBadge = dueBadgeState(notification.due_at);
              const reminderCadenceHours = reminderCooldownHoursForNotificationKind(
                notification.kind
              );
              const reminderCap = maxReminderAttemptsForNotificationKind(
                notification.kind
              );
              const escalationPolicy = escalationPolicyForNotificationKind(
                notification.kind
              );
              const remindersExpanded = Boolean(expandedReminderGroups[notification.id]);
              const inlineActionKind = pendingInlineActionKind(notification);
              const hasStructuredDecision = Boolean(inlineActionKind);
              const associatedActionUrl = normalizeNotificationActionUrl(
                notification.action_url
              );
              const showAssociatedAction = shouldShowAssociatedActionLink({
                kind: "internal_notification",
                notification_kind: notification.kind,
                action_url: notification.action_url,
                body: notification.body,
              });
              const primaryReviewHref = showAssociatedAction
                ? associatedActionUrl ?? notification.action_url
                : notification.caseId
                  ? caseActionUrl(notification.caseId)
                  : null;
              const primaryReviewLabel = showAssociatedAction
                ? pendingActionLinkLabel(
                    {
                      kind: "internal_notification",
                      notification_kind: notification.kind,
                      action_url: notification.action_url,
                    },
                    "action_url"
                  )
                : notificationConfig.reviewCtaLabel ?? "Revisar en flujo";
              // Informational notifications only need an acknowledge button.
              // Actionable cards show the review CTA and avoid an ambiguous
              // "Entendido" that competes with the real action; we only fall
              // back to acknowledge when there is no actionable destination.
              const showReviewCta =
                !hasStructuredDecision && !isInformational && Boolean(primaryReviewHref);
              const showAcknowledge =
                !hasStructuredDecision && (isInformational || !primaryReviewHref);
              const showSecondaryFlowLink =
                hasStructuredDecision && Boolean(primaryReviewHref);
              const isHitlReminder =
                notification.kind === TOOL_CONFIRMATION_PENDING_KIND;
              return (
                <div
                  key={notification.id}
                  ref={(element) => {
                    pendingItemRefs.current[notification.id] = element;
                    for (const reminder of reminders) {
                      pendingItemRefs.current[reminder.id] = element;
                    }
                  }}
                className={`min-w-0 rounded-2xl border bg-white p-3 text-xs dark:bg-white/5 ${
                  pendientesFocusId === notification.id
                    || reminders.some((reminder) => reminder.id === pendientesFocusId)
                    ? "border-violet-400 ring-2 ring-violet-300 dark:border-violet-300/40"
                    : "border-slate-200 dark:border-white/10"
                }`}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-semibold text-slate-900 dark:text-white">
                        {notificationLabel}
                      </p>
                      <span
                        className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${dueBadge.className}`}
                      >
                        {dueBadge.label}
                      </span>
                      {notification.escalatedAt ? (
                        <span className="rounded-full border border-fuchsia-200 bg-fuchsia-50 px-2 py-0.5 text-[10px] font-semibold text-fuchsia-700 dark:border-fuchsia-300/20 dark:bg-fuchsia-300/10 dark:text-fuchsia-100">
                          Escalado
                        </span>
                      ) : null}
                      {isHitlReminder ? (
                        <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:border-amber-300/20 dark:bg-amber-300/10 dark:text-amber-100">
                          HITL
                        </span>
                      ) : null}
                      {reminders.length > 0 ? (
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedReminderGroups((current) => ({
                              ...current,
                              [notification.id]: !current[notification.id],
                            }))
                          }
                          className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700 ring-1 ring-amber-100 hover:bg-amber-100 dark:bg-amber-300/10 dark:text-amber-100 dark:ring-amber-300/20 dark:hover:bg-amber-300/20"
                        >
                          {reminders.length} recordatorio{reminders.length === 1 ? "" : "s"}
                          {remindersExpanded ? " · ocultar" : " · ver"}
                        </button>
                      ) : null}
                    </div>
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
                    {isHitlReminder ? (
                      <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-100/80">
                        Hay acciones del agente esperando tu aprobación humana
                        antes de continuar el flujo.
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
                      Recibido: {receivedAt ?? "fecha no disponible"} · Prioridad:{" "}
                      {notification.priority}
                      {dueAt ? ` · vence ${dueAt}` : ""}
                      {latestReminderAt ? ` · último recordatorio ${latestReminderAt}` : ""}
                      {nextReminderAt ? ` · próximo recordatorio aprox. ${nextReminderAt}` : ""}
                      {notification.refreshCount && notification.refreshCount > 0
                        ? ` · actualizada ${notification.refreshCount} ${notification.refreshCount === 1 ? "vez" : "veces"}${lastRefreshedAt ? ` · última actualización ${lastRefreshedAt}` : ""}`
                        : ""}
                    </p>
                    <p className="mt-1 text-[11px] text-slate-500 dark:text-white/60">
                      Recordatorios cada {reminderCadenceHours}h
                      {reminderCap ? ` · escala tras ${reminderCap} recordatorios` : ""}
                      {escalationPolicy.escalateAfterHours
                        ? ` o ${escalationPolicy.escalateAfterHours}h`
                        : ""}
                      {notification.escalationReason
                        ? ` · motivo de escalación: ${notification.escalationReason}`
                        : ""}
                    </p>
                    {remindersExpanded ? (
                      <div className="mt-2 rounded-2xl border border-amber-100 bg-amber-50/60 p-2 text-[11px] text-amber-900 dark:border-amber-300/20 dark:bg-amber-300/10 dark:text-amber-100">
                        <p className="font-semibold">
                          Historial de recordatorios
                        </p>
                        <div className="mt-1 space-y-1.5">
                          {reminders.map((reminder) => (
                            <div
                              key={reminder.id}
                              className="rounded-xl bg-white/70 p-2 dark:bg-white/5"
                            >
                              <p className="font-medium">
                                {fmtDate(reminder.created_at) ??
                                  "fecha no disponible"}
                              </p>
                              <div className="prose prose-sm mt-1 max-w-none break-words text-amber-900 dark:text-amber-100 prose-p:my-1">
                                <ReactMarkdown>
                                  {prepareNotificationBodyMarkdown(reminder.body)}
                                </ReactMarkdown>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                    {inlineActionKind === "price_approval" ? (
                      <div className="mt-3 space-y-2 rounded-2xl border border-amber-100 bg-amber-50/70 p-2 dark:border-amber-300/20 dark:bg-amber-300/10">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-700 dark:text-amber-100">
                          Aprobación de precio
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
                            Ajustar
                          </button>
                        </div>
                        {notificationActionStatus[notification.id] ? (
                          <p className="text-[11px] text-slate-500 dark:text-white/60">
                            {notificationActionStatus[notification.id]}
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                    {inlineActionKind === "listing_description_review" ? (
                      <div className="mt-3 space-y-2 rounded-2xl border border-emerald-100 bg-emerald-50/70 p-2 dark:border-emerald-300/20 dark:bg-emerald-300/10">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-700 dark:text-emerald-100">
                          Revisión de descripción
                        </p>
                        <button
                          type="button"
                          onClick={() =>
                            void submitListingDescriptionReviewDecision(notification.id, {
                              action: "approve",
                            })
                          }
                          className="rounded-full bg-emerald-600 px-2 py-1 font-semibold text-white hover:bg-emerald-700"
                        >
                          Aprobar descripción
                        </button>
                        <div className="flex flex-col gap-1 sm:flex-row">
                          <input
                            value={notificationInputs[notification.id] ?? ""}
                            onChange={(event) =>
                              setNotificationInputs((current) => ({
                                ...current,
                                [notification.id]: event.target.value,
                              }))
                            }
                            placeholder="Ej. Hazlo más corto, agrega puntos clave o pega una versión exacta"
                            className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs outline-none focus:border-violet-300 dark:border-white/10 dark:bg-slate-950"
                          />
                          <button
                            type="button"
                            onClick={() => {
                              const notes = (notificationInputs[notification.id] ?? "").trim();
                              if (!notes) {
                                setNotificationActionStatus((current) => ({
                                  ...current,
                                  [notification.id]:
                                    "Escribe los cambios o usa 'Aprobar descripción'.",
                                }));
                                return;
                              }
                              void submitListingDescriptionReviewDecision(notification.id, {
                                text: notes,
                              });
                            }}
                            className="rounded-xl border border-emerald-200 px-3 py-2 font-semibold text-emerald-700 hover:bg-emerald-50 dark:border-emerald-300/20 dark:text-emerald-100"
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
                    {inlineActionKind === "comparables_search_expansion_decision" ? (
                      <div className="mt-3 space-y-2 rounded-2xl border border-cyan-100 bg-cyan-50/70 p-2 dark:border-cyan-300/20 dark:bg-cyan-300/10">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-cyan-700 dark:text-cyan-100">
                          Decisión de comparables
                        </p>
                        <div className="flex flex-wrap gap-1">
                          <button
                            type="button"
                            onClick={() =>
                              void submitComparablesExpansionDecision(notification.id, {
                                action: "use_current_comparables",
                              })
                            }
                            className="rounded-full bg-violet-600 px-2 py-1 font-semibold text-white hover:bg-violet-700"
                          >
                            1) Muestra actual
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              void submitComparablesExpansionDecision(notification.id, {
                                action: "use_avaclick_primary",
                              })
                            }
                            className="rounded-full bg-blue-600 px-2 py-1 font-semibold text-white hover:bg-blue-700"
                          >
                            2) Avaclick base
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              void submitComparablesExpansionDecision(notification.id, {
                                action: "expand_search",
                              })
                            }
                            className="rounded-full bg-slate-700 px-2 py-1 font-semibold text-white hover:bg-slate-800"
                          >
                            3) Ampliar búsqueda
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
                            placeholder="Opcional: responde 1, 2, 3 o texto corto"
                            className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs outline-none focus:border-violet-300 dark:border-white/10 dark:bg-slate-950"
                          />
                          <button
                            type="button"
                            onClick={() =>
                              void submitComparablesExpansionDecision(notification.id, {
                                text: notificationInputs[notification.id] ?? "",
                              })
                            }
                            className="rounded-xl border border-violet-200 px-3 py-2 font-semibold text-violet-700 hover:bg-violet-50 dark:border-violet-300/20 dark:text-violet-100"
                          >
                            Enviar texto
                          </button>
                        </div>
                        {notificationActionStatus[notification.id] ? (
                          <p className="text-[11px] text-slate-500 dark:text-white/60">
                            {notificationActionStatus[notification.id]}
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                    {inlineActionKind === "contract_review" ? (
                      <div className="mt-3 space-y-2 rounded-2xl border border-violet-100 bg-violet-50/70 p-2 dark:border-violet-300/20 dark:bg-violet-300/10">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-violet-700 dark:text-violet-100">
                          Revisión de contrato
                        </p>
                        <button
                          type="button"
                          onClick={() =>
                            void submitContractReviewDecision(notification.id, {
                              action: "approve_send",
                            })
                          }
                          className="rounded-full bg-emerald-600 px-2 py-1 font-semibold text-white hover:bg-emerald-700"
                        >
                          Enviar por email
                        </button>
                        <div className="flex flex-col gap-1 sm:flex-row">
                          <input
                            value={notificationInputs[notification.id] ?? ""}
                            onChange={(event) =>
                              setNotificationInputs((current) => ({
                                ...current,
                                [notification.id]: event.target.value,
                              }))
                            }
                            placeholder="Opcional: comentario para la version corregida"
                            className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs outline-none focus:border-violet-300 dark:border-white/10 dark:bg-slate-950"
                          />
                          <button
                            type="button"
                            onClick={() => {
                              const notes = (notificationInputs[notification.id] ?? "").trim();
                              void submitContractReviewDecision(notification.id, {
                                action: "request_changes",
                                text: notes || "subir contrato corregido y enviar",
                              });
                            }}
                            className="rounded-xl border border-violet-200 px-3 py-2 font-semibold text-violet-700 hover:bg-violet-50 dark:border-violet-300/20 dark:text-violet-100"
                          >
                            Subir contrato corregido y enviar
                          </button>
                        </div>
                        {notificationActionStatus[notification.id] ? (
                          <p className="text-[11px] text-slate-500 dark:text-white/60">
                            {notificationActionStatus[notification.id]}
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                    {inlineActionKind === "contract_data_review" ? (
                      <div className="mt-3 space-y-2 rounded-2xl border border-amber-100 bg-amber-50/70 p-2 dark:border-amber-300/20 dark:bg-amber-300/10">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-700 dark:text-amber-100">
                          Datos contractuales faltantes
                        </p>
                        <div className="flex flex-col gap-1 sm:flex-row">
                          <input
                            value={notificationInputs[notification.id] ?? ""}
                            onChange={(event) =>
                              setNotificationInputs((current) => ({
                                ...current,
                                [notification.id]: event.target.value,
                              }))
                            }
                            placeholder="Correo del comitente, ej. maria.castaneda@example.com"
                            className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs outline-none focus:border-violet-300 dark:border-white/10 dark:bg-slate-950"
                          />
                          <button
                            type="button"
                            onClick={() => {
                              const email = (notificationInputs[notification.id] ?? "").trim();
                              if (!email) {
                                setNotificationActionStatus((current) => ({
                                  ...current,
                                  [notification.id]:
                                    "Escribe el correo del comitente para continuar.",
                                }));
                                return;
                              }
                              void submitContractDataReviewDecision(notification.id, {
                                text: email,
                              });
                            }}
                            className="rounded-xl border border-violet-200 px-3 py-2 font-semibold text-violet-700 hover:bg-violet-50 dark:border-violet-300/20 dark:text-violet-100"
                          >
                            Guardar y continuar
                          </button>
                        </div>
                        {notificationActionStatus[notification.id] ? (
                          <p className="text-[11px] text-slate-500 dark:text-white/60">
                            {notificationActionStatus[notification.id]}
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                    {inlineActionKind === "property_data_review" ? (
                      <div className="mt-3 space-y-2 rounded-2xl border border-sky-100 bg-sky-50/70 p-2 dark:border-sky-300/20 dark:bg-sky-300/10">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-sky-700 dark:text-sky-100">
                          Revisión de datos
                        </p>
                        <button
                          type="button"
                          onClick={() =>
                            void submitPropertyDataReviewDecision(notification.id, {
                              action: "confirm",
                            })
                          }
                          className="rounded-full bg-emerald-600 px-2 py-1 font-semibold text-white hover:bg-emerald-700"
                        >
                          Confirmar datos
                        </button>
                        <div className="flex flex-col gap-1 sm:flex-row">
                          <input
                            value={notificationInputs[notification.id] ?? ""}
                            onChange={(event) =>
                              setNotificationInputs((current) => ({
                                ...current,
                                [notification.id]: event.target.value,
                              }))
                            }
                            placeholder="Ej. Tipo: Terreno · Operación: Venta · Zona: Bucerías"
                            className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs outline-none focus:border-violet-300 dark:border-white/10 dark:bg-slate-950"
                          />
                          <button
                            type="button"
                            onClick={() => {
                              const notes = (notificationInputs[notification.id] ?? "").trim();
                              if (!notes) {
                                setNotificationActionStatus((current) => ({
                                  ...current,
                                  [notification.id]:
                                    "Escribe una corrección o usa 'Confirmar datos'.",
                                }));
                                return;
                              }
                              void submitPropertyDataReviewDecision(notification.id, {
                                text: notes,
                              });
                            }}
                            className="rounded-xl border border-sky-200 px-3 py-2 font-semibold text-sky-700 hover:bg-sky-50 dark:border-sky-300/20 dark:text-sky-100"
                          >
                            Enviar corrección
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
                    {showReviewCta && primaryReviewHref ? (
                      <a
                        href={primaryReviewHref}
                        target={
                          primaryReviewHref.startsWith("/") ? undefined : "_blank"
                        }
                        rel={
                          primaryReviewHref.startsWith("/")
                            ? undefined
                            : "noopener noreferrer"
                        }
                        className="rounded-full bg-violet-700 px-2 py-1 font-semibold text-white hover:bg-violet-800"
                      >
                        {primaryReviewLabel}
                      </a>
                    ) : null}
                    {showSecondaryFlowLink && primaryReviewHref ? (
                      <a
                        href={primaryReviewHref}
                        target={
                          primaryReviewHref.startsWith("/") ? undefined : "_blank"
                        }
                        rel={
                          primaryReviewHref.startsWith("/")
                            ? undefined
                            : "noopener noreferrer"
                        }
                        className="rounded-full border border-violet-200 px-2 py-1 font-semibold text-violet-700 hover:bg-violet-50 dark:border-violet-300/20 dark:text-violet-100 dark:hover:bg-violet-300/10"
                      >
                        Ver en flujo
                      </a>
                    ) : null}
                    {showAcknowledge ? (
                      <button
                        type="button"
                        onClick={() =>
                          void updateNotificationStatus(notification.id, "read")
                        }
                        className="rounded-full border border-slate-200 px-2 py-1 font-semibold text-slate-600 hover:bg-slate-50 dark:border-white/10 dark:text-white/70"
                      >
                        Entendido
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
              );
            })}
          </div>
        )}
      </div>
      {showResolved ? (
        <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50/70 p-3 dark:border-white/10 dark:bg-white/[0.04]">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-white/70">
              Atendidos recientes
            </h3>
            <span className="text-[11px] text-slate-400 dark:text-white/40">
              Historial restaurable desde Opciones → Limpiar bandeja.
            </span>
          </div>
          {resolvedLoading ? (
            <p className="mt-2 text-xs text-slate-500 dark:text-white/50">
              Cargando...
            </p>
          ) : resolvedNotificationGroups.length === 0 ? (
            <p className="mt-2 text-xs text-slate-500 dark:text-white/50">
              No hay pendientes atendidos recientemente.
            </p>
          ) : (
            <ul className="mt-2 space-y-2">
              {resolvedNotificationGroups.map((group) => {
                const notification = group.representative;
                const resolvedLabel = internalNotificationKindConfig(
                  notification.kind,
                  { body: notification.body, title: notification.title }
                ).label;
                const resolvedAt = formatDateTime(notification.updated_at);
                const statusLabel =
                  notification.status === "actioned"
                    ? "Atendida"
                    : notification.status === "dismissed"
                      ? "Ocultada"
                      : "Leída";
                return (
                  <li
                    key={group.key}
                    className="flex items-start justify-between gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2 dark:border-white/10 dark:bg-slate-950/40"
                  >
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 text-xs font-semibold text-slate-800 dark:text-white/80">
                        <span className="truncate">{resolvedLabel}</span>
                        {group.notifications.length > 1 ? (
                          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-500 dark:bg-white/10 dark:text-white/60">
                            {group.notifications.length} registros similares
                          </span>
                        ) : null}
                      </p>
                      {notification.caseContextLine ? (
                        <p className="truncate text-[11px] text-slate-500 dark:text-white/50">
                          {notification.caseContextLine}
                        </p>
                      ) : null}
                      <p className="text-[11px] text-slate-400 dark:text-white/40">
                        {statusLabel}
                        {resolvedAt ? ` · ${resolvedAt}` : ""}
                        {group.notifications.length > 1
                          ? " · se muestra el más reciente"
                          : ""}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void restoreNotification(notification.id)}
                      className="shrink-0 rounded-full border border-violet-200 px-3 py-1 text-xs font-semibold text-violet-700 hover:bg-violet-50 dark:border-violet-300/20 dark:text-violet-100"
                    >
                      {group.notifications.length > 1 ? "Restaurar último" : "Restaurar"}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}
