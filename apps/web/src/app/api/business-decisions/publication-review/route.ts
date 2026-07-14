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
      : action === "approve_continue"
        ? "Aprobar y continuar"
        : action === "stop"
          ? "Detener y revisar"
          : "";
  if (!notificationId || !text) {
    return NextResponse.json(
      { error: "notification_id and text/action are required" },
      { status: 400 }
    );
  }

  const handler = businessDecisionHandler("publication_review");
  const result = await handler.handle(createServerClient(), {
    userId: user.id,
    notificationId,
    text,
    deferControlledE2ETick: true,
  });
  if (
    result.ok &&
    result.case_id &&
    result.deferredControlledE2ETick &&
    (action === "approve_continue" ||
      text.toLowerCase().includes("aprobar") ||
      text.toLowerCase().includes("continuar"))
  ) {
    const source =
      typeof (result.deferredControlledE2ETick as { source?: string }).source ===
      "string"
        ? (result.deferredControlledE2ETick as { source: string }).source
        : "publication_review_web";
    const forceRetryFailedOperation =
      (result.deferredControlledE2ETick as { forceRetryFailedOperation?: boolean })
        .forceRetryFailedOperation === true;
    const { requestPublicationProgress } = await import(
      "@/lib/operational-cases/publication-runner"
    );
    const { createPublicationRunnerOwnedAgentTick } = await import(
      "@/lib/operational-cases/run-settings-test-case-tick"
    );
    void requestPublicationProgress(
      createServerClient(),
      String(result.case_id),
      source,
      {
        forceRetryFailedOperation,
        runAgentTick: createPublicationRunnerOwnedAgentTick(
          createServerClient(),
          user.id,
          source
        ),
      }
    ).catch((error) => {
      console.error("[publication-review/route] deferred progress failed:", error);
    });
  }
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
