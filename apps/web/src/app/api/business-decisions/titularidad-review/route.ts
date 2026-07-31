import { NextResponse } from "next/server";
import { createServerClient } from "@agents/db";
import { createClient } from "@/lib/supabase/server";
import { businessDecisionHandler } from "@/lib/business-decisions/registry";

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as {
    notification_id?: unknown;
    text?: unknown;
    action?: unknown;
  };
  const notificationId =
    typeof body.notification_id === "string" ? body.notification_id : "";
  const action = typeof body.action === "string" ? body.action.trim() : "";
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!notificationId || (!text && !action)) {
    return NextResponse.json(
      { error: "notification_id and text/action are required" },
      { status: 400 }
    );
  }

  const result = await businessDecisionHandler("titularidad_review").handle(
    createServerClient(),
    {
      userId: user.id,
      notificationId,
      text,
      action,
      source: "web",
    }
  );
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
