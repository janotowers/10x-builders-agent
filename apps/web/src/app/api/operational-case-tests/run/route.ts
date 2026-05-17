import { NextResponse } from "next/server";
import {
  createServerClient,
  getOperationalCase,
  insertOperationalCaseEvent,
  markCaseProcessing,
  updateOperationalCase,
} from "@agents/db";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await request.json()) as { case_id?: string };
    const caseId = body.case_id?.trim();
    if (!caseId) {
      return NextResponse.json({ error: "case_id required" }, { status: 400 });
    }

    const db = createServerClient();
    const opCase = await getOperationalCase(db, caseId);
    if (!opCase || opCase.user_id !== user.id) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (opCase.context_jsonb?.created_from !== "case_type_settings_test") {
      return NextResponse.json({ error: "not_a_settings_test_case" }, { status: 400 });
    }

    const locked = await markCaseProcessing(db, opCase.id, opCase.version, 1);
    if (!locked) {
      return NextResponse.json({ error: "case_busy" }, { status: 409 });
    }

    const fresh = await getOperationalCase(db, opCase.id);
    if (!fresh) {
      return NextResponse.json({ error: "case_not_found_after_lock" }, { status: 404 });
    }

    await insertOperationalCaseEvent(db, {
      caseId: fresh.id,
      eventType: "step_completed",
      actor: "system",
      payload: {
        kind: "controlled_test_started",
        source: "case_type_settings",
        safe_mode: true,
        note: "Prueba controlada: solo se valida intake y se deja pendiente la siguiente acción. Tools send/write/publish requieren confirmación humana.",
      },
    });

    const updated = await updateOperationalCase(db, fresh.id, fresh.version, {
      status: "paused",
      currentStep:
        fresh.current_step === "intake" ? "awaiting_documents" : fresh.current_step,
      nextActionAt: null,
      context: {
        ...fresh.context_jsonb,
        test_mode: true,
        controlled_test_last_run_at: new Date().toISOString(),
        controlled_test_status: "passed_safe_checks",
      },
    });

    if (!updated) {
      return NextResponse.json({ error: "concurrent_update" }, { status: 409 });
    }

    await insertOperationalCaseEvent(db, {
      caseId: updated.id,
      eventType: "state_changed",
      actor: "system",
      payload: {
        source: "case_type_settings_test",
        status: updated.status,
        current_step: updated.current_step,
        result: "safe_readiness_passed",
        next_action: "Revisar readiness de tools send/write/publish antes de ejecutar acciones reales.",
      },
    });

    const events = await db
      .from("operational_case_events")
      .select("*")
      .eq("case_id", updated.id)
      .order("created_at", { ascending: true })
      .limit(80);

    return NextResponse.json({
      ok: true,
      case: updated,
      events: events.data ?? [],
      toolCalls: [],
    });
  } catch (err) {
    console.error("[POST /api/operational-case-tests/run] failed:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
