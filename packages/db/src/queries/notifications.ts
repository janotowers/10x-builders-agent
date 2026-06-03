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
    .order("created_at", { ascending: false })
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
    context?.test_mode === true
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
  const metadata = {
    ...(notification.metadata_jsonb ?? {}),
    last_reminder_at: new Date().toISOString(),
  };
  const { error } = await db
    .from("internal_user_notifications")
    .update({ metadata_jsonb: metadata, updated_at: new Date().toISOString() })
    .eq("id", notification.id);
  if (error) throw error;
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
