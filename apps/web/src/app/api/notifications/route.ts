import { NextResponse } from "next/server";
import {
  createServerClient,
  deleteSettingsTestInternalNotifications,
  getOperationalCase,
  getRecentOperationalCaseEvents,
  listInternalUserNotifications,
  setInternalUserNotificationStatus,
} from "@agents/db";
import type { InternalUserNotificationStatus } from "@agents/types";
import { createClient } from "@/lib/supabase/server";
import { hiddenInboxNotificationKinds } from "@/lib/internal-notifications/registry";
import {
  formatPendingCaseContextLine,
  loadCaseContextMap,
} from "@/lib/notifications/enrich-case-context";
import { cleanupSettingsTestCaseHistory } from "@/lib/operational-cases/settings-test-pending-actions";
import { normalizeNotificationActionUrl } from "@/lib/notifications/pending-action-display";

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

export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const caseIdFilter = url.searchParams.get("case_id")?.trim() || null;

  const db = createServerClient();
  let notifications = await listInternalUserNotifications(db, user.id, {
    statuses: ["unread"],
    excludeKinds: hiddenInboxNotificationKinds(),
    limit: caseIdFilter ? 50 : 20,
  });
  if (caseIdFilter) {
    notifications = notifications.filter(
      (notification) => notification.case_id === caseIdFilter
    );
  }

  let pendingToolConfirmations = await listCaseRunnerPendingConfirmations(
    db,
    user.id,
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

  return NextResponse.json({
    notifications: enrichedNotifications,
    pendingToolConfirmations: enrichedPendingToolConfirmations,
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
  if (!id || !["read", "actioned", "dismissed"].includes(status)) {
    return NextResponse.json(
      { error: "id and status (read|actioned|dismissed) are required" },
      { status: 400 }
    );
  }

  const db = createServerClient();
  const notification = await setInternalUserNotificationStatus(db, {
    id,
    userId: user.id,
    status: status as Exclude<InternalUserNotificationStatus, "unread">,
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
  if (url.searchParams.get("scope") !== "settings-test") {
    return NextResponse.json(
      { error: "scope=settings-test is required" },
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

  const db = createServerClient();
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
  const deleted = await deleteSettingsTestInternalNotifications(db, user.id);
  return NextResponse.json({
    deleted_notifications: deleted,
    rejected_tool_calls: 0,
    deleted,
    case_id: null,
    target,
  });
}
