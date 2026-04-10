import type { DbClient } from "../client";
import { randomBytes } from "crypto";

export interface CalendarBookingLink {
  id: string;
  user_id: string;
  token: string;
  calendar_id: string;
  is_active: boolean;
  created_at: string;
}

export async function createCalendarBookingLink(
  db: DbClient,
  userId: string,
  calendarId = "primary"
) {
  const token = randomBytes(24).toString("base64url");
  const { data, error } = await db
    .from("calendar_booking_links")
    .insert({
      user_id: userId,
      token,
      calendar_id: calendarId,
      is_active: true,
    })
    .select()
    .single();
  if (error) throw error;
  return data as CalendarBookingLink;
}

/** Service-role lookup for public booking APIs (guest has no auth.uid()). */
export async function getCalendarBookingLinkByToken(
  db: DbClient,
  token: string
) {
  const { data } = await db
    .from("calendar_booking_links")
    .select("*")
    .eq("token", token)
    .eq("is_active", true)
    .single();
  return data as CalendarBookingLink | null;
}
