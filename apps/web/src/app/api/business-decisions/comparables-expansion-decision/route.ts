import { NextResponse } from "next/server";
import { createServerClient } from "@agents/db";
import { createClient } from "@/lib/supabase/server";
import { handleComparablesExpansionDecision } from "@/lib/business-decisions/comparables-expansion-decision";

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
      : action === "use_current_comparables"
        ? "1"
        : action === "use_avaclick_primary"
          ? "2"
          : action === "expand_search"
            ? "3"
            : "";
  if (!notificationId || !text) {
    return NextResponse.json(
      { error: "notification_id and text/action are required" },
      { status: 400 }
    );
  }

  const result = await handleComparablesExpansionDecision(createServerClient(), {
    userId: user.id,
    notificationId,
    text,
    source: "web",
  });
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
