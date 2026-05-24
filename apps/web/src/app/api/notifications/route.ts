import { NextResponse } from "next/server";
import {
  createServerClient,
  listInternalUserNotifications,
  setInternalUserNotificationStatus,
} from "@agents/db";
import type { InternalUserNotificationStatus } from "@agents/types";
import { createClient } from "@/lib/supabase/server";

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const db = createServerClient();
  const notifications = await listInternalUserNotifications(db, user.id, {
    statuses: ["unread"],
    limit: 20,
  });
  return NextResponse.json({ notifications });
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
