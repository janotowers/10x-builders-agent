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
  getRecentOperationalCaseEvents,
  getUserIntegrations,
  getUserSkillSettings,
  getUserToolSettings,
  insertOperationalCaseEvent,
  updateOperationalCase,
} from "@agents/db";
import type {
  OperationalCase,
  OperationalCaseEvent,
  OperationalCaseFlowStep,
  OperationalCaseStatus,
} from "@agents/types";
import { createClient } from "@/lib/supabase/server";
import { ensureAgentToolDepsWired } from "@/lib/agent/wire-tool-deps";
import { buildSettingsTestToolApprovalPolicy } from "@/lib/operational-cases/settings-test-tool-policy";
import { STEP_TEST_SCENARIO_INDEX } from "@/lib/operational-cases/step-test-scenarios";

export const maxDuration = 180;

type StepRunBody = {
  case_type_id?: string;
  case_id?: string;
  step_key?: string;
  scenario_id?: string;
};

type StepTestSeed = {
  current_step?: string;
  status?: string;
  context_patch?: Record<string, unknown>;
};

type StepTestExpect = {
  current_step?: string;
  status?: string;
  expected_events?: string[];
  expected_context_keys?: string[];
};

type StepTestScenarioDef = {
  id: string;
  label: string;
  seed?: StepTestSeed;
  expect: StepTestExpect;
  message: string;
};

const STEP_TEST_SCENARIO_DETAILS: Record<
  string,
  Record<string, Omit<StepTestScenarioDef, "id" | "label">>
> = {
  property_optioning: {
    awaiting_documents_outreach: {
      seed: {
        current_step: "awaiting_documents",
        status: "active",
      },
      expect: {
        current_step: "awaiting_documents",
        status: "waiting_external",
        expected_events: ["reminder_sent"],
      },
      message:
        "Prueba controlada de paso (N4) para awaiting_documents. Actúa como la habilidad raíz del caso operacional. Si el contacto externo aún no tiene la solicitud de documentos, envíala por el canal configurado, registra reminder_sent y deja status=waiting_external. No avances current_step a documents_received en esta prueba.",
    },
  },
};

function scenariosForStep(caseTypeSlug: string, stepKey: string): StepTestScenarioDef[] {
  const metas = STEP_TEST_SCENARIO_INDEX[caseTypeSlug]?.[stepKey] ?? [];
  const details = STEP_TEST_SCENARIO_DETAILS[caseTypeSlug] ?? {};
  return metas
    .map((meta) => {
      const detail = details[meta.id];
      if (!detail) return null;
      return { ...meta, ...detail };
    })
    .filter((item): item is StepTestScenarioDef => item != null);
}

const RESPONSE_PREVIEW_MAX_CHARS = 6000;

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSettingsTestCase(opCase: OperationalCase) {
  const context = opCase.context_jsonb;
  if (!isRecord(context)) return false;
  return (
    context.created_from === "case_type_settings_test" &&
    (context.test_mode === true || context.test_mode === "true")
  );
}

function responsePreview(response: string | undefined | null) {
  if (!response) return { text: null, truncated: false };
  if (response.length <= RESPONSE_PREVIEW_MAX_CHARS) {
    return { text: response, truncated: false };
  }
  const candidate = response.slice(0, RESPONSE_PREVIEW_MAX_CHARS);
  const lastLineBreak = candidate.lastIndexOf("\n");
  const safeText =
    lastLineBreak > RESPONSE_PREVIEW_MAX_CHARS * 0.8
      ? candidate.slice(0, lastLineBreak).trimEnd()
      : candidate.trimEnd();
  return {
    text: `${safeText}\n\n[Preview truncado.]`,
    truncated: true,
  };
}

async function effectiveFlowForCaseType(
  db: ReturnType<typeof createServerClient>,
  caseType: Awaited<ReturnType<typeof getOperationalCaseTypeById>>
) {
  const ownFlow = Array.isArray(caseType?.operational_flow_jsonb)
    ? (caseType.operational_flow_jsonb as OperationalCaseFlowStep[])
    : [];
  if (ownFlow.length > 0 || !caseType?.user_id) return ownFlow;
  const globalCaseType = await getGlobalOperationalCaseTypeBySlug(
    db,
    caseType.case_type
  );
  return Array.isArray(globalCaseType?.operational_flow_jsonb)
    ? (globalCaseType.operational_flow_jsonb as OperationalCaseFlowStep[])
    : [];
}

async function latestSettingsTestCase(
  db: ReturnType<typeof createServerClient>,
  userId: string,
  caseTypeId: string
): Promise<OperationalCase | null> {
  const { data, error } = await db
    .from("operational_cases")
    .select("*")
    .eq("user_id", userId)
    .eq("case_type_id", caseTypeId)
    .eq("context_jsonb->>created_from", "case_type_settings_test")
    .eq("context_jsonb->>test_mode", "true")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as OperationalCase | null) ?? null;
}

function stepInFlow(flow: OperationalCaseFlowStep[], stepKey: string) {
  return flow.find((step) => step.step_key === stepKey) ?? null;
}

function eventMatchesSpec(event: OperationalCaseEvent, spec: string) {
  const [eventType, expectedKind] = spec.split(":");
  if (event.event_type !== eventType) return false;
  if (!expectedKind) return true;
  const payload = event.payload_jsonb;
  return isRecord(payload) && payload.kind === expectedKind;
}

function contextHasKey(context: Record<string, unknown>, dottedKey: string) {
  let current: unknown = context;
  for (const part of dottedKey.split(".")) {
    if (!isRecord(current) || !(part in current)) return false;
    current = current[part];
  }
  return current != null;
}

function mergeContext(
  base: Record<string, unknown>,
  patch?: Record<string, unknown>
) {
  if (!patch) return base;
  return { ...base, ...patch };
}

async function applyStepSeed(
  db: ReturnType<typeof createServerClient>,
  opCase: OperationalCase,
  seed: StepTestSeed | undefined
): Promise<OperationalCase> {
  if (!seed) return opCase;
  const context = isRecord(opCase.context_jsonb)
    ? (opCase.context_jsonb as Record<string, unknown>)
    : {};
  const updated = await updateOperationalCase(db, opCase.id, opCase.version, {
    currentStep: seed.current_step,
    status: seed.status as OperationalCaseStatus | undefined,
    context: mergeContext(context, seed.context_patch),
  });
  return updated ?? opCase;
}

function validateStepExpect(
  expect: StepTestExpect,
  after: OperationalCase,
  events: OperationalCaseEvent[]
) {
  const context = (after.context_jsonb ?? {}) as Record<string, unknown>;
  const missing_context_keys = (expect.expected_context_keys ?? []).filter(
    (key) => !contextHasKey(context, key)
  );
  const missing_events = (expect.expected_events ?? []).filter(
    (spec) => !events.some((event) => eventMatchesSpec(event, spec))
  );
  const wrong_current_step =
    expect.current_step && after.current_step !== expect.current_step
      ? [expect.current_step]
      : [];
  const wrong_status =
    expect.status && after.status !== expect.status ? [expect.status] : [];
  return {
    ok:
      missing_context_keys.length === 0 &&
      missing_events.length === 0 &&
      wrong_current_step.length === 0 &&
      wrong_status.length === 0,
    missing_context_keys,
    missing_events,
    wrong_current_step,
    wrong_status,
    actual_current_step: after.current_step,
    actual_status: after.status,
  };
}

async function listToolCallsForTurn(
  db: ReturnType<typeof createServerClient>,
  turnId: string
) {
  const { data, error } = await db
    .from("tool_calls")
    .select("tool_name, status")
    .eq("turn_id", turnId)
    .order("created_at", { ascending: true })
    .limit(100);
  if (error) {
    console.warn("[run-step] tool_calls lookup failed:", error);
    return [];
  }
  return (data ?? []) as Array<{ tool_name: string; status: string }>;
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

    const body = (await request.json().catch(() => ({}))) as StepRunBody;
    const caseTypeId = cleanText(body.case_type_id);
    const caseId = cleanText(body.case_id);
    const stepKey = cleanText(body.step_key);
    const scenarioId = cleanText(body.scenario_id);
    if (!caseTypeId || !stepKey) {
      return NextResponse.json(
        { error: "case_type_id and step_key are required" },
        { status: 400 }
      );
    }

    const db = createServerClient();
    const caseType = await getOperationalCaseTypeById(db, caseTypeId);
    if (!caseType || (caseType.user_id && caseType.user_id !== user.id)) {
      return NextResponse.json({ error: "case_type_not_found" }, { status: 404 });
    }

    const scenarios = scenariosForStep(caseType.case_type, stepKey);
    if (scenarios.length === 0) {
      return NextResponse.json(
        {
          error: "step_test_not_configured",
          hint: "No hay escenario N4 para este paso. Ver STEP_TEST_SCENARIOS o step_test_contract en el flow.",
        },
        { status: 400 }
      );
    }
    const scenario =
      scenarios.find((item) => item.id === scenarioId) ?? scenarios[0];

    const rootSkillSlug = cleanText(caseType.default_skill_slug);
    if (!rootSkillSlug) {
      return NextResponse.json(
        { error: "default_skill_missing" },
        { status: 400 }
      );
    }

    let opCase = caseId
      ? await getOperationalCase(db, caseId)
      : await latestSettingsTestCase(db, user.id, caseType.id);
    if (!opCase || opCase.user_id !== user.id) {
      return NextResponse.json(
        { error: "test_case_required", hint: "Crea primero un caso de prueba." },
        { status: 400 }
      );
    }
    if (!isSettingsTestCase(opCase)) {
      return NextResponse.json(
        { error: "not_settings_test_case" },
        { status: 400 }
      );
    }

    const flow = await effectiveFlowForCaseType(db, caseType);
    const flowStep = stepInFlow(flow, stepKey);
    if (!flowStep) {
      return NextResponse.json({ error: "step_not_in_flow", step_key: stepKey }, { status: 400 });
    }

    opCase = await applyStepSeed(db, opCase, scenario.seed);
    const before = opCase;

    ensureAgentToolDepsWired();
    const startedEvent = await insertOperationalCaseEvent(db, {
      caseId: opCase.id,
      eventType: "step_completed",
      actor: "system",
      payload: {
        kind: "step_test_started",
        source: "tool_readiness_run_step",
        step_key: stepKey,
        scenario_id: scenario.id,
        root_skill_slug: rootSkillSlug,
      },
    });

    const profile = await getProfile(db, user.id);
    const [toolSettings, skillSettings, integrations, googleCalendarAccessToken] =
      await Promise.all([
        getUserToolSettings(db, user.id),
        getUserSkillSettings(db, user.id),
        getUserIntegrations(db, user.id),
        getGoogleCalendarAccessToken(db, user.id),
      ]);
    const githubIntegration = integrations.find((item) => item.provider === "github");
    let githubToken: string | undefined;
    if (githubIntegration) {
      const raw = (githubIntegration as unknown as { encrypted_tokens?: string })
        .encrypted_tokens;
      if (raw) {
        try {
          githubToken = decryptToken(raw);
        } catch {
          /* ignore */
        }
      }
    }

    const session = await getOrCreateSession(db, user.id, "case_runner");
    const toolApprovalPolicy = buildSettingsTestToolApprovalPolicy();

    const agentResult = await runAgent({
      message: scenario.message,
      userId: user.id,
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
      googleCalendarAccessToken: googleCalendarAccessToken ?? undefined,
      autoApproveTools: false,
      forcedSkillId: rootSkillSlug,
      caseId: opCase.id,
      toolApprovalPolicy,
    });

    const after = (await getOperationalCase(db, opCase.id)) ?? opCase;
    const recentEvents = (await getRecentOperationalCaseEvents(db, opCase.id, 100)).filter(
      (event) => event.created_at >= startedEvent.created_at
    );
    const validation = validateStepExpect(scenario.expect, after, recentEvents);
    const toolCalls = await listToolCallsForTurn(db, agentResult.turnId);
    const status = validation.ok
      ? "tested_ok"
      : agentResult.pendingConfirmation
        ? "partial"
        : "tested_failed";
    const preview = responsePreview(agentResult.response);

    await insertOperationalCaseEvent(db, {
      caseId: opCase.id,
      eventType: "state_changed",
      actor: "system",
      payload: {
        kind: "step_test_completed",
        source: "tool_readiness_run_step",
        step_key: stepKey,
        scenario_id: scenario.id,
        root_skill_slug: rootSkillSlug,
        status,
        validation,
        tool_calls: toolCalls,
      },
    });

    return NextResponse.json({
      ok: validation.ok,
      status,
      step_key: stepKey,
      scenario_id: scenario.id,
      scenario_label: scenario.label,
      root_skill_slug: rootSkillSlug,
      validation,
      pending_confirmation: Boolean(agentResult.pendingConfirmation),
      response_preview: preview.text,
      response_preview_truncated: preview.truncated,
      tool_calls: toolCalls,
      case: after,
      seed_applied: scenario.seed ?? null,
      before_step: before.current_step,
      before_status: before.status,
    });
  } catch (err) {
    console.error("[POST /api/tool-readiness/run-step] failed:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
