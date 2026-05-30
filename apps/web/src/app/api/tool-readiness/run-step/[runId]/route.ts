import { NextResponse } from "next/server";
import { createServerClient, getOperationalCaseTestRun } from "@agents/db";
import { createClient } from "@/lib/supabase/server";

function toolDurationMs(call: {
  created_at?: string | null;
  finished_at?: string | null;
}) {
  if (!call.created_at) return null;
  const start = new Date(call.created_at).getTime();
  const end = call.finished_at ? new Date(call.finished_at).getTime() : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

async function toolProgressForTurn(
  db: ReturnType<typeof createServerClient>,
  turnId: string | null | undefined
) {
  if (!turnId) {
    return {
      phase: "starting",
      label: "Preparando ejecución de la habilidad raíz",
      tool_calls: [],
      last_tool_call: null,
    };
  }
  const { data, error } = await db
    .from("tool_calls")
    .select("tool_name,status,created_at,finished_at")
    .eq("turn_id", turnId)
    .order("created_at", { ascending: true })
    .limit(100);
  if (error) {
    console.warn("[run-step status] tool progress lookup failed:", error);
    return {
      phase: "unknown",
      label: "No se pudo leer progreso de tools",
      tool_calls: [],
      last_tool_call: null,
    };
  }
  const calls = (data ?? []).map((call) => ({
    tool_name: String(call.tool_name ?? ""),
    status: String(call.status ?? ""),
    created_at: typeof call.created_at === "string" ? call.created_at : null,
    finished_at: typeof call.finished_at === "string" ? call.finished_at : null,
    duration_ms: toolDurationMs(call),
  }));
  const last = calls.at(-1) ?? null;
  const terminalCount = calls.filter((call) =>
    call.status === "executed" || call.status === "failed" || call.status === "rejected"
  ).length;
  const active = calls.find(
    (call) =>
      call.status === "approved" || call.status === "pending_confirmation"
  );
  const phase = calls.length === 0 ? "thinking" : active ? "tool_running" : "finalizing";
  const label =
    calls.length === 0
      ? "La raíz está razonando antes de llamar tools"
      : active
        ? `Ejecutando ${active.tool_name}`
        : "Tools terminadas; validando contrato y guardando resultado";
  return {
    phase,
    label,
    tool_calls: calls,
    last_tool_call: last,
    completed_tool_count: terminalCount,
    total_tool_calls: calls.length,
  };
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ runId: string }> }
) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { runId } = await context.params;
  const db = createServerClient();
  const run = await getOperationalCaseTestRun(db, runId);
  if (!run || run.user_id !== user.id) {
    return NextResponse.json({ error: "run_not_found" }, { status: 404 });
  }

  const progress = await toolProgressForTurn(db, run.turn_id);

  return NextResponse.json({
    ok: true,
    run_id: run.id,
    run_status: run.status,
    progress,
    started_at: run.started_at,
    finished_at: run.finished_at,
    created_at: run.created_at,
    updated_at: run.updated_at,
    error: run.error,
    result: run.result_jsonb ?? {},
  });
}
