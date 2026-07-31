import { NextResponse } from "next/server";
import { createServerClient, getOperationalCase } from "@agents/db";
import { createClient } from "@/lib/supabase/server";
import { handleContractDataReviewDecision } from "@/lib/business-decisions/contract-data-review";
import { kickContractPendingAfterDataCapture } from "@/lib/operational-cases/run-settings-test-case-tick";

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as {
    notification_id?: unknown;
    text?: unknown;
    patch?: unknown;
  };
  const notificationId =
    typeof body.notification_id === "string" ? body.notification_id : "";
  const text = typeof body.text === "string" ? body.text.trim() : "";
  const patch =
    body.patch && typeof body.patch === "object" && !Array.isArray(body.patch)
      ? (body.patch as Record<string, unknown>)
      : undefined;
  if (!notificationId || (!text && !patch)) {
    return NextResponse.json(
      { error: "notification_id and text or patch are required" },
      { status: 400 }
    );
  }

  const db = createServerClient();
  const result = await handleContractDataReviewDecision(db, {
    userId: user.id,
    notificationId,
    text: text || undefined,
    patch,
  });
  if (
    result.ok &&
    result.status === "captured" &&
    typeof result.case_id === "string"
  ) {
    const opCase = await getOperationalCase(db, result.case_id);
    if (opCase && opCase.context_jsonb?.e2e_controlled !== true) {
      await kickContractPendingAfterDataCapture({
        db,
        opCase,
        source: "contract_data_review_inbox",
      });
    }
  }
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
