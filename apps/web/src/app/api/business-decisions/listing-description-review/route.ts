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
  const action = typeof body.action === "string" ? body.action : "";
  const text =
    typeof body.text === "string" && body.text.trim()
      ? body.text.trim()
      : action === "approve"
        ? "APROBAR DESCRIPCIÓN"
        : "";
  if (!notificationId || !text) {
    return NextResponse.json(
      { error: "notification_id and text/action are required" },
      { status: 400 }
    );
  }

  const handler = businessDecisionHandler("listing_description_review");
  const result = await handler.handle(createServerClient(), {
    userId: user.id,
    notificationId,
    text,
  });
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
