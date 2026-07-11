export interface InternalNotificationDisplay {
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
  pendingToolCallId?: string | null;
  sourceNotificationId?: string | null;
  lastReminderAt?: string | null;
  refreshCount?: number | null;
  lastRefreshedAt?: string | null;
  reminderCount?: number | null;
  escalatedAt?: string | null;
  escalationReason?: string | null;
  contractMissingFields?: Array<{
    key: string;
    label: string;
    question: string;
    kind: string;
    optional?: boolean;
    choices?: Array<{ value: string; label: string }>;
  }> | null;
}

export interface ResolvedNotificationDisplay extends InternalNotificationDisplay {
  status: string;
  updated_at: string;
}

export interface PendingToolConfirmationDisplay {
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
}

export interface PendingInboxCounts {
  notificationRowsTotal: number;
  /** Actionable notification cards after HITL shadow dedupe. */
  actionableNotificationsTotal: number;
  pendingToolConfirmationsTotal: number;
  /** Unique pendientes shown in the inbox (notifications + HITL cards). */
  uniquePendingTotal: number;
  flowRelatedTotal: number;
  overdueTotal: number;
}
