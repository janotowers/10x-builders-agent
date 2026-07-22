import { NextResponse } from "next/server";
import { createServerClient, getInternalUserNotification } from "@agents/db";
import { createClient } from "@/lib/supabase/server";
import { completeUploadBatch } from "@/lib/operational-cases/upload-batch-completion";
import { runSettingsTestCaseAgentTick } from "@/lib/operational-cases/run-settings-test-case-tick";

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as {
    case_id?: unknown;
    notification_id?: unknown;
  };
  const db = createServerClient();

  let caseId = typeof body.case_id === "string" ? body.case_id.trim() : "";
  const notificationId =
    typeof body.notification_id === "string" ? body.notification_id.trim() : "";

  if (!caseId && notificationId) {
    const notification = await getInternalUserNotification(db, notificationId);
    if (!notification || notification.user_id !== user.id) {
      return NextResponse.json({ error: "notification_not_found" }, { status: 404 });
    }
    caseId =
      typeof notification.case_id === "string" ? notification.case_id.trim() : "";
  }

  if (!caseId) {
    return NextResponse.json(
      { error: "case_id or notification_id is required" },
      { status: 400 }
    );
  }

  const completion = await completeUploadBatch({
    db,
    caseId,
    channel: "web",
    source: "web_inbox_upload_done_button",
  });

  if (completion.case.user_id !== user.id) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  if (
    (completion.status === "advanced" ||
      completion.status === "already_advanced") &&
    completion.case.context_jsonb?.e2e_controlled === true
  ) {
    void runSettingsTestCaseAgentTick(db, completion.case, user.id, {
      source: "web_inbox_upload_done_button",
    }).catch((error) => {
      console.error("[upload-batch-complete] e2e tick failed:", error);
    });
  }

  return NextResponse.json({
    ok:
      completion.status === "advanced" ||
      completion.status === "already_advanced",
    status: completion.status,
    batch_kind: completion.batchKind,
    file_count: completion.fileCount,
    message: completion.ackText,
    case_id: completion.case.id,
  });
}
