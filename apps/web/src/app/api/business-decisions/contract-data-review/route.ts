import { NextResponse } from "next/server";
import { createServerClient } from "@agents/db";
import { createClient } from "@/lib/supabase/server";
import { handleContractDataReviewDecision } from "@/lib/business-decisions/contract-data-review";

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as {
    notification_id?: unknown;
    text?: unknown;
  };
  const notificationId =
    typeof body.notification_id === "string" ? body.notification_id : "";
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!notificationId || !text) {
    return NextResponse.json(
      { error: "notification_id and text are required" },
      { status: 400 }
    );
  }

  const result = await handleContractDataReviewDecision(createServerClient(), {
    userId: user.id,
    notificationId,
    text,
  });
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
