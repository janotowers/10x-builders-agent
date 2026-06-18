import {
  createServerClient,
  getOperationalCase,
  getRecentOperationalCaseEvents,
} from "@agents/db";
import {
  deleteSettingsTestInternalNotificationsForCase,
  rejectSettingsTestPendingToolCallsForCase,
} from "@agents/db";
import type {
  InternalUserNotification,
  OperationalCaseEvent,
  ToolCall,
} from "@agents/types";
import { internalNotificationKindConfig } from "@/lib/internal-notifications/registry";
import type { SettingsTestCleanupTarget } from "@/lib/operational-cases/settings-test-history-ui";
import { normalizeNotificationActionUrl } from "@/lib/notifications/pending-action-display";

type Db = ReturnType<typeof createServerClient>;

export type SettingsTestPendingAction =
  | {
      id: string;
      kind: "tool_confirmation";
      label: string;
      status: "pending_confirmation";
      created_at: string;
      tool_call_id: string;
      tool_name: string;
      session_id: string;
      case_id: string;
      channel: "chat_or_telegram";
      recommended_channel: "chat_or_telegram" | "telegram";
      blocking: boolean;
      telegram_delivered?: boolean;
      args_preview: Record<string, unknown>;
    }
  | {
      id: string;
      kind: "internal_notification";
      label: string;
      status: InternalUserNotification["status"];
      created_at: string;
      notification_id: string;
      notification_kind: string;
      case_id: string;
      channel: "pending_inbox";
      recommended_channel: "pending_inbox" | "telegram";
      blocking: boolean;
      telegram_delivered?: boolean;
      body: string;
      action_url: string | null;
      pending_tool_call_id?: string | null;
    };

export type SettingsTestPendingActionsResult = {
  pendingActions: SettingsTestPendingAction[];
  blockingActions: SettingsTestPendingAction[];
  historicalActions: SettingsTestPendingAction[];
};

export type { SettingsTestCleanupTarget };

export async function cleanupSettingsTestCaseHistory(
  db: Db,
  params: {
    userId: string;
    caseId: string;
    target: SettingsTestCleanupTarget;
    events?: OperationalCaseEvent[];
    /** Rechaza también aprobaciones que aún bloquean (limpieza agresiva). */
    rejectBlockingToolCalls?: boolean;
  }
): Promise<{ deleted_notifications: number; rejected_tool_calls: number }> {
  const { userId, caseId, target, events, rejectBlockingToolCalls = false } = params;
  let deleted_notifications = 0;
  let rejected_tool_calls = 0;

  const blockingToolCallIds: string[] = [];
  if ((target === "tool_calls" || target === "all") && !rejectBlockingToolCalls) {
    const pendingResult = await buildSettingsTestPendingActions(db, {
      caseId,
      userId,
      events,
    });
    for (const action of pendingResult.blockingActions) {
      if (action.kind === "tool_confirmation") {
        blockingToolCallIds.push(action.tool_call_id);
      }
    }
  }

  if (target === "notifications" || target === "all") {
    deleted_notifications = await deleteSettingsTestInternalNotificationsForCase(
      db,
      userId,
      caseId
    );
  }

  if (target === "tool_calls" || target === "all") {
    rejected_tool_calls = await rejectSettingsTestPendingToolCallsForCase(
      db,
      userId,
      caseId,
      { excludeToolCallIds: blockingToolCallIds }
    );
  }

  return { deleted_notifications, rejected_tool_calls };
}

/** Inicio del recorrido E2E actual (regenerar datos o validar intake). */
export function settingsTestPlaythroughAnchorAt(
  context: Record<string, unknown> | null | undefined
): string | null {
  const value = context?.controlled_test_playthrough_anchor_at;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function channelDeliveredOk(
  deliveredChannels: Record<string, unknown> | null | undefined,
  channel: string
): boolean {
  const entry = deliveredChannels?.[channel];
  if (!entry || typeof entry !== "object") return false;
  return (entry as { ok?: unknown }).ok === true;
}

export async function listCaseRunnerSessionIds(
  db: Db,
  userId: string
): Promise<Set<string>> {
  const { data, error } = await db
    .from("agent_sessions")
    .select("id")
    .eq("user_id", userId)
    .eq("channel", "case_runner")
    .eq("status", "active");
  if (error) {
    console.warn("[settings-test-pending-actions] case_runner sessions failed:", error);
    return new Set();
  }
  return new Set(
    (data ?? [])
      .map((row: { id?: unknown }) => row.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0)
  );
}

export function lastTransitionStartedAt(
  events: OperationalCaseEvent[]
): string | null {
  const e2eEvents = events.filter((event) => {
    const payload = event.payload_jsonb as Record<string, unknown> | null;
    return payload?.kind === "controlled_test_e2e_started";
  });
  if (e2eEvents.length === 0) return null;
  return e2eEvents[e2eEvents.length - 1]?.created_at ?? null;
}

export function partitionSettingsTestPendingActions(params: {
  actions: SettingsTestPendingAction[];
  lastTransitionAt: string | null;
  caseRunnerSessionIds: Set<string>;
}): { blockingActions: SettingsTestPendingAction[]; historicalActions: SettingsTestPendingAction[] } {
  const { actions, lastTransitionAt, caseRunnerSessionIds } = params;
  const unreadNotifications = actions.filter(
    (action): action is Extract<SettingsTestPendingAction, { kind: "internal_notification" }> =>
      action.kind === "internal_notification"
  );
  const latestUnreadNotification = unreadNotifications[0] ?? null;
  const lastTransitionMs = lastTransitionAt
    ? new Date(lastTransitionAt).getTime()
    : null;
  const withinCurrentWindow = (createdAt: string) =>
    lastTransitionMs === null ||
    new Date(createdAt).getTime() > lastTransitionMs;
  const blockingToolCallIds = new Set<string>();

  for (const action of actions) {
    if (action.kind !== "tool_confirmation") continue;
    const blocking =
      caseRunnerSessionIds.has(action.session_id) &&
      action.status === "pending_confirmation" &&
      withinCurrentWindow(action.created_at);
    if (blocking) blockingToolCallIds.add(action.tool_call_id);
  }
  const hasBlockingToolConfirmation = blockingToolCallIds.size > 0;

  const blockingActions: SettingsTestPendingAction[] = [];
  const historicalActions: SettingsTestPendingAction[] = [];

  for (const action of actions) {
    let blocking = false;
    const createdWithinWindow = withinCurrentWindow(action.created_at);

    if (action.kind === "tool_confirmation") {
      blocking =
        caseRunnerSessionIds.has(action.session_id) &&
        action.status === "pending_confirmation" &&
        createdWithinWindow;
    } else if (action.kind === "internal_notification") {
      const isCaseUpdateNotification = action.notification_kind === "case_update";
      const hasBusinessDecision = Boolean(
        internalNotificationKindConfig(action.notification_kind, {
          body: action.body,
          title: action.label,
        }).businessDecision
      );
      const isHitlShadow =
        action.notification_kind === "tool_confirmation_pending" &&
        ((action.pending_tool_call_id &&
          blockingToolCallIds.has(action.pending_tool_call_id)) ||
          hasBlockingToolConfirmation);
      const isLatestUnread = latestUnreadNotification?.id === action.id;
      blocking =
        !isHitlShadow &&
        !isCaseUpdateNotification &&
        action.status === "unread" &&
        createdWithinWindow &&
        (hasBusinessDecision || (isLatestUnread && lastTransitionMs !== null));
    }

    const withBlocking = { ...action, blocking };
    if (blocking) {
      blockingActions.push(withBlocking);
    } else {
      historicalActions.push(withBlocking);
    }
  }

  return { blockingActions, historicalActions };
}

export const SETTINGS_TEST_TOOL_CALLS_DEFAULT_LIMIT = 200;
export const SETTINGS_TEST_LAB_EVENTS_MAX = 500;

function filterItemsSince<T extends { created_at: string }>(
  items: T[],
  since: string | null | undefined
): T[] {
  if (!since) return items;
  const sinceMs = new Date(since).getTime();
  return items.filter((item) => new Date(item.created_at).getTime() > sinceMs);
}

function mergeToolCallsById(
  rows: ToolCall[],
  extra: ToolCall[]
): ToolCall[] {
  const byId = new Map<string, ToolCall>();
  for (const row of [...rows, ...extra]) {
    if (row?.id) byId.set(row.id, row);
  }
  return [...byId.values()].sort(
    (a, b) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );
}

export async function listSettingsTestE2EStartEvents(
  db: Db,
  caseId: string,
  playthroughAnchorAt?: string | null,
  limit = 100
): Promise<OperationalCaseEvent[]> {
  let query = db
    .from("operational_case_events")
    .select("*")
    .eq("case_id", caseId)
    .eq("payload_jsonb->>kind", "controlled_test_e2e_started")
    .order("created_at", { ascending: true })
    .limit(Math.max(1, limit));
  if (playthroughAnchorAt) {
    query = query.gt("created_at", playthroughAnchorAt);
  }
  const { data, error } = await query;
  if (error) {
    console.warn(
      "[settings-test-pending-actions] e2e start events lookup failed:",
      error
    );
    return [];
  }
  return (data ?? []) as OperationalCaseEvent[];
}

/** Eventos del caso para resumen/auditoría del laboratorio (ventana acotada al recorrido). */
export async function listSettingsTestCaseEventsForLab(
  db: Db,
  caseId: string,
  opts?: { since?: string | null; limit?: number }
): Promise<OperationalCaseEvent[]> {
  const limit = Math.min(
    opts?.limit ?? SETTINGS_TEST_LAB_EVENTS_MAX,
    SETTINGS_TEST_LAB_EVENTS_MAX
  );
  if (!opts?.since) {
    return getRecentOperationalCaseEvents(db, caseId, 200);
  }
  const { data, error } = await db
    .from("operational_case_events")
    .select("*")
    .eq("case_id", caseId)
    .gte("created_at", opts.since)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) {
    console.warn(
      "[settings-test-pending-actions] lab events lookup failed:",
      error
    );
    return getRecentOperationalCaseEvents(db, caseId, 200);
  }
  return (data ?? []) as OperationalCaseEvent[];
}

export async function listSettingsTestToolCallsForCase(
  db: Db,
  caseId: string,
  opts: { limit?: number; since?: string | null } = {}
): Promise<ToolCall[]> {
  const limit = opts.limit ?? SETTINGS_TEST_TOOL_CALLS_DEFAULT_LIMIT;
  const [argsResult, metaResult] = await Promise.all([
    db
      .from("tool_calls")
      .select("*")
      .contains("arguments_json", { case_id: caseId })
      .order("created_at", { ascending: false })
      .limit(limit),
    db
      .from("tool_calls")
      .select("*")
      .eq("metadata_jsonb->>case_id", caseId)
      .order("created_at", { ascending: false })
      .limit(limit),
  ]);
  if (argsResult.error) {
    console.warn(
      "[settings-test-pending-actions] tool_calls args lookup failed:",
      argsResult.error
    );
  }
  if (metaResult.error) {
    console.warn(
      "[settings-test-pending-actions] tool_calls metadata lookup failed:",
      metaResult.error
    );
  }
  if (argsResult.error && metaResult.error) return [];
  const merged = mergeToolCallsById(
    (argsResult.data ?? []) as ToolCall[],
    (metaResult.data ?? []) as ToolCall[]
  );
  return filterItemsSince(merged.slice(0, limit), opts.since);
}

export async function listSettingsTestInternalNotificationsForCase(
  db: Db,
  caseId: string,
  opts: { statuses?: InternalUserNotification["status"][]; limit?: number } = {}
): Promise<InternalUserNotification[]> {
  let query = db
    .from("internal_user_notifications")
    .select("*")
    .eq("case_id", caseId)
    .order("created_at", { ascending: false })
    .limit(opts.limit ?? 20);
  if (opts.statuses && opts.statuses.length > 0) {
    query = query.in("status", opts.statuses);
  }
  const { data, error } = await query;
  if (error) {
    console.warn(
      "[settings-test-pending-actions] internal notifications lookup failed:",
      error
    );
    return [];
  }
  return (data ?? []) as InternalUserNotification[];
}

export function transitionCountFromEvents(events: OperationalCaseEvent[]) {
  return events.filter((event) => {
    const payload = event.payload_jsonb as Record<string, unknown> | null;
    return payload?.kind === "controlled_test_e2e_started";
  }).length;
}

/** Cuenta transiciones E2E reales sin depender de un subconjunto acotado de eventos. */
export async function countSettingsTestE2ETransitions(
  db: Db,
  caseId: string,
  playthroughAnchorAt?: string | null
): Promise<number> {
  let query = db
    .from("operational_case_events")
    .select("id", { count: "exact", head: true })
    .eq("case_id", caseId)
    .eq("payload_jsonb->>kind", "controlled_test_e2e_started");
  if (playthroughAnchorAt) {
    query = query.gt("created_at", playthroughAnchorAt);
  }
  const { count, error } = await query;
  if (error) {
    console.warn(
      "[settings-test-pending-actions] transition count lookup failed:",
      error
    );
    return 0;
  }
  return count ?? 0;
}

export async function lastSettingsTestE2ETransitionAt(
  db: Db,
  caseId: string,
  playthroughAnchorAt?: string | null
): Promise<string | null> {
  let query = db
    .from("operational_case_events")
    .select("created_at")
    .eq("case_id", caseId)
    .eq("payload_jsonb->>kind", "controlled_test_e2e_started");
  if (playthroughAnchorAt) {
    query = query.gt("created_at", playthroughAnchorAt);
  }
  const { data, error } = await query
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.warn(
      "[settings-test-pending-actions] last transition lookup failed:",
      error
    );
    return null;
  }
  return (data as { created_at?: string } | null)?.created_at ?? null;
}

export async function buildSettingsTestPendingActions(
  db: Db,
  params: {
    caseId: string;
    userId: string;
    toolCalls?: ToolCall[];
    events?: OperationalCaseEvent[];
    telegramSentForToolCallId?: string | null;
  }
): Promise<SettingsTestPendingActionsResult> {
  const toolCalls =
    params.toolCalls ??
    (await listSettingsTestToolCallsForCase(db, params.caseId));
  const caseRunnerSessionIds = await listCaseRunnerSessionIds(db, params.userId);

  const pendingToolActions: SettingsTestPendingAction[] = toolCalls
    .filter((call) => call.status === "pending_confirmation")
    .map((call) => ({
      id: `tool:${call.id}`,
      kind: "tool_confirmation" as const,
      label: call.tool_name,
      status: "pending_confirmation" as const,
      created_at: call.created_at,
      tool_call_id: call.id,
      tool_name: call.tool_name,
      session_id: call.session_id,
      case_id: params.caseId,
      channel: "chat_or_telegram" as const,
      recommended_channel: "chat_or_telegram" as const,
      blocking: false,
      telegram_delivered:
        params.telegramSentForToolCallId === call.id ? true : undefined,
      args_preview: call.arguments_json ?? {},
    }));

  const notifications = await listSettingsTestInternalNotificationsForCase(
    db,
    params.caseId,
    { statuses: ["unread"], limit: 500 }
  );
  const pendingNotificationActions: SettingsTestPendingAction[] = notifications.map(
    (notification) => ({
      id: `notification:${notification.id}`,
      kind: "internal_notification" as const,
      label: notification.title || notification.kind,
      status: notification.status,
      created_at: notification.created_at,
      notification_id: notification.id,
      notification_kind: notification.kind,
      case_id: params.caseId,
      channel: "pending_inbox" as const,
      recommended_channel: channelDeliveredOk(
        notification.delivered_channels_jsonb,
        "telegram"
      )
        ? ("telegram" as const)
        : ("pending_inbox" as const),
      blocking: false,
      telegram_delivered: channelDeliveredOk(
        notification.delivered_channels_jsonb,
        "telegram"
      ),
      body: notification.body,
      action_url: normalizeNotificationActionUrl(notification.action_url),
      pending_tool_call_id:
        typeof notification.metadata_jsonb?.pending_tool_call_id === "string" &&
        notification.metadata_jsonb.pending_tool_call_id.trim()
          ? notification.metadata_jsonb.pending_tool_call_id.trim()
          : null,
    })
  );

  const pendingActions = [...pendingToolActions, ...pendingNotificationActions].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );

  const opCase = await getOperationalCase(db, params.caseId);
  const playthroughAnchorAt = settingsTestPlaythroughAnchorAt(
    opCase?.context_jsonb
  );
  const lastTransitionAt = await lastSettingsTestE2ETransitionAt(
    db,
    params.caseId,
    playthroughAnchorAt
  );

  const { blockingActions, historicalActions } = partitionSettingsTestPendingActions({
    actions: pendingActions,
    lastTransitionAt,
    caseRunnerSessionIds,
  });

  return { pendingActions, blockingActions, historicalActions };
}
