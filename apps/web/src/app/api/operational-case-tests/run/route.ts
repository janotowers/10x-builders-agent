import { NextResponse } from "next/server";
import { runAgent } from "@agents/agent";
import {
  createServerClient,
  decryptToken,
  getGlobalOperationalCaseTypeBySlug,
  getGoogleCalendarAccessToken,
  getOperationalCase,
  getOperationalCaseTypeById,
  getOrCreateSession,
  getProfile,
  getUserIntegrations,
  getUserSkillSettings,
  getUserToolSettings,
  insertOperationalCaseEvent,
  markCaseProcessing,
  updateOperationalCase,
} from "@agents/db";
import type {
  OperationalCase,
  OperationalCaseEvent,
  OperationalCaseFlowStep,
  ToolCall,
} from "@agents/types";
import { createClient } from "@/lib/supabase/server";
import { ensureAgentToolDepsWired } from "@/lib/agent/wire-tool-deps";

type RunMode = "safe_check" | "agent_e2e";

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

async function listToolCallsForCase(
  db: ReturnType<typeof createServerClient>,
  caseId: string
): Promise<ToolCall[]> {
  const { data, error } = await db
    .from("tool_calls")
    .select("*")
    .contains("arguments_json", { case_id: caseId })
    .order("created_at", { ascending: true })
    .limit(100);
  if (error) {
    console.warn("[operational-case-tests/run] tool_calls lookup failed:", error);
    return [];
  }
  return (data ?? []) as ToolCall[];
}

function buildFlowProgress(params: {
  opCase: OperationalCase;
  events: OperationalCaseEvent[];
  flow: OperationalCaseFlowStep[];
  toolCalls?: ToolCall[];
}) {
  return params.flow.map((step, index) => {
    const stepToolIds = new Set<string>();
    for (const tool of step.step_tools ?? []) stepToolIds.add(tool.tool_id);
    for (const skill of step.step_skills ?? []) {
      for (const tool of skill.skill_tools ?? []) stepToolIds.add(tool.tool_id);
    }
    const toolEvidence = (params.toolCalls ?? []).filter((call) =>
      stepToolIds.has(call.tool_name)
    );
    const eventEvidence = params.events
      .filter((event) => {
        const payload = event.payload_jsonb as Record<string, unknown> | null;
        return (
          payload?.current_step === step.step_key ||
          payload?.step === step.step_key ||
          payload?.step_key === step.step_key ||
          (index === 0 &&
            (payload?.kind === "controlled_test_started" ||
              payload?.kind === "controlled_test_e2e_started"))
        );
      })
      .map((event) => `event:${event.event_type}`);
    const evidence = [
      ...eventEvidence,
      ...toolEvidence.map((call) => `tool:${call.tool_name}:${call.status}`),
    ];
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

function buildCaseE2ETickMessage(opCase: OperationalCase): string {
  return [
    `Tick E2E de prueba desde Ajustes para el caso ${opCase.id} (case_type=${opCase.case_type}, status=${opCase.status}, current_step=${opCase.current_step ?? "(none)"}).`,
    "Ejecuta la siguiente acción según la skill del caso de prueba, como en operación real. Las tools de riesgo alto (publicar, envíos, escrituras) pueden requerir aprobación humana en la UI si el runtime lo solicita.",
  ].join(" ");
}

async function runSafeCheck(
  db: ReturnType<typeof createServerClient>,
  fresh: OperationalCase
) {
  await insertOperationalCaseEvent(db, {
    caseId: fresh.id,
    eventType: "step_completed",
    actor: "system",
    payload: {
      kind: "controlled_test_started",
      source: "case_type_settings",
      safe_mode: true,
      note: "Prueba segura inicial (fase 1): valida intake y avance mínimo sin invocar el agente ni tools externas.",
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
    return { error: "concurrent_update" as const, status: 409 };
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
      next_action:
        "Opcional: ejecutar prueba E2E con agente para simular un tick operacional real.",
    },
  });

  return { case: updated };
}

async function runAgentE2E(
  db: ReturnType<typeof createServerClient>,
  fresh: OperationalCase,
  userId: string
) {
  ensureAgentToolDepsWired();

  await insertOperationalCaseEvent(db, {
    caseId: fresh.id,
    eventType: "step_completed",
    actor: "system",
    payload: {
      kind: "controlled_test_e2e_started",
      source: "case_type_settings",
      note: "Prueba E2E (fase 2): un tick del agente sobre el caso de prueba, con tools reales y HITL según riesgo.",
    },
  });

  const profile = await getProfile(db, userId);
  const toolSettings = await getUserToolSettings(db, userId);
  const skillSettings = await getUserSkillSettings(db, userId);
  const integrations = await getUserIntegrations(db, userId);

  const githubIntegration = integrations.find((i) => i.provider === "github");
  let githubToken: string | undefined;
  if (githubIntegration) {
    const raw = (githubIntegration as unknown as { encrypted_tokens?: string })
      .encrypted_tokens;
    if (raw) {
      try {
        githubToken = decryptToken(raw);
      } catch {
        /* sin token GitHub */
      }
    }
  }

  const googleCalendarAccessToken =
    (await getGoogleCalendarAccessToken(db, userId)) ?? undefined;
  const session = await getOrCreateSession(db, userId, "case_runner");

  const agentResult = await runAgent({
    message: buildCaseE2ETickMessage(fresh),
    userId,
    sessionId: session.id,
    systemPrompt: profile.agent_system_prompt,
    db,
    enabledTools: toolSettings,
    enabledSkills: skillSettings,
    integrations,
    githubToken,
    userTimezone: profile.timezone,
    userName: profile.name,
    userEmail: profile.email,
    userPhone: profile.phone,
    businessBrain: profile.business_brain ?? {},
    isUnggaAdmin: profile.is_ungga_admin ?? false,
    channel: "case_runner",
    googleCalendarAccessToken,
    autoApproveTools: false,
    caseId: fresh.id,
  });

  const afterAgent = await getOperationalCase(db, fresh.id);
  const version = afterAgent?.version ?? fresh.version;
  const updated = await updateOperationalCase(db, fresh.id, version, {
    context: {
      ...(afterAgent?.context_jsonb ?? fresh.context_jsonb),
      test_mode: true,
      controlled_test_e2e_last_run_at: new Date().toISOString(),
      controlled_test_e2e_pending_confirmation: Boolean(
        agentResult.pendingConfirmation
      ),
      controlled_test_status: agentResult.pendingConfirmation
        ? "e2e_pending_hitl"
        : "e2e_tick_completed",
    },
  });

  await insertOperationalCaseEvent(db, {
    caseId: fresh.id,
    eventType: "state_changed",
    actor: "system",
    payload: {
      source: "case_type_settings_test_e2e",
      result: agentResult.pendingConfirmation
        ? "e2e_pending_hitl"
        : "e2e_tick_completed",
      pending_confirmation: Boolean(agentResult.pendingConfirmation),
      response_preview: agentResult.response?.slice(0, 500) ?? null,
    },
  });

  return {
    case: updated ?? afterAgent ?? fresh,
    agent: {
      pending_confirmation: Boolean(agentResult.pendingConfirmation),
      response_preview: agentResult.response?.slice(0, 800) ?? null,
    },
  };
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

    const body = (await request.json()) as { case_id?: string; mode?: RunMode };
    const caseId = body.case_id?.trim();
    const mode: RunMode =
      body.mode === "agent_e2e" ? "agent_e2e" : "safe_check";
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

    let resultCase: OperationalCase;
    let agentMeta: { pending_confirmation: boolean; response_preview: string | null } | null =
      null;

    if (mode === "agent_e2e") {
      const e2e = await runAgentE2E(db, fresh, user.id);
      resultCase = e2e.case;
      agentMeta = e2e.agent;
    } else {
      const safe = await runSafeCheck(db, fresh);
      if ("error" in safe) {
        return NextResponse.json({ error: safe.error }, { status: safe.status });
      }
      resultCase = safe.case;
    }

    const events = await db
      .from("operational_case_events")
      .select("*")
      .eq("case_id", resultCase.id)
      .order("created_at", { ascending: true })
      .limit(80);

    const toolCalls = await listToolCallsForCase(db, resultCase.id);
    const flow = await effectiveFlowForCase(db, resultCase);
    const flowProgress = buildFlowProgress({
      opCase: resultCase,
      events: (events.data ?? []) as OperationalCaseEvent[],
      flow,
      toolCalls,
    });

    return NextResponse.json({
      ok: true,
      mode,
      case: resultCase,
      events: events.data ?? [],
      toolCalls,
      flowProgress,
      agent: agentMeta,
    });
  } catch (err) {
    console.error("[POST /api/operational-case-tests/run] failed:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
