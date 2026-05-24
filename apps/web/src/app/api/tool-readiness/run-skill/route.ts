import { NextResponse } from "next/server";
import { runAgent, TOOL_CATALOG } from "@agents/agent";
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
} from "@agents/db";
import type {
  OperationalCase,
  OperationalCaseEvent,
  OperationalCaseFlowSkill,
  OperationalCaseFlowStep,
  ToolCall,
  ToolApprovalPolicy,
} from "@agents/types";
import { createClient } from "@/lib/supabase/server";
import { ensureAgentToolDepsWired } from "@/lib/agent/wire-tool-deps";

export const maxDuration = 180;

type SkillRunBody = {
  case_type_id?: string;
  case_id?: string;
  skill_slug?: string;
};

type SkillTestContract = {
  expected_context_keys: string[];
  expected_events?: string[];
  expected_tool_calls?: string[];
  required_tools_policy: "all_ready_and_tested" | "none";
  allow_partial_sources?: boolean;
};

const SKILL_TEST_CONTRACTS: Record<string, SkillTestContract> = {
  "perform-comparable-analysis": {
    expected_context_keys: ["comparables_analysis"],
    required_tools_policy: "all_ready_and_tested",
    allow_partial_sources: true,
  },
  "prepare-listing-price": {
    expected_context_keys: ["pricing_proposal"],
    expected_events: ["human_decision:price_proposed"],
    expected_tool_calls: ["notify_user"],
    required_tools_policy: "none",
  },
};

const SKILL_TEST_INTERNAL_WRITE_TOOLS = new Set([
  "operational_case_update_state",
  "operational_case_add_event",
]);

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
    text: `${safeText}\n\n[Preview truncado. Ver resultado completo en el artefacto guardado.]`,
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

function skillInFlow(flow: OperationalCaseFlowStep[], skillSlug: string) {
  for (const step of flow) {
    const found = (step.step_skills ?? []).find(
      (skill) => skill.skill_slug === skillSlug
    );
    if (found) return { step, skill: found as OperationalCaseFlowSkill };
  }
  return null;
}

function normalizeSkillTestContract(value: unknown): SkillTestContract | null {
  if (!isRecord(value)) return null;
  const expected = Array.isArray(value.expected_context_keys)
    ? value.expected_context_keys.filter(
        (item): item is string => typeof item === "string" && item.trim().length > 0
      )
    : [];
  const events = Array.isArray(value.expected_events)
    ? value.expected_events.filter(
        (item): item is string => typeof item === "string" && item.trim().length > 0
      )
    : undefined;
  const toolCalls = Array.isArray(value.expected_tool_calls)
    ? value.expected_tool_calls.filter(
        (item): item is string => typeof item === "string" && item.trim().length > 0
      )
    : undefined;
  const policy =
    value.required_tools_policy === "none" ? "none" : "all_ready_and_tested";
  return {
    expected_context_keys: expected,
    expected_events: events,
    expected_tool_calls: toolCalls,
    required_tools_policy: policy,
    allow_partial_sources: value.allow_partial_sources === true,
  };
}

async function listToolCallsForTurn(
  db: ReturnType<typeof createServerClient>,
  turnId: string
): Promise<ToolCall[]> {
  const { data, error } = await db
    .from("tool_calls")
    .select("*")
    .eq("turn_id", turnId)
    .order("created_at", { ascending: true })
    .limit(100);
  if (error) {
    console.warn("[run-skill] tool_calls lookup failed:", error);
    return [];
  }
  return (data ?? []) as ToolCall[];
}

async function testedToolsForUser(
  db: ReturnType<typeof createServerClient>,
  userId: string,
  toolIds: string[]
) {
  const tested = new Set<string>();
  if (toolIds.length === 0) return tested;
  const { data: sessions } = await db
    .from("agent_sessions")
    .select("id")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(50);
  const sessionIds = (sessions ?? [])
    .map((row) => (row as { id?: unknown }).id)
    .filter((id): id is string => typeof id === "string");
  if (sessionIds.length === 0) return tested;
  const { data: calls } = await db
    .from("tool_calls")
    .select("tool_name")
    .in("session_id", sessionIds)
    .in("tool_name", toolIds)
    .eq("status", "executed")
    .order("created_at", { ascending: false })
    .limit(200);
  for (const call of calls ?? []) {
    const toolName = (call as { tool_name?: unknown }).tool_name;
    if (typeof toolName === "string") tested.add(toolName);
  }
  return tested;
}

function contextHasKey(context: Record<string, unknown>, dottedKey: string) {
  let current: unknown = context;
  for (const part of dottedKey.split(".")) {
    if (!isRecord(current) || !(part in current)) return false;
    current = current[part];
  }
  return current != null;
}

function contextValue(context: Record<string, unknown>, dottedKey: string) {
  let current: unknown = context;
  for (const part of dottedKey.split(".")) {
    if (!isRecord(current) || !(part in current)) return undefined;
    current = current[part];
  }
  return current;
}

function positiveNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function validatePricingProposal(value: unknown) {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return ["pricing_proposal debe ser un objeto."];
  }
  const salida = value.salida;
  const ideal = value.ideal;
  const minimo = value.minimo;
  if (!positiveNumber(salida)) errors.push("pricing_proposal.salida debe ser mayor a 0.");
  if (!positiveNumber(ideal)) errors.push("pricing_proposal.ideal debe ser mayor a 0.");
  if (!positiveNumber(minimo)) errors.push("pricing_proposal.minimo debe ser mayor a 0.");
  const salidaNumber = positiveNumber(salida) ? salida : null;
  const idealNumber = positiveNumber(ideal) ? ideal : null;
  const minimoNumber = positiveNumber(minimo) ? minimo : null;
  if (salidaNumber != null && idealNumber != null && salidaNumber < idealNumber) {
    errors.push("pricing_proposal.salida debe ser mayor o igual a ideal.");
  }
  if (idealNumber != null && minimoNumber != null && idealNumber < minimoNumber) {
    errors.push("pricing_proposal.ideal debe ser mayor o igual a minimo.");
  }
  if (typeof value.rationale !== "string" || value.rationale.trim().length === 0) {
    errors.push("pricing_proposal.rationale no debe estar vacio.");
  }
  if (!Array.isArray(value.comparables_used) || value.comparables_used.length === 0) {
    errors.push("pricing_proposal.comparables_used debe incluir al menos un comparable.");
  }
  return errors;
}

function validateArtifactValue(key: string, value: unknown) {
  if (key === "pricing_proposal") return validatePricingProposal(value);
  return [];
}

function roundPrice(value: number) {
  const step =
    value > 5_000_000
      ? 50_000
      : value >= 1_000_000
        ? 10_000
        : value >= 100_000
          ? 5_000
          : 500;
  return Math.ceil(value / step) * step;
}

function numberAtPath(root: unknown, path: string[]) {
  let current = root;
  for (const part of path) {
    if (!isRecord(current)) return null;
    current = current[part];
  }
  return typeof current === "number" && Number.isFinite(current) ? current : null;
}

function stringAtPath(root: unknown, path: string[]) {
  let current = root;
  for (const part of path) {
    if (!isRecord(current)) return null;
    current = current[part];
  }
  return typeof current === "string" && current.trim() ? current.trim() : null;
}

function arrayIds(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (isRecord(item) && typeof item.id === "string" ? item.id : null))
    .filter((item): item is string => item != null)
    .slice(0, 8);
}

function derivePricingProposalFromComparables(context: Record<string, unknown>) {
  const analysis = context.comparables_analysis;
  if (!isRecord(analysis)) return null;
  const priceP25 = numberAtPath(analysis, ["stats", "price", "p25"]);
  const priceP50 = numberAtPath(analysis, ["stats", "price", "p50"]);
  if (priceP25 == null || priceP50 == null || priceP25 <= 0 || priceP50 <= 0) {
    return null;
  }
  const ideal = roundPrice(priceP50);
  const minimo = roundPrice(priceP25);
  const salida = roundPrice(ideal * 1.05);
  const activeCount = numberAtPath(analysis, ["stats", "active_count"]) ?? 0;
  const historicalCount =
    numberAtPath(analysis, ["stats", "historical_reference_count"]) ?? 0;
  const internalCount =
    numberAtPath(analysis, ["stats", "internal_inventory_count"]) ?? 0;
  const notes = stringAtPath(analysis, ["notes"]);
  return {
    salida,
    ideal,
    minimo,
    currency: "MXN",
    rationale:
      notes ??
      `Propuesta basada en precio total publicado: p25=${priceP25}, p50=${priceP50}. Muestra: ${activeCount} activas, ${historicalCount} historicas y ${internalCount} internas.`,
    comparables_used: [
      ...arrayIds(analysis.active_listings),
      ...arrayIds(analysis.historical_references),
      ...arrayIds(analysis.closed_deals),
      ...arrayIds(analysis.internal_inventory),
    ].slice(0, 8),
    approval_status: "pending",
  };
}

async function repairPricingProposalForSkillTest(
  db: ReturnType<typeof createServerClient>,
  opCase: OperationalCase
): Promise<{ opCase: OperationalCase; repaired: boolean; reason?: string }> {
  const context = (opCase.context_jsonb ?? {}) as Record<string, unknown>;
  const current = context.pricing_proposal;
  const currentErrors = validatePricingProposal(current);
  if (currentErrors.length === 0) return { opCase, repaired: false };
  const proposal = derivePricingProposalFromComparables(context);
  if (!proposal) return { opCase, repaired: false };
  const { updateOperationalCase } = await import("@agents/db");
  const updated = await updateOperationalCase(db, opCase.id, opCase.version, {
    context: {
      ...context,
      pricing_proposal: proposal,
      skill_test_repairs: {
        ...(isRecord(context.skill_test_repairs)
          ? context.skill_test_repairs
          : {}),
        "prepare-listing-price": {
          repaired_at: new Date().toISOString(),
          reason: currentErrors,
        },
      },
    },
  });
  if (!updated) return { opCase, repaired: false };
  await insertOperationalCaseEvent(db, {
    caseId: opCase.id,
    eventType: "human_decision",
    actor: "system",
    payload: {
      kind: "price_proposed",
      source: "tool_readiness_deterministic_repair",
      salida: proposal.salida,
      ideal: proposal.ideal,
      minimo: proposal.minimo,
    },
  });
  return {
    opCase: updated,
    repaired: true,
    reason: currentErrors.join(" "),
  };
}

function eventMatchesSpec(event: OperationalCaseEvent, spec: string) {
  const [eventType, expectedKind] = spec.split(":");
  if (event.event_type !== eventType) return false;
  if (!expectedKind) return true;
  const payload = event.payload_jsonb;
  return isRecord(payload) && payload.kind === expectedKind;
}

function validateContract(
  contract: SkillTestContract,
  before: OperationalCase,
  after: OperationalCase,
  events: OperationalCaseEvent[],
  toolCalls: ToolCall[]
) {
  const context = (after.context_jsonb ?? {}) as Record<string, unknown>;
  const beforeContext = (before.context_jsonb ?? {}) as Record<string, unknown>;
  const missing_context_keys = contract.expected_context_keys.filter(
    (key) => !contextHasKey(context, key)
  );
  const created_context_keys = contract.expected_context_keys.filter(
    (key) => contextHasKey(context, key) && !contextHasKey(beforeContext, key)
  );
  const artifact_errors = contract.expected_context_keys.flatMap((key) =>
    validateArtifactValue(key, contextValue(context, key))
  );
  const missing_events = (contract.expected_events ?? []).filter(
    (spec) => !events.some((event) => eventMatchesSpec(event, spec))
  );
  const missing_tool_calls = (contract.expected_tool_calls ?? []).filter(
    (toolName) =>
      !toolCalls.some(
        (call) => call.tool_name === toolName && call.status === "executed"
      )
  );
  return {
    ok:
      missing_context_keys.length === 0 &&
      artifact_errors.length === 0 &&
      missing_events.length === 0 &&
      missing_tool_calls.length === 0,
    missing_context_keys,
    created_context_keys,
    missing_events,
    missing_tool_calls,
    artifact_errors,
  };
}

function buildSkillTestMessage(params: {
  opCase: OperationalCase;
  skill: OperationalCaseFlowSkill;
  stepKey: string;
  contract: SkillTestContract;
}) {
  const lines = [
    `Prueba controlada de habilidad desde Ajustes para el caso ${params.opCase.id}.`,
    `Ejecuta únicamente la habilidad ${params.skill.skill_slug} del paso ${params.stepKey}.`,
    `Objetivo de prueba: generar o actualizar en context_jsonb estas claves: ${params.contract.expected_context_keys.join(", ")}.`,
    "Usa las tools disponibles sólo si son necesarias. No ejecutes escrituras reales de alto riesgo sin confirmación humana; si una fuente no está disponible, registra la limitación y continúa cuando el contrato lo permita.",
  ];
  if (params.skill.skill_slug === "prepare-listing-price") {
    lines.push(
      "Antes de guardar pricing_proposal, calcula numeros concretos desde context_jsonb.comparables_analysis.stats.price. Si hay p25/p50/p75 disponibles, no uses placeholders ni ceros. Debes llamar notify_user con kind='price_approval' para pedir aprobacion al asesor interno. Inserta tambien operational_case_add_event con event_type='human_decision' y payload.kind='price_proposed'. Usa status='waiting_internal', no waiting_external, cuando esperas respuesta del asesor interno."
    );
  }
  return lines.join(" ");
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

    const body = (await request.json().catch(() => ({}))) as SkillRunBody;
    const caseTypeId = cleanText(body.case_type_id);
    const caseId = cleanText(body.case_id);
    const skillSlug = cleanText(body.skill_slug);
    if (!caseTypeId || !skillSlug) {
      return NextResponse.json(
        { error: "case_type_id and skill_slug are required" },
        { status: 400 }
      );
    }

    const db = createServerClient();
    const caseType = await getOperationalCaseTypeById(db, caseTypeId);
    if (!caseType || (caseType.user_id && caseType.user_id !== user.id)) {
      return NextResponse.json({ error: "case_type_not_found" }, { status: 404 });
    }

    const opCase = caseId
      ? await getOperationalCase(db, caseId)
      : await latestSettingsTestCase(db, user.id, caseType.id);
    if (!opCase || opCase.user_id !== user.id) {
      return NextResponse.json(
        { error: "test_case_required", hint: "Crea primero un caso de prueba." },
        { status: 400 }
      );
    }

    const flow = await effectiveFlowForCaseType(db, caseType);
    const located = skillInFlow(flow, skillSlug);
    if (!located) {
      return NextResponse.json(
        { error: "skill_not_in_flow", skill_slug: skillSlug },
        { status: 400 }
      );
    }

    const flowContract = normalizeSkillTestContract(
      (located.skill as unknown as { test_contract?: unknown }).test_contract
    );
    const contract =
      flowContract ??
      SKILL_TEST_CONTRACTS[skillSlug] ?? {
        expected_context_keys: [],
        required_tools_policy: "all_ready_and_tested",
      };
    if (contract.required_tools_policy === "all_ready_and_tested") {
      const toolIds = (located.skill.skill_tools ?? []).map((tool) => tool.tool_id);
      const tested = await testedToolsForUser(db, user.id, toolIds);
      const missingTestedTools = toolIds.filter((toolId) => !tested.has(toolId));
      if (missingTestedTools.length > 0) {
        return NextResponse.json(
          {
            error: "skill_blocked_by_tools",
            skill_slug: skillSlug,
            missing_tested_tools: missingTestedTools,
            hint:
              "Primero prueba exitosamente las tools requeridas por esta habilidad.",
          },
          { status: 400 }
        );
      }
    }

    ensureAgentToolDepsWired();
    const startedEvent = await insertOperationalCaseEvent(db, {
      caseId: opCase.id,
      eventType: "step_completed",
      actor: "system",
      payload: {
        kind: "skill_test_started",
        source: "tool_readiness_run_skill",
        skill_slug: skillSlug,
        step_key: located.step.step_key,
        expected_context_keys: contract.expected_context_keys,
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
          /* ignore invalid GitHub token for skill tests */
        }
      }
    }

    const session = await getOrCreateSession(db, user.id, "case_runner");
    const catalogById = new Map(TOOL_CATALOG.map((tool) => [tool.id, tool]));
    const toolApprovalPolicy: ToolApprovalPolicy = {};
    for (const tool of located.skill.skill_tools ?? []) {
      const risk = catalogById.get(tool.tool_id)?.risk ?? "medium";
      toolApprovalPolicy[tool.tool_id] =
        risk === "low" ? "auto_execute" : "request_approval";
    }
    if (isSettingsTestCase(opCase)) {
      for (const toolId of SKILL_TEST_INTERNAL_WRITE_TOOLS) {
        toolApprovalPolicy[toolId] = "auto_execute";
      }
    }

    const agentResult = await runAgent({
      message: buildSkillTestMessage({
        opCase,
        skill: located.skill,
        stepKey: located.step.step_key,
        contract,
      }),
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
      forcedSkillId: skillSlug,
      caseId: opCase.id,
      toolApprovalPolicy,
    });

    let after = (await getOperationalCase(db, opCase.id)) ?? opCase;
    let deterministicRepair:
      | { applied: false }
      | { applied: true; reason?: string } = { applied: false };
    if (skillSlug === "prepare-listing-price") {
      const repair = await repairPricingProposalForSkillTest(db, after);
      after = repair.opCase;
      deterministicRepair = repair.repaired
        ? { applied: true, reason: repair.reason }
        : { applied: false };
    }
    const recentEvents = (await getRecentOperationalCaseEvents(db, opCase.id, 100)).filter(
      (event) => event.created_at >= startedEvent.created_at
    );
    const toolCalls = await listToolCallsForTurn(db, agentResult.turnId);
    const validation = validateContract(
      contract,
      opCase,
      after,
      recentEvents,
      toolCalls
    );
    const status = validation.ok
      ? "tested_ok"
      : agentResult.pendingConfirmation
        ? "partial"
        : "tested_failed";
    const sourceToolIds = new Set(
      (located.skill.skill_tools ?? []).map((tool) => tool.tool_id)
    );
    const sourceToolCalls = toolCalls.filter((call) =>
      sourceToolIds.has(call.tool_name)
    );
    const internalToolCalls = toolCalls.filter((call) =>
      SKILL_TEST_INTERNAL_WRITE_TOOLS.has(call.tool_name)
    );
    const otherToolCalls = toolCalls.filter(
      (call) =>
        !sourceToolIds.has(call.tool_name) &&
        !SKILL_TEST_INTERNAL_WRITE_TOOLS.has(call.tool_name)
    );
    const toToolCallSummary = (call: ToolCall) => ({
      tool_name: call.tool_name,
      status: call.status,
    });
    const toToolCallDetails = (call: ToolCall) => ({
      tool_name: call.tool_name,
      status: call.status,
      arguments_json: call.arguments_json,
      result_json: call.result_json,
    });
    const afterContext = (after.context_jsonb ?? {}) as Record<string, unknown>;
    const artifacts = Object.fromEntries(
      contract.expected_context_keys
        .map((key) => [key, contextValue(afterContext, key)] as const)
        .filter(([, value]) => value !== undefined)
    );
    const preview = responsePreview(agentResult.response);

    await insertOperationalCaseEvent(db, {
      caseId: opCase.id,
      eventType: "state_changed",
      actor: "system",
      payload: {
        kind: "skill_test_completed",
        source: "tool_readiness_run_skill",
        skill_slug: skillSlug,
        step_key: located.step.step_key,
        status,
        validation,
        pending_confirmation: Boolean(agentResult.pendingConfirmation),
        deterministic_repair: deterministicRepair,
        source_tool_calls: sourceToolCalls.map(toToolCallSummary),
        internal_tool_calls: internalToolCalls.map(toToolCallSummary),
        other_tool_calls: otherToolCalls.map(toToolCallSummary),
        tool_calls: toolCalls.map(toToolCallSummary),
      },
    });

    return NextResponse.json({
      ok: validation.ok,
      status,
      skill_slug: skillSlug,
      step_key: located.step.step_key,
      expected_context_keys: contract.expected_context_keys,
      validation,
      pending_confirmation: Boolean(agentResult.pendingConfirmation),
      deterministic_repair: deterministicRepair,
      response_preview: preview.text,
      response_preview_truncated: preview.truncated,
      artifacts,
      source_tool_calls: sourceToolCalls.map(toToolCallDetails),
      internal_tool_calls: internalToolCalls.map(toToolCallDetails),
      other_tool_calls: otherToolCalls.map(toToolCallDetails),
      tool_calls: toolCalls.map(toToolCallDetails),
      case: after,
    });
  } catch (err) {
    console.error("[POST /api/tool-readiness/run-skill] failed:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
