import { NextResponse } from "next/server";
import {
  createServerClient,
  getGlobalOperationalCaseTypeBySlug,
  getOperationalCase,
  getOperationalCaseTypeById,
  insertOperationalCaseEvent,
  markCaseProcessing,
  updateOperationalCase,
} from "@agents/db";
import type {
  OperationalCase,
  OperationalCaseEvent,
  OperationalCaseFlowStep,
} from "@agents/types";
import { createClient } from "@/lib/supabase/server";

async function effectiveFlowForCase(
  db: ReturnType<typeof createServerClient>,
  opCase: OperationalCase
): Promise<OperationalCaseFlowStep[]> {
  const caseType = await getOperationalCaseTypeById(db, opCase.case_type_id);
  const ownFlow = Array.isArray(caseType?.operational_flow_jsonb)
    ? caseType.operational_flow_jsonb
    : [];
  if (ownFlow.length > 0 || !caseType?.user_id) return ownFlow;
  const globalCaseType = await getGlobalOperationalCaseTypeBySlug(
    db,
    caseType.case_type
  );
  return Array.isArray(globalCaseType?.operational_flow_jsonb)
    ? globalCaseType.operational_flow_jsonb
    : [];
}

function buildFlowProgress(params: {
  opCase: OperationalCase;
  events: OperationalCaseEvent[];
  flow: OperationalCaseFlowStep[];
}) {
  return params.flow.map((step, index) => {
    const evidence = params.events
      .filter((event) => {
        const payload = event.payload_jsonb as Record<string, unknown> | null;
        return (
          payload?.current_step === step.step_key ||
          payload?.step === step.step_key ||
          payload?.step_key === step.step_key ||
          (index === 0 && payload?.kind === "controlled_test_started")
        );
      })
      .map((event) => `event:${event.event_type}`);
    const status =
      params.opCase.current_step === step.step_key
        ? "in_progress"
        : evidence.length > 0
          ? "completed"
          : "pending";
    return {
      step_key: step.step_key,
      step_label: step.step_label,
      status,
      evidence,
    };
  });
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
        note: "Prueba segura inicial: valida intake y deja pendiente la siguiente acción. Tools de envío/escritura/publicación no se ejecutan automáticamente y requieren confirmación humana.",
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
        next_action: "Revisar readiness de tools de envío/escritura/publicación antes de operación real completa.",
      },
    });

    const events = await db
      .from("operational_case_events")
      .select("*")
      .eq("case_id", updated.id)
      .order("created_at", { ascending: true })
      .limit(80);

    const flow = await effectiveFlowForCase(db, updated);
    const flowProgress = buildFlowProgress({
      opCase: updated,
      events: (events.data ?? []) as OperationalCaseEvent[],
      flow,
    });

    return NextResponse.json({
      ok: true,
      case: updated,
      events: events.data ?? [],
      toolCalls: [],
      flowProgress,
    });
  } catch (err) {
    console.error("[POST /api/operational-case-tests/run] failed:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
