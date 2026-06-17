import type { DbClient } from "../client";
import type {
  ExternalContactNotification,
  ExternalContactNotificationStatus,
  InternalUserNotification,
  InternalUserNotificationStatus,
  NotificationPriority,
} from "@agents/types";

export interface CreateInternalUserNotificationInput {
  userId: string;
  caseId?: string | null;
  kind?: string;
  title: string;
  body: string;
  priority?: NotificationPriority;
  actionUrl?: string | null;
  dueAt?: string | null;
  deliveredChannels?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export async function createInternalUserNotification(
  db: DbClient,
  input: CreateInternalUserNotificationInput
): Promise<InternalUserNotification> {
  const { data, error } = await db
    .from("internal_user_notifications")
    .insert({
      user_id: input.userId,
      case_id: input.caseId ?? null,
      kind: input.kind ?? "general",
      title: input.title,
      body: input.body,
      priority: input.priority ?? "normal",
      action_url: input.actionUrl ?? null,
      due_at: input.dueAt ?? null,
      delivered_channels_jsonb: input.deliveredChannels ?? { web: { status: "stored" } },
      metadata_jsonb: input.metadata ?? {},
    })
    .select("*")
    .single();
  if (error) throw error;
  return data as InternalUserNotification;
}

export async function upsertActiveInternalUserNotification(
  db: DbClient,
  input: CreateInternalUserNotificationInput
): Promise<InternalUserNotification> {
  const kind = input.kind ?? "general";
  if (!input.caseId) {
    return createInternalUserNotification(db, input);
  }

  const { data: existing, error: selectError } = await db
    .from("internal_user_notifications")
    .select("*")
    .eq("user_id", input.userId)
    .eq("case_id", input.caseId)
    .eq("kind", kind)
    .eq("status", "unread")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (selectError) throw selectError;

  if (!existing) {
    return createInternalUserNotification(db, input);
  }

  const existingNotification = existing as InternalUserNotification;
  const refreshCount =
    typeof existingNotification.metadata_jsonb.refresh_count === "number"
      ? existingNotification.metadata_jsonb.refresh_count + 1
      : 1;
  const { data, error } = await db
    .from("internal_user_notifications")
    .update({
      title: input.title,
      body: input.body,
      priority: input.priority ?? existingNotification.priority,
      action_url: input.actionUrl ?? null,
      due_at: input.dueAt ?? null,
      delivered_channels_jsonb:
        input.deliveredChannels ?? existingNotification.delivered_channels_jsonb,
      metadata_jsonb: {
        ...(existingNotification.metadata_jsonb ?? {}),
        ...(input.metadata ?? {}),
        refresh_count: refreshCount,
        last_refreshed_at: new Date().toISOString(),
      },
      updated_at: new Date().toISOString(),
    })
    .eq("id", existingNotification.id)
    .select("*")
    .single();
  if (error) throw error;
  return data as InternalUserNotification;
}

export async function updateInternalUserNotificationChannels(
  db: DbClient,
  notificationId: string,
  deliveredChannels: Record<string, unknown>
): Promise<InternalUserNotification | null> {
  const { data, error } = await db
    .from("internal_user_notifications")
    .update({
      delivered_channels_jsonb: deliveredChannels,
      updated_at: new Date().toISOString(),
    })
    .eq("id", notificationId)
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return (data as InternalUserNotification | null) ?? null;
}

export async function listInternalUserNotifications(
  db: DbClient,
  userId: string,
  opts: {
    statuses?: InternalUserNotificationStatus[];
    excludeKinds?: string[];
    limit?: number;
  } = {}
): Promise<InternalUserNotification[]> {
  let query = db
    .from("internal_user_notifications")
    .select("*")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(opts.limit ?? 20);
  if (opts.statuses && opts.statuses.length > 0) {
    query = query.in("status", opts.statuses);
  }
  if (opts.excludeKinds && opts.excludeKinds.length > 0) {
    query = query.not("kind", "in", `(${opts.excludeKinds.join(",")})`);
  }
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as InternalUserNotification[];
}

export async function countInternalUserNotifications(
  db: DbClient,
  userId: string,
  opts: {
    statuses?: InternalUserNotificationStatus[];
    excludeKinds?: string[];
    caseId?: string | null;
    caseLinked?: boolean;
    dueBefore?: string;
  } = {}
): Promise<number> {
  let query = db
    .from("internal_user_notifications")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);
  if (opts.statuses && opts.statuses.length > 0) {
    query = query.in("status", opts.statuses);
  }
  if (opts.excludeKinds && opts.excludeKinds.length > 0) {
    query = query.not("kind", "in", `(${opts.excludeKinds.join(",")})`);
  }
  if (opts.caseId) {
    query = query.eq("case_id", opts.caseId);
  } else if (opts.caseLinked === true) {
    query = query.not("case_id", "is", null);
  }
  if (opts.dueBefore) {
    query = query.lte("due_at", opts.dueBefore);
  }
  const { count, error } = await query;
  if (error) throw error;
  return count ?? 0;
}

export async function listResolvedInternalUserNotifications(
  db: DbClient,
  userId: string,
  opts: {
    excludeKinds?: string[];
    limit?: number;
  } = {}
): Promise<InternalUserNotification[]> {
  let query = db
    .from("internal_user_notifications")
    .select("*")
    .eq("user_id", userId)
    .in("status", ["read", "actioned"])
    .order("updated_at", { ascending: false })
    .limit(opts.limit ?? 20);
  if (opts.excludeKinds && opts.excludeKinds.length > 0) {
    query = query.not("kind", "in", `(${opts.excludeKinds.join(",")})`);
  }
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as InternalUserNotification[];
}

export async function restoreInternalUserNotificationToUnread(
  db: DbClient,
  params: { id: string; userId: string }
): Promise<InternalUserNotification | null> {
  const { data, error } = await db
    .from("internal_user_notifications")
    .update({
      status: "unread",
      read_at: null,
      actioned_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.id)
    .eq("user_id", params.userId)
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return (data as InternalUserNotification | null) ?? null;
}

export async function getInternalUserNotification(
  db: DbClient,
  notificationId: string
): Promise<InternalUserNotification | null> {
  const { data, error } = await db
    .from("internal_user_notifications")
    .select("*")
    .eq("id", notificationId)
    .maybeSingle();
  if (error) throw error;
  return (data as InternalUserNotification | null) ?? null;
}

export async function updateInternalUserNotificationMetadata(
  db: DbClient,
  notification: InternalUserNotification,
  metadata: Record<string, unknown>
): Promise<InternalUserNotification | null> {
  const { data, error } = await db
    .from("internal_user_notifications")
    .update({
      metadata_jsonb: { ...(notification.metadata_jsonb ?? {}), ...metadata },
      updated_at: new Date().toISOString(),
    })
    .eq("id", notification.id)
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return (data as InternalUserNotification | null) ?? null;
}

export async function refreshInternalUserNotificationContent(
  db: DbClient,
  notification: InternalUserNotification,
  patch: {
    title?: string;
    body?: string;
    metadata?: Record<string, unknown>;
  }
): Promise<InternalUserNotification | null> {
  const update: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  if (typeof patch.title === "string") update.title = patch.title;
  if (typeof patch.body === "string") update.body = patch.body;
  if (patch.metadata) {
    update.metadata_jsonb = {
      ...(notification.metadata_jsonb ?? {}),
      ...patch.metadata,
    };
  }
  const { data, error } = await db
    .from("internal_user_notifications")
    .update(update)
    .eq("id", notification.id)
    .eq("user_id", notification.user_id)
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return (data as InternalUserNotification | null) ?? null;
}

export async function setInternalUserNotificationStatus(
  db: DbClient,
  params: {
    id: string;
    userId: string;
    status: Exclude<InternalUserNotificationStatus, "unread">;
  }
): Promise<InternalUserNotification | null> {
  const now = new Date().toISOString();
  const update: Record<string, unknown> = {
    status: params.status,
    updated_at: now,
  };
  if (params.status === "read") update.read_at = now;
  if (params.status === "actioned") {
    update.actioned_at = now;
    update.read_at = now;
  }
  const { data, error } = await db
    .from("internal_user_notifications")
    .update(update)
    .eq("id", params.id)
    .eq("user_id", params.userId)
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return (data as InternalUserNotification | null) ?? null;
}

function reminderStatusUpdate(
  status: InternalUserNotificationStatus,
  now: string
): Record<string, unknown> {
  const update: Record<string, unknown> = {
    status,
    updated_at: now,
  };
  if (status === "unread") {
    update.read_at = null;
    update.actioned_at = null;
    return update;
  }
  if (status === "read") {
    update.read_at = now;
    update.actioned_at = null;
    return update;
  }
  if (status === "actioned") {
    update.read_at = now;
    update.actioned_at = now;
    return update;
  }
  return update;
}

export async function setRemindersStatusForSource(
  db: DbClient,
  params: {
    userId: string;
    sourceNotificationId: string;
    status: InternalUserNotificationStatus;
  }
): Promise<number> {
  const now = new Date().toISOString();
  const update = reminderStatusUpdate(params.status, now);
  const { data, error } = await db
    .from("internal_user_notifications")
    .update(update)
    .eq("user_id", params.userId)
    .eq("kind", "internal_notification_reminder")
    .eq("metadata_jsonb->>source_notification_id", params.sourceNotificationId)
    .select("id");
  if (error) throw error;
  return data?.length ?? 0;
}

export async function resolveInternalNotificationWithReminders(
  db: DbClient,
  params: {
    id: string;
    userId: string;
    status: InternalUserNotificationStatus;
  }
): Promise<InternalUserNotification | null> {
  const notification =
    params.status === "unread"
      ? await restoreInternalUserNotificationToUnread(db, {
          id: params.id,
          userId: params.userId,
        })
      : await setInternalUserNotificationStatus(db, {
          id: params.id,
          userId: params.userId,
          status: params.status as Exclude<InternalUserNotificationStatus, "unread">,
        });
  if (!notification) return null;
  await setRemindersStatusForSource(db, {
    userId: params.userId,
    sourceNotificationId: notification.id,
    status: params.status,
  });
  return notification;
}

export async function resolveUnreadInternalNotificationsByKindForCaseWithReminders(
  db: DbClient,
  params: {
    userId: string;
    caseId: string;
    kind: string;
    status: Exclude<InternalUserNotificationStatus, "unread">;
  }
): Promise<number> {
  const { data, error } = await db
    .from("internal_user_notifications")
    .select("id")
    .eq("user_id", params.userId)
    .eq("case_id", params.caseId)
    .eq("kind", params.kind)
    .eq("status", "unread");
  if (error) throw error;

  const ids = ((data ?? []) as Array<{ id?: unknown }>)
    .map((row) => row.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  if (ids.length === 0) return 0;

  let resolved = 0;
  for (const id of ids) {
    const updated = await resolveInternalNotificationWithReminders(db, {
      id,
      userId: params.userId,
      status: params.status,
    });
    if (updated) resolved += 1;
  }
  return resolved;
}

export async function deleteSettingsTestInternalNotificationsForCase(
  db: DbClient,
  userId: string,
  caseId: string
): Promise<number> {
  const verified = await verifyOwnedSettingsTestCase(db, userId, caseId);
  if (!verified) return 0;

  const { data, error } = await db
    .from("internal_user_notifications")
    .delete()
    .eq("user_id", userId)
    .eq("case_id", caseId)
    .select("id");
  if (error) throw error;
  return data?.length ?? 0;
}

/** Caso de prueba del laboratorio perteneciente al usuario. */
export async function verifyOwnedSettingsTestCase(
  db: DbClient,
  userId: string,
  caseId: string
): Promise<boolean> {
  const { data: opCase, error: caseError } = await db
    .from("operational_cases")
    .select("id, user_id, context_jsonb")
    .eq("id", caseId)
    .eq("user_id", userId)
    .maybeSingle();
  if (caseError) throw caseError;
  if (!opCase) return false;
  const context = (opCase as { context_jsonb?: Record<string, unknown> }).context_jsonb;
  return (
    context?.created_from === "case_type_settings_test" ||
    context?.test_mode === true ||
    (context?.created_from === "agent_conversation" &&
      context?.e2e_controlled === true)
  );
}

export async function deleteSettingsTestInternalNotifications(
  db: DbClient,
  userId: string
): Promise<number> {
  const { data: cases, error: casesError } = await db
    .from("operational_cases")
    .select("id")
    .eq("user_id", userId)
    .or("context_jsonb->>created_from.eq.case_type_settings_test,context_jsonb->>test_mode.eq.true");
  if (casesError) throw casesError;
  const caseIds = (cases ?? [])
    .map((row: { id?: unknown }) => row.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  if (caseIds.length === 0) return 0;

  const { data, error } = await db
    .from("internal_user_notifications")
    .delete()
    .eq("user_id", userId)
    .in("case_id", caseIds)
    .select("id");
  if (error) throw error;
  return data?.length ?? 0;
}

export async function deleteResolvedInternalNotificationsForUser(
  db: DbClient,
  userId: string
): Promise<number> {
  const { data, error } = await db
    .from("internal_user_notifications")
    .delete()
    .eq("user_id", userId)
    .in("status", ["read", "actioned"])
    .select("id");
  if (error) throw error;
  return data?.length ?? 0;
}

export async function dismissOrphanInternalRemindersForUser(
  db: DbClient,
  userId: string
): Promise<number> {
  const { data: reminders, error: remindersError } = await db
    .from("internal_user_notifications")
    .select("id, metadata_jsonb")
    .eq("user_id", userId)
    .eq("status", "unread")
    .eq("kind", "internal_notification_reminder");
  if (remindersError) throw remindersError;
  const reminderRows =
    (reminders as Array<{ id: string; metadata_jsonb?: Record<string, unknown> }>) ?? [];
  if (reminderRows.length === 0) return 0;

  const sourceIds = reminderRows
    .map((row) => row.metadata_jsonb?.source_notification_id)
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  if (sourceIds.length === 0) {
    const { data, error } = await db
      .from("internal_user_notifications")
      .update({
        status: "dismissed",
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId)
      .eq("status", "unread")
      .eq("kind", "internal_notification_reminder")
      .select("id");
    if (error) throw error;
    return data?.length ?? 0;
  }

  const { data: sources, error: sourcesError } = await db
    .from("internal_user_notifications")
    .select("id")
    .eq("user_id", userId)
    .eq("status", "unread")
    .in("id", sourceIds);
  if (sourcesError) throw sourcesError;
  const activeSourceIds = new Set(
    ((sources as Array<{ id: string }>) ?? []).map((source) => source.id)
  );
  const orphanReminderIds = reminderRows
    .filter((row) => {
      const sourceId = row.metadata_jsonb?.source_notification_id;
      if (typeof sourceId !== "string" || sourceId.trim().length === 0) return true;
      return !activeSourceIds.has(sourceId);
    })
    .map((row) => row.id);
  if (orphanReminderIds.length === 0) return 0;

  const { data, error } = await db
    .from("internal_user_notifications")
    .update({
      status: "dismissed",
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId)
    .in("id", orphanReminderIds)
    .select("id");
  if (error) throw error;
  return data?.length ?? 0;
}

export async function listDueInternalUserNotifications(
  db: DbClient,
  opts: { limit?: number } = {}
): Promise<InternalUserNotification[]> {
  const { data, error } = await db
    .from("internal_user_notifications")
    .select("*")
    .eq("status", "unread")
    .lte("due_at", new Date().toISOString())
    .order("due_at", { ascending: true })
    .limit(opts.limit ?? 50);
  if (error) throw error;
  return (data ?? []) as InternalUserNotification[];
}

export async function markInternalNotificationReminderSent(
  db: DbClient,
  notification: InternalUserNotification
): Promise<void> {
  const currentReminderCount =
    typeof notification.metadata_jsonb?.reminder_count === "number" &&
    Number.isFinite(notification.metadata_jsonb.reminder_count)
      ? notification.metadata_jsonb.reminder_count
      : 0;
  const metadata = {
    ...(notification.metadata_jsonb ?? {}),
    last_reminder_at: new Date().toISOString(),
    reminder_count: currentReminderCount + 1,
  };
  const { error } = await db
    .from("internal_user_notifications")
    .update({ metadata_jsonb: metadata, updated_at: new Date().toISOString() })
    .eq("id", notification.id);
  if (error) throw error;
}

export async function markInternalNotificationEscalated(
  db: DbClient,
  notification: InternalUserNotification,
  opts: {
    priority?: NotificationPriority;
    reason?: string;
  } = {}
): Promise<InternalUserNotification | null> {
  const now = new Date().toISOString();
  const metadata = {
    ...(notification.metadata_jsonb ?? {}),
    escalated_at: now,
    ...(opts.reason ? { escalation_reason: opts.reason } : {}),
  };
  const { data, error } = await db
    .from("internal_user_notifications")
    .update({
      priority: opts.priority ?? "high",
      metadata_jsonb: metadata,
      updated_at: now,
    })
    .eq("id", notification.id)
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return (data as InternalUserNotification | null) ?? null;
}

export interface CreateExternalContactNotificationInput {
  userId: string;
  caseId: string;
  contact?: Record<string, unknown>;
  channel: Exclude<ExternalContactNotification["channel"], "web">;
  recipientIdentifier: string;
  messageBody: string;
  status?: ExternalContactNotificationStatus;
  maxAttempts?: number;
  nextReminderAt?: string | null;
  metadata?: Record<string, unknown>;
}

export async function createExternalContactNotification(
  db: DbClient,
  input: CreateExternalContactNotificationInput
): Promise<ExternalContactNotification> {
  const { data, error } = await db
    .from("external_contact_notifications")
    .insert({
      user_id: input.userId,
      case_id: input.caseId,
      contact_jsonb: input.contact ?? {},
      channel: input.channel,
      recipient_identifier: input.recipientIdentifier,
      message_body: input.messageBody,
      status: input.status ?? "pending",
      max_attempts: input.maxAttempts ?? 3,
      next_reminder_at: input.nextReminderAt ?? null,
      metadata_jsonb: input.metadata ?? {},
    })
    .select("*")
    .single();
  if (error) throw error;
  return data as ExternalContactNotification;
}

export async function listDueExternalContactNotifications(
  db: DbClient,
  opts: { limit?: number } = {}
): Promise<ExternalContactNotification[]> {
  const { data, error } = await db
    .from("external_contact_notifications")
    .select("*")
    .in("status", ["pending", "sent"])
    .lte("next_reminder_at", new Date().toISOString())
    .order("next_reminder_at", { ascending: true })
    .limit(opts.limit ?? 50);
  if (error) throw error;
  return (data ?? []) as ExternalContactNotification[];
}

export async function markExternalContactNotificationSent(
  db: DbClient,
  notification: ExternalContactNotification,
  nextReminderAt: string | null
): Promise<void> {
  const { error } = await db
    .from("external_contact_notifications")
    .update({
      status: "sent",
      attempt_count: notification.attempt_count + 1,
      last_sent_at: new Date().toISOString(),
      next_reminder_at: nextReminderAt,
      updated_at: new Date().toISOString(),
    })
    .eq("id", notification.id);
  if (error) throw error;
}

export async function markExternalContactNotificationFailed(
  db: DbClient,
  notificationId: string,
  errorMessage: string
): Promise<void> {
  const { data } = await db
    .from("external_contact_notifications")
    .select("metadata_jsonb")
    .eq("id", notificationId)
    .maybeSingle();
  const metadata =
    data && typeof data.metadata_jsonb === "object" && data.metadata_jsonb
      ? (data.metadata_jsonb as Record<string, unknown>)
      : {};
  const { error } = await db
    .from("external_contact_notifications")
    .update({
      status: "failed",
      metadata_jsonb: { ...metadata, last_error: errorMessage },
      updated_at: new Date().toISOString(),
    })
    .eq("id", notificationId);
  if (error) throw error;
}

export async function expireExternalContactNotification(
  db: DbClient,
  notificationId: string
): Promise<void> {
  const { error } = await db
    .from("external_contact_notifications")
    .update({
      status: "expired",
      next_reminder_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", notificationId);
  if (error) throw error;
}

/** Cancels pending/sent external reminders for a case (e.g. Settings test cleanup). */
export async function expireExternalContactNotificationsForCase(
  db: DbClient,
  caseId: string
): Promise<number> {
  const { data, error } = await db
    .from("external_contact_notifications")
    .update({
      status: "expired",
      next_reminder_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("case_id", caseId)
    .in("status", ["pending", "sent"])
    .select("id");
  if (error) throw error;
  return data?.length ?? 0;
}
