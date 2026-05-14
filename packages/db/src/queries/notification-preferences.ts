/**
 * Queries para user_notification_preferences.
 * Ver migración 00021_user_notification_preferences.sql.
 */
import type { DbClient } from "../client";
import type {
  NotificationChannel,
  OperationalCaseReminderPolicy,
  UserNotificationPreferences,
} from "@agents/types";

export async function getUserNotificationPreferences(
  db: DbClient,
  userId: string
): Promise<UserNotificationPreferences | null> {
  const { data, error } = await db
    .from("user_notification_preferences")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return (data as UserNotificationPreferences | null) ?? null;
}

export interface UpsertUserNotificationPreferencesInput {
  userId: string;
  channelsPriority?: NotificationChannel[];
  caseReminderOverrides?: {
    by_case_type?: Record<string, OperationalCaseReminderPolicy>;
    by_case_id?: Record<string, OperationalCaseReminderPolicy>;
  };
}

export async function upsertUserNotificationPreferences(
  db: DbClient,
  input: UpsertUserNotificationPreferencesInput
): Promise<UserNotificationPreferences> {
  const update: Record<string, unknown> = {
    user_id: input.userId,
    updated_at: new Date().toISOString(),
  };
  if (input.channelsPriority !== undefined) {
    update.channels_priority_jsonb = input.channelsPriority;
  }
  if (input.caseReminderOverrides !== undefined) {
    update.case_reminder_overrides_jsonb = input.caseReminderOverrides;
  }
  const { data, error } = await db
    .from("user_notification_preferences")
    .upsert(update, { onConflict: "user_id" })
    .select("*")
    .single();
  if (error) throw error;
  return data as UserNotificationPreferences;
}
