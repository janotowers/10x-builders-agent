import type { PendingInboxCounts } from "@/lib/notifications/pending-inbox-types";

export const REMINDER_KIND = "internal_notification_reminder";
export const TOOL_CONFIRMATION_PENDING_KIND = "tool_confirmation_pending";

export type PendingInboxNotificationLike = {
  id: string;
  kind: string;
  caseId?: string | null;
  pendingToolCallId?: string | null;
  due_at?: string | null;
  sourceNotificationId?: string | null;
};

export type PendingToolConfirmationLike = {
  toolCallId: string;
  caseId?: string | null;
};

export type PendingHitlIndex = {
  caseIds: Set<string>;
  toolCallIds: Set<string>;
};

export function buildPendingHitlIndex(
  pendingToolConfirmations: PendingToolConfirmationLike[]
): PendingHitlIndex {
  return {
    caseIds: new Set(
      pendingToolConfirmations
        .map((pending) => pending.caseId)
        .filter((caseId): caseId is string => Boolean(caseId))
    ),
    toolCallIds: new Set(
      pendingToolConfirmations.map((pending) => pending.toolCallId)
    ),
  };
}

export function isHitlShadowNotification(
  notification: PendingInboxNotificationLike,
  index: PendingHitlIndex
): boolean {
  if (notification.kind !== TOOL_CONFIRMATION_PENDING_KIND) return false;
  if (
    notification.pendingToolCallId &&
    index.toolCallIds.has(notification.pendingToolCallId)
  ) {
    return true;
  }
  if (notification.caseId && index.caseIds.has(notification.caseId)) {
    return true;
  }
  return false;
}

export function isRenderableActionableNotification(
  notification: PendingInboxNotificationLike,
  index: PendingHitlIndex,
  hiddenKinds: Set<string>
): boolean {
  if (hiddenKinds.has(notification.kind)) return false;
  if (notification.kind === REMINDER_KIND) return false;
  if (isHitlShadowNotification(notification, index)) return false;
  return true;
}

export function listRenderableNotifications(
  notifications: PendingInboxNotificationLike[],
  pendingToolConfirmations: PendingToolConfirmationLike[],
  hiddenKinds: Set<string>
): PendingInboxNotificationLike[] {
  const index = buildPendingHitlIndex(pendingToolConfirmations);
  return notifications.filter((notification) =>
    isRenderableActionableNotification(notification, index, hiddenKinds)
  );
}

export function findHitlLinkedNotifications<
  T extends PendingInboxNotificationLike,
>(pending: PendingToolConfirmationLike, notifications: T[]): T[] {
  return notifications.filter(
    (notification) =>
      notification.kind === TOOL_CONFIRMATION_PENDING_KIND &&
      ((notification.pendingToolCallId &&
        notification.pendingToolCallId === pending.toolCallId) ||
        (notification.caseId &&
          pending.caseId &&
          notification.caseId === pending.caseId))
  );
}

function isOverdue(dueAt: string | null | undefined, now: number) {
  if (!dueAt) return false;
  const timestamp = new Date(dueAt).getTime();
  return !Number.isNaN(timestamp) && timestamp <= now;
}

export function computePendingInboxVisibleCounts(
  notifications: PendingInboxNotificationLike[],
  pendingToolConfirmations: PendingToolConfirmationLike[],
  opts: { hiddenKinds?: Set<string>; now?: number } = {}
): Pick<
  PendingInboxCounts,
  | "actionableNotificationsTotal"
  | "pendingToolConfirmationsTotal"
  | "flowRelatedTotal"
  | "overdueTotal"
  | "uniquePendingTotal"
> {
  const hiddenKinds = opts.hiddenKinds ?? new Set<string>();
  const now = opts.now ?? Date.now();
  const rendered = listRenderableNotifications(
    notifications,
    pendingToolConfirmations,
    hiddenKinds
  );

  const actionableNotificationsTotal = rendered.length;
  const pendingToolConfirmationsTotal = pendingToolConfirmations.length;
  const uniquePendingTotal =
    actionableNotificationsTotal + pendingToolConfirmationsTotal;
  const flowRelatedTotal =
    rendered.filter((notification) => Boolean(notification.caseId)).length +
    pendingToolConfirmations.filter((pending) => Boolean(pending.caseId)).length;

  let overdueTotal = rendered.filter((notification) =>
    isOverdue(notification.due_at, now)
  ).length;
  for (const pending of pendingToolConfirmations) {
    const linked = findHitlLinkedNotifications(pending, notifications);
    if (linked.some((notification) => isOverdue(notification.due_at, now))) {
      overdueTotal += 1;
    }
  }

  return {
    actionableNotificationsTotal,
    pendingToolConfirmationsTotal,
    flowRelatedTotal,
    overdueTotal,
    uniquePendingTotal,
  };
}
