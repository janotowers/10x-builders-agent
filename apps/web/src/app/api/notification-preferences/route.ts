import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  createServerClient,
  getProfile,
  getUserNotificationPreferences,
  upsertUserNotificationPreferences,
} from "@agents/db";
import { normalizeEngagementPolicyOverrides } from "@/lib/engagement-policies/registry";

export async function GET() {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const db = createServerClient();
    const [preferences, profile] = await Promise.all([
      getUserNotificationPreferences(db, user.id),
      getProfile(db, user.id),
    ]);
    return NextResponse.json({
      ok: true,
      preferences,
      timezone: profile?.timezone ?? "UTC",
    });
  } catch (error) {
    console.error("[GET /api/notification-preferences] failed:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const engagementPolicyOverrides = normalizeEngagementPolicyOverrides(
      body.engagement_policy_overrides_jsonb
    );
    const db = createServerClient();
    const preferences = await upsertUserNotificationPreferences(db, {
      userId: user.id,
      engagementPolicyOverrides,
    });
    return NextResponse.json({ ok: true, preferences });
  } catch (error) {
    console.error("[POST /api/notification-preferences] failed:", error);
    const message =
      error &&
      typeof error === "object" &&
      "message" in error &&
      typeof (error as { message?: unknown }).message === "string"
        ? (error as { message: string }).message
        : "";
    if (message.includes("engagement_policy_overrides_jsonb")) {
      return NextResponse.json(
        {
          error:
            "Falta la migración 00036 en Supabase (columna engagement_policy_overrides_jsonb). Aplica packages/db/supabase/migrations/00036_notification_engagement_policy_overrides.sql.",
        },
        { status: 500 }
      );
    }
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

