/**
 * After the advisor uploads a document/photo while an upload-batch notification
 * is still unread, pull the first «confirm with listo» nudge forward to
 * now + nudge_after_upload_minutes (engagement policy, default 20).
 */
import { createServerClient, getOperationalCase } from "@agents/db";
import {
  normalizeEngagementPolicyOverrides,
  nudgeAfterUploadMinutesForEngagement,
} from "@/lib/engagement-policies/registry";
import {
  DOCUMENTS_UPLOAD_REQUESTED_NOTIFICATION_KIND,
  PHOTOS_UPLOAD_REQUESTED_NOTIFICATION_KIND,
} from "./upload-batch-shared";
import {
  resolveUploadBatchKind,
  type UploadBatchKind,
} from "./upload-batch-completion";

type DbClient = ReturnType<typeof createServerClient>;

function notificationKindForBatch(batchKind: UploadBatchKind): string {
  return batchKind === "photos"
    ? PHOTOS_UPLOAD_REQUESTED_NOTIFICATION_KIND
    : DOCUMENTS_UPLOAD_REQUESTED_NOTIFICATION_KIND;
}

export async function rescheduleUploadBatchConfirmationNudgeForCase(params: {
  db: DbClient;
  caseId: string;
  userId?: string;
  nowMs?: number;
}): Promise<{ rescheduled: boolean; dueAt: string | null }> {
  const opCase = await getOperationalCase(params.db, params.caseId);
  if (!opCase) return { rescheduled: false, dueAt: null };
  const batchKind = resolveUploadBatchKind(opCase);
  if (!batchKind) return { rescheduled: false, dueAt: null };
  return rescheduleUploadBatchConfirmationNudge({
    db: params.db,
    userId: params.userId ?? opCase.user_id,
    caseId: params.caseId,
    batchKind,
    nowMs: params.nowMs,
  });
}

export async function rescheduleUploadBatchConfirmationNudge(params: {
  db: DbClient;
  userId: string;
  caseId: string;
  batchKind: UploadBatchKind;
  nowMs?: number;
}): Promise<{ rescheduled: boolean; dueAt: string | null }> {
  const kind = notificationKindForBatch(params.batchKind);
  const { data: unread } = await params.db
    .from("internal_user_notifications")
    .select("id, due_at")
    .eq("user_id", params.userId)
    .eq("case_id", params.caseId)
    .eq("kind", kind)
    .eq("status", "unread")
    .limit(1);
  const row = Array.isArray(unread) ? unread[0] : null;
  if (!row || typeof row.id !== "string") {
    return { rescheduled: false, dueAt: null };
  }

  const { data: prefs } = await params.db
    .from("user_notification_preferences")
    .select("engagement_policy_overrides_jsonb")
    .eq("user_id", params.userId)
    .maybeSingle();
  const overrides = normalizeEngagementPolicyOverrides(
    prefs && typeof prefs === "object"
      ? (prefs as { engagement_policy_overrides_jsonb?: unknown })
          .engagement_policy_overrides_jsonb
      : null
  );
  const minutes = nudgeAfterUploadMinutesForEngagement(
    {
      audience: "internal_user",
      intent: "reminder",
      kind,
    },
    overrides
  );
  const nowMs = params.nowMs ?? Date.now();
  const dueAt = new Date(nowMs + minutes * 60_000).toISOString();

  // Only pull forward; do not push a nearer due_at later.
  if (
    typeof row.due_at === "string" &&
    Number.isFinite(Date.parse(row.due_at)) &&
    Date.parse(row.due_at) <= Date.parse(dueAt)
  ) {
    return { rescheduled: false, dueAt: row.due_at };
  }

  const { error } = await params.db
    .from("internal_user_notifications")
    .update({
      due_at: dueAt,
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id)
    .eq("user_id", params.userId)
    .eq("status", "unread");
  if (error) {
    console.warn(
      "[reschedule-upload-batch-nudge] update failed:",
      error.message
    );
    return { rescheduled: false, dueAt: null };
  }
  return { rescheduled: true, dueAt };
}
