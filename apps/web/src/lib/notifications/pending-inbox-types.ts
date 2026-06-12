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
