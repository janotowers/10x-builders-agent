import { NextResponse } from "next/server";
import {
  createServerClient,
  deleteResolvedInternalNotificationsForUser,
  dismissOrphanInternalRemindersForUser,
  getOperationalCase,
  getRecentOperationalCaseEvents,
  LAB_CLEANABLE_CASE_OR_FILTER,
  rejectPendingToolCallsForCase,
  resolveInternalNotificationWithReminders,
  updateOperationalCase,
} from "@agents/db";
import type { InternalUserNotificationStatus } from "@agents/types";
import { createClient } from "@/lib/supabase/server";
import { cleanupSettingsTestCaseHistory } from "@/lib/operational-cases/settings-test-pending-actions";
import {
  loadPendingInboxSnapshot,
  loadResolvedInboxSnapshot,
} from "@/lib/notifications/load-pending-inbox";

export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  if (url.searchParams.get("view") === "resolved") {
    const resolved = await loadResolvedInboxSnapshot(user.id);
    return NextResponse.json({ notifications: resolved.notifications });
  }

  const caseIdFilter = url.searchParams.get("case_id")?.trim() || null;
  const pendingInbox = await loadPendingInboxSnapshot(user.id, caseIdFilter);

  return NextResponse.json({
    notifications: pendingInbox.notifications,
    pendingToolConfirmations: pendingInbox.pendingToolConfirmations,
    counts: pendingInbox.counts,
  });
}

export async function PATCH(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as {
    id?: unknown;
    status?: unknown;
  };
  const id = typeof body.id === "string" ? body.id : "";
  const status = typeof body.status === "string" ? body.status : "";
  if (!id || !["unread", "read", "actioned", "dismissed"].includes(status)) {
    return NextResponse.json(
      { error: "id and status (unread|read|actioned|dismissed) are required" },
      { status: 400 }
    );
  }

  const db = createServerClient();
  const notification = await resolveInternalNotificationWithReminders(db, {
    id,
    userId: user.id,
    status: status as InternalUserNotificationStatus,
  });
  if (!notification) {
    return NextResponse.json({ error: "notification_not_found" }, { status: 404 });
  }
  return NextResponse.json({ notification });
}

export async function DELETE(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const scope = url.searchParams.get("scope")?.trim() ?? "";
  const db = createServerClient();

  if (scope === "resolved-history") {
    const deleted_resolved_history = await deleteResolvedInternalNotificationsForUser(
      db,
      user.id
    );
    return NextResponse.json({ deleted_resolved_history });
  }

  if (scope === "stuck-case") {
    const caseId = url.searchParams.get("case_id")?.trim() || "";
    if (!caseId) {
      return NextResponse.json({ error: "case_id is required" }, { status: 400 });
    }
    const opCase = await getOperationalCase(db, caseId);
    if (!opCase || opCase.user_id !== user.id) {
      return NextResponse.json({ error: "case_not_found" }, { status: 404 });
    }
    const rejected_tool_calls = await rejectPendingToolCallsForCase(
      db,
      caseId,
      "stuck_case_cleanup"
    );
    const pausedCase = await updateOperationalCase(db, opCase.id, opCase.version, {
      status: "paused",
      nextActionAt: null,
    });
    if (!pausedCase) {
      return NextResponse.json({ error: "case_update_conflict" }, { status: 409 });
    }
    return NextResponse.json({
      case_id: caseId,
      rejected_tool_calls,
      case_status: pausedCase.status,
    });
  }

  if (scope !== "settings-test") {
    return NextResponse.json(
      { error: "scope must be settings-test, resolved-history, or stuck-case" },
      { status: 400 }
    );
  }

  const caseId = url.searchParams.get("case_id")?.trim() || "";
  const targetParam =
    url.searchParams.get("target")?.trim() || (caseId ? "all" : "notifications");
  const target =
    targetParam === "notifications" ||
    targetParam === "tool_calls" ||
    targetParam === "all"
      ? targetParam
      : null;
  if (!target) {
    return NextResponse.json(
      { error: "target must be notifications, tool_calls, or all" },
      { status: 400 }
    );
  }
  if ((target === "tool_calls" || target === "all") && !caseId) {
    return NextResponse.json(
      { error: "case_id is required to clean tool approvals" },
      { status: 400 }
    );
  }

  const dismissed_orphan_reminders = await dismissOrphanInternalRemindersForUser(
    db,
    user.id
  );
  if (caseId) {
    const opCase = await getOperationalCase(db, caseId);
    if (!opCase || opCase.user_id !== user.id) {
      return NextResponse.json({ error: "case_not_found" }, { status: 404 });
    }
    const events = await getRecentOperationalCaseEvents(db, caseId, 80);
    const result = await cleanupSettingsTestCaseHistory(db, {
      userId: user.id,
      caseId,
      target,
      events,
    });
    return NextResponse.json({
      ...result,
      deleted: result.deleted_notifications,
      dismissed_orphan_reminders,
      case_id: caseId,
      target,
    });
  }

  if (target !== "notifications") {
    return NextResponse.json(
      { error: "case_id is required unless target=notifications" },
      { status: 400 }
    );
  }

  const { data: settingsTestCases, error: casesError } = await db
    .from("operational_cases")
    .select("id")
    .eq("user_id", user.id)
    .or(LAB_CLEANABLE_CASE_OR_FILTER);
  if (casesError) throw casesError;

  let deleted_notifications = 0;
  let rejected_tool_calls = 0;
  for (const caseRow of settingsTestCases ?? []) {
    const settingsCaseId =
      typeof caseRow.id === "string" && caseRow.id.length > 0 ? caseRow.id : "";
    if (!settingsCaseId) continue;
    const result = await cleanupSettingsTestCaseHistory(db, {
      userId: user.id,
      caseId: settingsCaseId,
      target: "all",
      rejectBlockingToolCalls: true,
    });
    deleted_notifications += result.deleted_notifications;
    rejected_tool_calls += result.rejected_tool_calls;
  }

  return NextResponse.json({
    deleted_notifications,
    rejected_tool_calls,
    dismissed_orphan_reminders,
    deleted: deleted_notifications,
    case_id: null,
    target: "all",
  });
}
