import {
  countInternalUserNotifications,
  createServerClient,
  listInternalUserNotifications,
  listResolvedInternalUserNotifications,
} from "@agents/db";
import type { InternalUserNotification } from "@agents/types";
import { hiddenInboxNotificationKinds } from "@/lib/internal-notifications/registry";
import {
  formatPendingCaseContextLine,
  loadCaseContextMap,
} from "@/lib/notifications/enrich-case-context";
import {
  describeToolConfirmationAction,
  normalizeNotificationActionUrl,
} from "@/lib/notifications/pending-action-display";
import {
  computePendingInboxVisibleCounts,
  REMINDER_KIND,
} from "@/lib/notifications/pending-inbox-dedupe";
import type { PendingInboxCounts } from "@/lib/notifications/pending-inbox-types";

const NOTIFICATION_ROW_LIMIT = 50;
const TOOL_CONFIRMATION_LIMIT = 50;

export type PendingInboxNotification = {
  id: string;
  kind: string;
  title: string;
  body: string;
  priority: "low" | "normal" | "high";
  action_url: string | null;
  due_at: string | null;
  created_at: string;
  caseId?: string | null;
  caseTitle?: string | null;
  caseStep?: string | null;
  caseStepLabel?: string | null;
  caseStatus?: string | null;
  caseStatusLabel?: string | null;
  caseContextLine?: string | null;
  sourceNotificationId?: string | null;
  lastReminderAt?: string | null;
  reminderCount?: number | null;
  escalatedAt?: string | null;
  escalationReason?: string | null;
};

export type PendingInboxToolConfirmation = {
  toolCallId: string;
  sessionId: string;
  turnId?: string | null;
  toolName: string;
  args: Record<string, unknown>;
  status: string;
  createdAt: string;
  caseId?: string | null;
  caseTitle?: string | null;
  caseStep?: string | null;
  caseStepLabel?: string | null;
  caseStatus?: string | null;
  caseStatusLabel?: string | null;
  caseContextLine?: string | null;
  message: string;
};

type PendingToolCallRow = {
  id: string;
  session_id: string;
  turn_id?: string | null;
  tool_name: string;
  arguments_json?: Record<string, unknown> | null;
  metadata_jsonb?: Record<string, unknown> | null;
  status: string;
  created_at: string;
};

function toolCallCaseId(call: {
  arguments_json?: Record<string, unknown> | null;
  metadata_jsonb?: Record<string, unknown> | null;
}): string | null {
  const fromArgs =
    typeof call.arguments_json?.case_id === "string"
      ? call.arguments_json.case_id.trim()
      : "";
  if (fromArgs) return fromArgs;
  const fromMetadata =
    typeof call.metadata_jsonb?.case_id === "string"
      ? call.metadata_jsonb.case_id.trim()
      : "";
  return fromMetadata || null;
}

async function listCaseRunnerPendingConfirmations(
  db: ReturnType<typeof createServerClient>,
  userId: string,
  caseIdFilter?: string | null
) {
  const { data: sessions, error: sessionsError } = await db
    .from("agent_sessions")
    .select("id")
    .eq("user_id", userId)
    .eq("channel", "case_runner")
    .eq("status", "active");
  if (sessionsError) throw sessionsError;
  const sessionIds = (sessions ?? [])
    .map((session: { id?: unknown }) => session.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  if (sessionIds.length === 0) return [];

  const { data: toolCalls, error: toolCallsError } = await db
    .from("tool_calls")
    .select(
      "id, session_id, turn_id, tool_name, arguments_json, metadata_jsonb, status, created_at"
    )
    .in("session_id", sessionIds)
    .eq("status", "pending_confirmation")
    .order("created_at", { ascending: false })
    .limit(TOOL_CONFIRMATION_LIMIT);
  if (toolCallsError) throw toolCallsError;

  const mapped = (toolCalls ?? []).map(
    (call: PendingToolCallRow) => ({
      toolCallId: call.id,
      sessionId: call.session_id,
      turnId: call.turn_id ?? null,
      toolName: call.tool_name,
      args: call.arguments_json ?? {},
      status: call.status,
      createdAt: call.created_at,
      caseId: toolCallCaseId(call),
      message: describeToolConfirmationAction(call.tool_name),
    })
  );

  if (caseIdFilter) {
    return mapped.filter((item) => item.caseId === caseIdFilter);
  }
  return mapped;
}

function notificationStringMetadata(
  notification: InternalUserNotification,
  key: string
) {
  const value = notification.metadata_jsonb?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function notificationNumberMetadata(
  notification: InternalUserNotification,
  key: string
) {
  const value = notification.metadata_jsonb?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function includeReminderSourceNotifications(
  db: ReturnType<typeof createServerClient>,
  userId: string,
  notifications: InternalUserNotification[]
) {
  const sourceIds = [
    ...new Set(
      notifications
        .filter((notification) => notification.kind === REMINDER_KIND)
        .map((notification) =>
          notificationStringMetadata(notification, "source_notification_id")
        )
        .filter((id): id is string => Boolean(id))
    ),
  ];
  const existingIds = new Set(notifications.map((notification) => notification.id));
  const missingSourceIds = sourceIds.filter((id) => !existingIds.has(id));
  if (missingSourceIds.length === 0) return notifications;

  const { data, error } = await db
    .from("internal_user_notifications")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "unread")
    .in("id", missingSourceIds);
  if (error) throw error;
  return [...notifications, ...((data ?? []) as InternalUserNotification[])];
}

export async function loadPendingInboxSnapshot(
  userId: string,
  caseIdFilter?: string | null
): Promise<{
  notifications: PendingInboxNotification[];
  pendingToolConfirmations: PendingInboxToolConfirmation[];
  counts: PendingInboxCounts;
}> {
  const db = createServerClient();
  const excludedKinds = hiddenInboxNotificationKinds();
  const actionableExcludedKinds = [...excludedKinds, REMINDER_KIND];
  let notifications = await listInternalUserNotifications(db, userId, {
    statuses: ["unread"],
    excludeKinds: excludedKinds,
    limit: caseIdFilter ? 100 : NOTIFICATION_ROW_LIMIT,
  });
  if (caseIdFilter) {
    notifications = notifications.filter(
      (notification) => notification.case_id === caseIdFilter
    );
  }
  notifications = await includeReminderSourceNotifications(db, userId, notifications);

  const [pendingToolConfirmations, notificationRowsTotal] = await Promise.all([
      listCaseRunnerPendingConfirmations(db, userId, caseIdFilter),
      countInternalUserNotifications(db, userId, {
        statuses: ["unread"],
        excludeKinds: excludedKinds,
        caseId: caseIdFilter,
      }),
    ]);

  const caseIds = [
    ...notifications.map((n) => n.case_id),
    ...pendingToolConfirmations.map((p) => p.caseId),
  ].filter((id): id is string => typeof id === "string" && id.length > 0);
  const caseContextMap = await loadCaseContextMap(db, caseIds);

  const enrichedNotifications = notifications.map((notification) => {
    const context = notification.case_id
      ? caseContextMap.get(notification.case_id) ?? {
          caseId: notification.case_id,
          caseTitle: null,
          caseStep: null,
          caseStepLabel: null,
          caseStatus: null,
          caseStatusLabel: null,
        }
      : {
          caseId: null,
          caseTitle: null,
          caseStep: null,
          caseStepLabel: null,
          caseStatus: null,
          caseStatusLabel: null,
        };
    return {
      id: notification.id,
      kind: notification.kind,
      title: notification.title,
      body: notification.body,
      priority: notification.priority,
      action_url: normalizeNotificationActionUrl(notification.action_url),
      due_at: notification.due_at,
      created_at: notification.created_at,
      caseId: context.caseId,
      caseTitle: context.caseTitle,
      caseStep: context.caseStep,
      caseStepLabel: context.caseStepLabel,
      caseStatus: context.caseStatus,
      caseStatusLabel: context.caseStatusLabel,
      caseContextLine: formatPendingCaseContextLine(context),
      pendingToolCallId: notificationStringMetadata(
        notification,
        "pending_tool_call_id"
      ),
      sourceNotificationId: notificationStringMetadata(
        notification,
        "source_notification_id"
      ),
      lastReminderAt: notificationStringMetadata(notification, "last_reminder_at"),
      reminderCount: notificationNumberMetadata(notification, "reminder_count"),
      escalatedAt: notificationStringMetadata(notification, "escalated_at"),
      escalationReason: notificationStringMetadata(notification, "escalation_reason"),
      refreshCount: notificationNumberMetadata(notification, "refresh_count"),
      lastRefreshedAt: notificationStringMetadata(notification, "last_refreshed_at"),
    };
  });

  const enrichedPendingToolConfirmations = pendingToolConfirmations.map(
    (pending) => {
      const context = pending.caseId
        ? caseContextMap.get(pending.caseId) ?? {
            caseId: pending.caseId,
            caseTitle: null,
            caseStep: null,
            caseStepLabel: null,
            caseStatus: null,
            caseStatusLabel: null,
          }
        : {
            caseId: null,
            caseTitle: null,
            caseStep: null,
            caseStepLabel: null,
            caseStatus: null,
            caseStatusLabel: null,
          };
      return {
        ...pending,
        caseTitle: context.caseTitle,
        caseStep: context.caseStep,
        caseStepLabel: context.caseStepLabel,
        caseStatus: context.caseStatus,
        caseStatusLabel: context.caseStatusLabel,
        caseContextLine: formatPendingCaseContextLine(context),
      };
    }
  );

  const visibleCounts = computePendingInboxVisibleCounts(
    enrichedNotifications,
    enrichedPendingToolConfirmations,
    { hiddenKinds: new Set(excludedKinds) }
  );

  return {
    notifications: enrichedNotifications,
    pendingToolConfirmations: enrichedPendingToolConfirmations,
    counts: {
      notificationRowsTotal,
      ...visibleCounts,
    },
  };
}

export type ResolvedInboxNotification = PendingInboxNotification & {
  status: string;
  updated_at: string;
};

export async function loadResolvedInboxSnapshot(
  userId: string,
  limit = 20
): Promise<{ notifications: ResolvedInboxNotification[] }> {
  const db = createServerClient();
  const resolved = await listResolvedInternalUserNotifications(db, userId, {
    excludeKinds: hiddenInboxNotificationKinds(),
    limit,
  });

  const caseIds = resolved
    .map((notification) => notification.case_id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  const caseContextMap = await loadCaseContextMap(db, caseIds);

  const notifications = resolved.map((notification) => {
    const context = notification.case_id
      ? caseContextMap.get(notification.case_id) ?? {
          caseId: notification.case_id,
          caseTitle: null,
          caseStep: null,
          caseStepLabel: null,
          caseStatus: null,
          caseStatusLabel: null,
        }
      : {
          caseId: null,
          caseTitle: null,
          caseStep: null,
          caseStepLabel: null,
          caseStatus: null,
          caseStatusLabel: null,
        };
    return {
      id: notification.id,
      kind: notification.kind,
      title: notification.title,
      body: notification.body,
      priority: notification.priority,
      action_url: normalizeNotificationActionUrl(notification.action_url),
      due_at: notification.due_at,
      created_at: notification.created_at,
      status: notification.status,
      updated_at: notification.updated_at,
      caseId: context.caseId,
      caseTitle: context.caseTitle,
      caseStep: context.caseStep,
      caseStepLabel: context.caseStepLabel,
      caseStatus: context.caseStatus,
      caseStatusLabel: context.caseStatusLabel,
      caseContextLine: formatPendingCaseContextLine(context),
      sourceNotificationId:
        typeof notification.metadata_jsonb?.source_notification_id === "string"
          ? notification.metadata_jsonb.source_notification_id
          : null,
      lastReminderAt: null,
      refreshCount: notificationNumberMetadata(notification, "refresh_count"),
      lastRefreshedAt: notificationStringMetadata(notification, "last_refreshed_at"),
    };
  });

  return { notifications };
}
