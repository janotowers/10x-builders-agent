import type { DbClient } from "./client";
import { decryptToken, encryptToken } from "./crypto";
import { upsertIntegration } from "./queries/integrations";

export const GOOGLE_CALENDAR_PROVIDER = "google_calendar";

/** Scopes: read calendars/events + write events (minimal for agent + booking). */
export const GOOGLE_CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
];

export interface GoogleOAuthTokenPayload {
  access_token: string;
  refresh_token?: string;
  /** Unix ms when access_token expires */
  expires_at: number;
}

async function refreshGoogleAccessToken(refreshToken: string): Promise<{
  access_token: string;
  expires_in: number;
  refresh_token?: string;
}> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Google OAuth not configured");
  }
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  if (!res.ok || typeof body.access_token !== "string") {
    throw new Error(
      typeof body.error === "string" ? body.error : "Google token refresh failed"
    );
  }
  return {
    access_token: body.access_token,
    expires_in: Number(body.expires_in ?? 3600),
    refresh_token:
      typeof body.refresh_token === "string" ? body.refresh_token : undefined,
  };
}

/**
 * Returns a valid access token for Calendar API, refreshing and persisting if needed.
 */
export async function getGoogleCalendarAccessToken(
  db: DbClient,
  userId: string
): Promise<string | null> {
  const { data: row } = await db
    .from("user_integrations")
    .select("*")
    .eq("user_id", userId)
    .eq("provider", GOOGLE_CALENDAR_PROVIDER)
    .eq("status", "active")
    .single();

  if (!row?.encrypted_tokens) return null;

  let payload: GoogleOAuthTokenPayload;
  try {
    const raw = decryptToken(row.encrypted_tokens as string);
    payload = JSON.parse(raw) as GoogleOAuthTokenPayload;
  } catch {
    return null;
  }

  if (!payload.access_token) return null;

  const needsRefresh =
    payload.expires_at < Date.now() + 5 * 60 * 1000 && payload.refresh_token;

  if (needsRefresh && payload.refresh_token) {
    try {
      const refreshed = await refreshGoogleAccessToken(payload.refresh_token);
      const newPayload: GoogleOAuthTokenPayload = {
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token ?? payload.refresh_token,
        expires_at: Date.now() + refreshed.expires_in * 1000,
      };
      const encrypted = encryptToken(JSON.stringify(newPayload));
      await upsertIntegration(
        db,
        userId,
        GOOGLE_CALENDAR_PROVIDER,
        (row.scopes as string[]) ?? GOOGLE_CALENDAR_SCOPES,
        encrypted
      );
      return newPayload.access_token;
    } catch (e) {
      console.error("Google calendar token refresh failed:", e);
      return null;
    }
  }

  if (payload.expires_at < Date.now() && !payload.refresh_token) {
    return null;
  }

  return payload.access_token;
}
