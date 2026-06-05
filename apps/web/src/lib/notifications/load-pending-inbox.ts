import { createServerClient, listInternalUserNotifications } from "@agents/db";
import { hiddenInboxNotificationKinds } from "@/lib/internal-notifications/registry";
import {
  formatPendingCaseContextLine,
  loadCaseContextMap,
} from "@/lib/notifications/enrich-case-context";
import { normalizeNotificationActionUrl } from "@/lib/notifications/pending-action-display";

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
      "id, session_id, turn_id, tool_name, arguments_json, status, created_at"
    )
    .in("session_id", sessionIds)
    .eq("status", "pending_confirmation")
    .order("created_at", { ascending: false })
    .limit(20);
  if (toolCallsError) throw toolCallsError;

  const mapped = (toolCalls ?? []).map(
    (call: {
      id: string;
      session_id: string;
      turn_id?: string | null;
      tool_name: string;
      arguments_json?: Record<string, unknown> | null;
      status: string;
      created_at: string;
    }) => ({
      toolCallId: call.id,
      sessionId: call.session_id,
      turnId: call.turn_id ?? null,
      toolName: call.tool_name,
      args: call.arguments_json ?? {},
      status: call.status,
      createdAt: call.created_at,
      caseId:
        typeof call.arguments_json?.case_id === "string"
          ? call.arguments_json.case_id
          : null,
      message: `El agente solicita aprobación para ejecutar ${call.tool_name}.`,
    })
  );

  if (caseIdFilter) {
    return mapped.filter((item) => item.caseId === caseIdFilter);
  }
  return mapped;
}

export async function loadPendingInboxSnapshot(
  userId: string,
  caseIdFilter?: string | null
): Promise<{
  notifications: PendingInboxNotification[];
  pendingToolConfirmations: PendingInboxToolConfirmation[];
}> {
  const db = createServerClient();
  let notifications = await listInternalUserNotifications(db, userId, {
    statuses: ["unread"],
    excludeKinds: hiddenInboxNotificationKinds(),
    limit: caseIdFilter ? 50 : 20,
  });
  if (caseIdFilter) {
    notifications = notifications.filter(
      (notification) => notification.case_id === caseIdFilter
    );
  }

  const pendingToolConfirmations = await listCaseRunnerPendingConfirmations(
    db,
    userId,
    caseIdFilter
  );

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

  return {
    notifications: enrichedNotifications,
    pendingToolConfirmations: enrichedPendingToolConfirmations,
  };
}
