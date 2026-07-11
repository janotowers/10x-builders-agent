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
        ? "APROBAR"
        : action === "skip"
          ? "OMITIR"
          : action === "reject"
            ? "RECHAZAR"
            : "";
  if (!notificationId || !text) {
    return NextResponse.json(
      { error: "notification_id and text/action are required" },
      { status: 400 }
    );
  }

  const handler = businessDecisionHandler("publish_destination_approval");
  const result = await handler.handle(createServerClient(), {
    userId: user.id,
    notificationId,
    text,
    deferControlledE2ETick: true,
  });
  if (
    result.ok &&
    result.case_id &&
    result.deferredControlledE2ETick
  ) {
    const { runDeferredPublishDestinationControlledE2ETick } = await import(
      "@/lib/business-decisions/publish-destination-approval"
    );
    const source =
      typeof (result.deferredControlledE2ETick as { source?: string }).source ===
      "string"
        ? (result.deferredControlledE2ETick as { source: string }).source
        : "publish_destination_web";
    void runDeferredPublishDestinationControlledE2ETick(
      createServerClient(),
      String(result.case_id),
      source
    ).catch((error) => {
      console.error(
        "[publish-destination-approval/route] deferred tick failed:",
        error
      );
    });
  }
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
