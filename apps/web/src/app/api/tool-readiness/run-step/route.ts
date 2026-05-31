import { after, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { runAgent } from "@agents/agent";
import {
  createOperationalCaseTestRun,
  createServerClient,
  decryptToken,
  finishOperationalCaseTestRun,
  getGlobalOperationalCaseTypeBySlug,
  listAccountAssets,
  getGoogleCalendarAccessToken,
  getOperationalCase,
  getOperationalCaseTypeById,
  getOperationalCaseTestRun,
  getOrCreateSession,
  getProfile,
  getRecentOperationalCaseEvents,
  getUserIntegrations,
  getUserSkillSettings,
  getUserToolSettings,
  insertOperationalCaseEvent,
  markOperationalCaseTestRunRunning,
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
import {
  COMPARABLES_COMPLETE_N4_SCENARIO_ID,
  COMPARABLES_INSUFFICIENT_N4_SCENARIO_ID,
  comparablesUsableCount,
  validateComparablesCaseOutcome,
  validateComparablesCompleteStepOutcome,
  validateComparablesInsufficientStepOutcome,
} from "@/lib/operational-cases/comparables-analysis-validation";
import {
  contractDraftHasStoredOutput,
  validateContractApprovedSendStepOutcome,
  validateContractChangesRequestedStepOutcome,
  validateContractDraftReadyStepOutcome,
  validateContractHitlPrerequisites,
  validateContractSignedStepOutcome,
  validateContractTemplateMissingStepOutcome,
} from "@/lib/operational-cases/contract-review-validation";
import {
  parseGenerateDocumentRenderResult,
  syncContractDraftFromToolCalls,
} from "@/lib/operational-cases/contract-draft-document";
import {
  validatePriceAdjustedAndApprovedStepOutcome,
  validatePriceApprovedStepOutcome,
  validatePriceProposalStepOutcome,
} from "@/lib/operational-cases/pricing-proposal-validation";
import { runBusinessDecisionStepTest } from "@/lib/operational-cases/step-test-business-decision";
import type { BusinessDecisionKind } from "@/lib/business-decisions/registry";
import { stepTestContextEnrichment } from "@/lib/operational-cases/step-test-seeds";
import { isolateContextForStepTest } from "@/lib/operational-cases/settings-test-run-isolation";
import {
  stepTestCatalogSlugForRootSkill,
  stepTestScenariosFor,
  type StepTestExpect,
  type StepTestSeed,
  type StepTestScenarioDef,
} from "@/lib/operational-cases/step-test-scenario-registry";
import {
  missingTestedTools,
  testedToolsForUser,
} from "@/lib/operational-cases/tested-tools-for-user";
import { readinessToolIdsForStep } from "@/lib/operational-cases/tool-surface-classification";

export const maxDuration = 800;

type StepRunBody = {
  case_type_id?: string;
  case_id?: string;
  step_key?: string;
  scenario_id?: string;
};

type StepToolCall = {
  tool_name: string;
  status: string;
  arguments_json?: Record<string, unknown>;
  result_json?: Record<string, unknown>;
  created_at?: string;
  finished_at?: string | null;
};

function scenarioCatalogSlugForCaseType(caseType: { case_type: string; default_skill_slug: string }) {
  return stepTestCatalogSlugForRootSkill(caseType.default_skill_slug) ?? caseType.case_type;
}

function scenariosForStep(
  caseType: { case_type: string; default_skill_slug: string },
  stepKey: string
): StepTestScenarioDef[] {
  return stepTestScenariosFor(scenarioCatalogSlugForCaseType(caseType), stepKey);
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

const DOCX_TEMPLATE_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const COMMISSION_CONTRACT_TEMPLATE_ASSET_KEY = "commission_contract_template";

async function userHasCommissionContractDocxTemplate(
  db: ReturnType<typeof createServerClient>,
  userId: string
) {
  const assets = await listAccountAssets(db, {
    userId,
    assetKeys: [COMMISSION_CONTRACT_TEMPLATE_ASSET_KEY],
  });
  return assets.some((asset) => asset.content_type === DOCX_TEMPLATE_MIME);
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
  const next = { ...base, ...patch };
  if (isRecord(patch.property_data)) {
    const basePd = isRecord(base.property_data)
      ? (base.property_data as Record<string, unknown>)
      : {};
    const patchPd = patch.property_data as Record<string, unknown>;
    const mergedPd: Record<string, unknown> = { ...basePd, ...patchPd };
    if (isRecord(basePd.address) || isRecord(patchPd.address)) {
      mergedPd.address = {
        ...(isRecord(basePd.address) ? basePd.address : {}),
        ...(isRecord(patchPd.address) ? patchPd.address : {}),
      };
    }
    next.property_data = mergedPd;
  }
  return next;
}

async function applyStepSeed(
  db: ReturnType<typeof createServerClient>,
  opCase: OperationalCase,
  seed: StepTestSeed | undefined,
  scenarioId: string
): Promise<OperationalCase> {
  if (!seed) return opCase;
  const rawContext = isRecord(opCase.context_jsonb)
    ? (opCase.context_jsonb as Record<string, unknown>)
    : {};
  const context = isolateContextForStepTest(rawContext, scenarioId);
  const updated = await updateOperationalCase(db, opCase.id, opCase.version, {
    currentStep: seed.current_step,
    status: seed.status as OperationalCaseStatus | undefined,
    context: mergeContext(context, seed.context_patch),
  });
  return updated ?? opCase;
}

async function enrichStepTestSeed(
  db: ReturnType<typeof createServerClient>,
  opCase: OperationalCase,
  scenarioId: string
): Promise<OperationalCase> {
  const context = isRecord(opCase.context_jsonb)
    ? (opCase.context_jsonb as Record<string, unknown>)
    : {};
  const enrichment = stepTestContextEnrichment(scenarioId, context);
  if (!enrichment) return opCase;
  const merged = mergeContext(context, enrichment);
  if (scenarioId === COMPARABLES_INSUFFICIENT_N4_SCENARIO_ID) {
    delete merged.comparables_analysis;
  }
  const updated = await updateOperationalCase(db, opCase.id, opCase.version, {
    context: merged,
  });
  return updated ?? opCase;
}

function contextValue(context: Record<string, unknown>, key: string) {
  return context[key];
}

function validateStepExpect(
  expect: StepTestExpect,
  after: OperationalCase,
  events: OperationalCaseEvent[],
  toolCalls: StepToolCall[],
  options?: { step_key?: string; scenario_id?: string }
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
  const missing_tool_calls = (expect.expected_tool_calls ?? []).filter(
    (toolName) =>
      !toolCalls.some(
        (call) =>
          call.tool_name === toolName &&
          (call.status === "executed" || call.status === "pending_confirmation")
      )
  );
  let comparables_outcome_errors: string[] = [];
  let comparables_usable_count: number | null = null;
  let comparables_defensible: boolean | null = null;
  let step_outcome_errors: string[] = [];
  const notifyUserExecuted = toolCalls.some(
    (call) =>
      call.tool_name === "notify_user" &&
      (call.status === "executed" || call.status === "pending_confirmation")
  );
  if (options?.step_key === "comparables_in_progress") {
    const comparablesParams = {
      comparables_analysis: contextValue(context, "comparables_analysis"),
      current_step: after.current_step ?? "",
      status: after.status ?? "",
      notify_user_executed: notifyUserExecuted,
    };
    const outcome =
      options.scenario_id === COMPARABLES_INSUFFICIENT_N4_SCENARIO_ID
        ? validateComparablesInsufficientStepOutcome(comparablesParams)
        : options.scenario_id === COMPARABLES_COMPLETE_N4_SCENARIO_ID
          ? validateComparablesCompleteStepOutcome(comparablesParams)
          : validateComparablesCaseOutcome(comparablesParams);
    comparables_outcome_errors = outcome.errors;
    comparables_usable_count = outcome.usable_count;
    comparables_defensible = outcome.defensible;
  }
  if (options?.step_key === "price_proposal_pending") {
    const scenarioId = options.scenario_id ?? "";
    if (scenarioId === "price_proposal_pending_advisor_approves") {
      const outcome = validatePriceApprovedStepOutcome({
        pricing_proposal: contextValue(context, "pricing_proposal"),
        current_step: after.current_step ?? "",
        status: after.status ?? "",
        price_approved_event: events.some((event) =>
          eventMatchesSpec(event, "human_decision:price_approved")
        ),
      });
      step_outcome_errors = outcome.errors;
    } else if (scenarioId === "price_proposal_pending_advisor_adjusts") {
      const outcome = validatePriceAdjustedAndApprovedStepOutcome({
        pricing_proposal: contextValue(context, "pricing_proposal"),
        current_step: after.current_step ?? "",
        status: after.status ?? "",
        expected: { salida: 26000, ideal: 25000, minimo: 20000 },
        price_adjusted_event: events.some((event) =>
          eventMatchesSpec(event, "human_decision:price_adjusted_and_approved")
        ),
      });
      step_outcome_errors = outcome.errors;
    } else {
      const outcome = validatePriceProposalStepOutcome({
        pricing_proposal: contextValue(context, "pricing_proposal"),
        current_step: after.current_step ?? "",
        status: after.status ?? "",
        price_proposed_event: events.some((event) =>
          eventMatchesSpec(event, "human_decision:price_proposed")
        ),
        notify_user_executed: notifyUserExecuted,
      });
      step_outcome_errors = outcome.errors;
    }
  }
  if (options?.step_key === "contract_pending") {
    const scenarioId = options.scenario_id ?? "";
    const context = (after.context_jsonb ?? {}) as Record<string, unknown>;
    const generateRendered = toolCalls.some((call) => {
      if (call.tool_name !== "generate_document_from_template") return false;
      if (call.status !== "executed") return false;
      return parseGenerateDocumentRenderResult(call.result_json) != null;
    });
    const hitlScenarios = new Set([
      "contract_pending_advisor_approves_send",
      "contract_pending_advisor_requests_changes",
      "contract_pending_owner_signed",
    ]);
    if (hitlScenarios.has(scenarioId)) {
      const prereq = validateContractHitlPrerequisites(context);
      if (!prereq.ok) {
        step_outcome_errors.push(...prereq.errors);
      }
    }
    if (scenarioId === "contract_pending_advisor_approves_send") {
      const outcome = validateContractApprovedSendStepOutcome({
        current_step: after.current_step ?? "",
        status: after.status ?? "",
        approved_event: events.some(
          (event) =>
            eventMatchesSpec(event, "human_decision:contract_approved_for_owner") ||
            eventMatchesSpec(event, "human_decision:contract_revised_and_approved")
        ),
        sent_event: events.some((event) => eventMatchesSpec(event, "reminder_sent")),
      });
      step_outcome_errors = outcome.errors;
    } else if (scenarioId === "contract_pending_advisor_requests_changes") {
      const outcome = validateContractChangesRequestedStepOutcome({
        current_step: after.current_step ?? "",
        status: after.status ?? "",
        changes_event: events.some((event) =>
          eventMatchesSpec(event, "human_decision:contract_changes_requested")
        ),
      });
      step_outcome_errors = outcome.errors;
    } else if (scenarioId === "contract_pending_owner_signed") {
      const outcome = validateContractSignedStepOutcome({
        current_step: after.current_step ?? "",
        status: after.status ?? "",
        contract_signed_event: events.some((event) =>
          eventMatchesSpec(event, "step_completed:contract_signed")
        ),
      });
      step_outcome_errors = outcome.errors;
    } else if (scenarioId === "contract_pending_template_missing") {
      const outcome = validateContractTemplateMissingStepOutcome({
        current_step: after.current_step ?? "",
        status: after.status ?? "",
        contract_drafted_event: events.some((event) =>
          eventMatchesSpec(event, "human_decision:contract_drafted")
        ),
        notify_user_executed: notifyUserExecuted,
        generate_document_rendered: generateRendered,
        contract_draft_has_output_path: contractDraftHasStoredOutput(context),
      });
      step_outcome_errors = outcome.errors;
    } else if (scenarioId === "contract_pending_draft_review") {
      const outcome = validateContractDraftReadyStepOutcome({
        current_step: after.current_step ?? "",
        status: after.status ?? "",
        contract_drafted_event: events.some((event) =>
          eventMatchesSpec(event, "human_decision:contract_drafted")
        ),
        notify_user_executed: notifyUserExecuted,
        generate_document_rendered: generateRendered,
        contract_draft_has_output_path: contractDraftHasStoredOutput(context),
      });
      step_outcome_errors = outcome.errors;
    }
    if (
      scenarioId === "contract_pending_draft_review" ||
      scenarioId === "contract_pending_template_missing"
    ) {
      if (!contextHasKey(context, "pricing_proposal")) {
        step_outcome_errors.push("pricing_proposal debe existir en context_jsonb.");
      }
    }
  }
  if (options?.step_key === "photos_scheduled") {
    if (after.status !== "waiting_external") {
      step_outcome_errors.push("status debe ser waiting_external tras proponer horarios.");
    }
    const telegramExecuted = toolCalls.some(
      (call) =>
        call.tool_name === "telegram_send_message_to_contact" &&
        (call.status === "executed" || call.status === "pending_confirmation")
    );
    if (!telegramExecuted) {
      step_outcome_errors.push(
        "telegram_send_message_to_contact debe ejecutarse para proponer horarios."
      );
    }
  }
  if (options?.step_key === "package_ready") {
    if (after.status !== "paused") {
      step_outcome_errors.push("status debe ser paused cuando el preflight falla.");
    }
    if (!notifyUserExecuted) {
      step_outcome_errors.push("notify_user debe explicar qué falta para publicar.");
    }
    const rawPhotos = contextValue(context, "raw_photos");
    if (Array.isArray(rawPhotos) && rawPhotos.length >= 5) {
      step_outcome_errors.push(
        "raw_photos no debe tener 5+ fotos en el escenario de preflight bloqueado."
      );
    }
  }
  return {
    ok:
      missing_context_keys.length === 0 &&
      missing_events.length === 0 &&
      wrong_current_step.length === 0 &&
      wrong_status.length === 0 &&
      missing_tool_calls.length === 0 &&
      comparables_outcome_errors.length === 0 &&
      step_outcome_errors.length === 0,
    missing_context_keys,
    missing_events,
    missing_tool_calls,
    wrong_current_step,
    wrong_status,
    comparables_outcome_errors,
    comparables_usable_count,
    comparables_defensible,
    step_outcome_errors,
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
    .select("tool_name, status, arguments_json, result_json, created_at, finished_at")
    .eq("turn_id", turnId)
    .order("created_at", { ascending: true })
    .limit(100);
  if (error) {
    console.warn("[run-step] tool_calls lookup failed:", error);
    return [];
  }
  return (data ?? []) as StepToolCall[];
}

async function executeStepTestRun(runId: string) {
  const db = createServerClient();
  const run = await getOperationalCaseTestRun(db, runId);
  if (!run || run.status !== "queued") return;

  const startedMs = Date.now();
  let turnId: string | null = randomUUID();
  await markOperationalCaseTestRunRunning(db, runId, { turnId });
  try {
    const request = run.request_jsonb ?? {};
    const caseTypeId = cleanText(request.case_type_id);
    const caseId = cleanText(request.case_id);
    const stepKey = cleanText(request.step_key);
    const scenarioId = cleanText(request.scenario_id);
    const caseType = await getOperationalCaseTypeById(db, caseTypeId);
    if (!caseType) throw new Error("case_type_not_found");

    const rootSkillSlug = cleanText(caseType.default_skill_slug);
    if (!rootSkillSlug) throw new Error("default_skill_missing");

    const scenarios = scenariosForStep(caseType, stepKey);
    const scenario =
      scenarios.find((item) => item.id === scenarioId) ?? scenarios[0];
    if (!scenario) throw new Error("step_test_not_configured");

    let opCase = await getOperationalCase(db, caseId);
    if (!opCase || opCase.user_id !== run.user_id) {
      throw new Error("test_case_required");
    }
    if (!isSettingsTestCase(opCase)) {
      throw new Error("not_settings_test_case");
    }

    opCase = await applyStepSeed(db, opCase, scenario.seed, scenario.id);
    opCase = await enrichStepTestSeed(db, opCase, scenario.id);
    const before = opCase;

    ensureAgentToolDepsWired();
    const startedEvent = await insertOperationalCaseEvent(db, {
      caseId: opCase.id,
      eventType: "step_completed",
      actor: "system",
      payload: {
        kind: "step_test_started",
        source: "tool_readiness_run_step",
        run_id: runId,
        step_key: stepKey,
        scenario_id: scenario.id,
        root_skill_slug: rootSkillSlug,
      },
    });

    const profile = await getProfile(db, run.user_id);
    const [toolSettings, skillSettings, integrations, googleCalendarAccessToken] =
      await Promise.all([
        getUserToolSettings(db, run.user_id),
        getUserSkillSettings(db, run.user_id),
        getUserIntegrations(db, run.user_id),
        getGoogleCalendarAccessToken(db, run.user_id),
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

    const allStepToolIds = Array.isArray(request.all_step_tool_ids)
      ? request.all_step_tool_ids.filter((item): item is string => typeof item === "string")
      : [];
    const session = await getOrCreateSession(db, run.user_id, "case_runner");
    const toolApprovalPolicy = buildSettingsTestToolApprovalPolicy(allStepToolIds);

    let agentResponse = "";
    let pendingConfirmation = false;
    let toolCalls: StepToolCall[] = [];
    let businessDecisionMessage: string | null = null;

    if (scenario.execution === "business_decision") {
      const kind = (scenario.business_decision_kind ??
        "price_approval") as BusinessDecisionKind;
      const decisionResult = await runBusinessDecisionStepTest({
        db,
        userId: run.user_id,
        opCase,
        kind,
        decisionText: scenario.decision_text ?? "aprobar precio",
      });
      businessDecisionMessage =
        typeof decisionResult.message === "string" ? decisionResult.message : null;
    } else {
      const agentResult = await runAgent({
        message: scenario.message,
        userId: run.user_id,
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
        turnId,
        toolApprovalPolicy,
      });
      turnId = agentResult.turnId;
      agentResponse = agentResult.response ?? "";
      pendingConfirmation = Boolean(agentResult.pendingConfirmation);
      toolCalls = await listToolCallsForTurn(db, agentResult.turnId);
      const synced = await syncContractDraftFromToolCalls(db, opCase, toolCalls);
      opCase = synced;
    }

    let afterCase = (await getOperationalCase(db, opCase.id)) ?? opCase;
    if (
      scenario.id === "contract_pending_draft_review" &&
      afterCase.status !== "waiting_internal"
    ) {
      const context = (afterCase.context_jsonb ?? {}) as Record<string, unknown>;
      const generateRendered = toolCalls.some((call) => {
        if (call.tool_name !== "generate_document_from_template") return false;
        if (call.status !== "executed") return false;
        return parseGenerateDocumentRenderResult(call.result_json) != null;
      });
      if (generateRendered && contractDraftHasStoredOutput(context)) {
        const repaired = await updateOperationalCase(
          db,
          afterCase.id,
          afterCase.version,
          {
            status: "waiting_internal",
            currentStep: "contract_pending",
          }
        );
        if (repaired) afterCase = repaired;
      }
    }
    if (
      scenario.id === COMPARABLES_INSUFFICIENT_N4_SCENARIO_ID &&
      afterCase.status !== "waiting_internal"
    ) {
      const context = (afterCase.context_jsonb ?? {}) as Record<string, unknown>;
      const notifyUserExecuted = toolCalls.some(
        (call) =>
          call.tool_name === "notify_user" &&
          (call.status === "executed" || call.status === "pending_confirmation")
      );
      if (
        afterCase.current_step === "comparables_in_progress" &&
        notifyUserExecuted &&
        comparablesUsableCount(context.comparables_analysis) === 0
      ) {
        const repaired = await updateOperationalCase(
          db,
          afterCase.id,
          afterCase.version,
          {
            status: "waiting_internal",
            currentStep: "comparables_in_progress",
          }
        );
        if (repaired) afterCase = repaired;
      }
    }
    const recentEvents = (await getRecentOperationalCaseEvents(db, opCase.id, 100)).filter(
      (event) => event.created_at >= startedEvent.created_at
    );
    const validation = validateStepExpect(
      scenario.expect,
      afterCase,
      recentEvents,
      toolCalls,
      { step_key: stepKey, scenario_id: scenario.id }
    );
    const status = validation.ok
      ? "tested_ok"
      : pendingConfirmation
        ? "partial"
        : "tested_failed";
    const preview = responsePreview(
      businessDecisionMessage ?? agentResponse ?? null
    );
    const durationMs = Date.now() - startedMs;

    await insertOperationalCaseEvent(db, {
      caseId: opCase.id,
      eventType: "state_changed",
      actor: "system",
      payload: {
        kind: "step_test_completed",
        source: "tool_readiness_run_step",
        run_id: runId,
        step_key: stepKey,
        scenario_id: scenario.id,
        root_skill_slug: rootSkillSlug,
        execution: scenario.execution ?? "agent",
        status,
        duration_ms: durationMs,
        validation,
        tool_calls: toolCalls,
        business_decision_message: businessDecisionMessage,
      },
    });

    const result = {
      ok: validation.ok,
      status,
      step_key: stepKey,
      scenario_id: scenario.id,
      scenario_label: scenario.label,
      scenario_summary: scenario.summary ?? null,
      scenario_seed_summary: scenario.seed_summary ?? null,
      scenario_expect_summary: scenario.expect_summary ?? null,
      root_skill_slug: rootSkillSlug,
      validation,
      expect: scenario.expect,
      pending_confirmation: pendingConfirmation,
      execution: scenario.execution ?? "agent",
      business_decision_message: businessDecisionMessage,
      response_preview: preview.text,
      response_preview_truncated: preview.truncated,
      tool_calls: toolCalls,
      case: afterCase,
      seed_applied: scenario.seed ?? null,
      before_step: before.current_step,
      before_status: before.status,
      run_id: runId,
      duration_ms: durationMs,
      completed_at: new Date().toISOString(),
    };
    await finishOperationalCaseTestRun(db, {
      runId,
      status: "completed",
      result,
      turnId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[run-step] async test run failed:", err);
    await finishOperationalCaseTestRun(db, {
      runId,
      status: "failed",
      error: message,
      result: {
        ok: false,
        status: "tested_failed",
        error: message,
        run_id: runId,
        duration_ms: Date.now() - startedMs,
      },
      turnId,
    });
  }
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

    const rootSkillSlug = cleanText(caseType.default_skill_slug);
    if (!rootSkillSlug) {
      return NextResponse.json(
        { error: "default_skill_missing" },
        { status: 400 }
      );
    }

    const scenarios = scenariosForStep(caseType, stepKey);
    if (scenarios.length === 0) {
      return NextResponse.json(
        {
          error: "step_test_not_configured",
          hint: "No hay escenario de prueba para este paso. Regístralo en el catálogo de escenarios o en el futuro step_test_contract del flow.",
        },
        { status: 400 }
      );
    }
    const scenario =
      scenarios.find((item) => item.id === scenarioId) ?? scenarios[0];

    if (scenario.id === "contract_pending_template_missing") {
      const hasTemplate = await userHasCommissionContractDocxTemplate(db, user.id);
      if (hasTemplate) {
        return NextResponse.json(
          {
            error: "guardrail_requires_no_template",
            hint:
              "Elimina la plantilla DOCX (commission_contract_template) en Paso 5 antes de este escenario. Con plantilla cargada el flujo genera borrador (Salida A), no la rama de plantilla faltante.",
          },
          { status: 400 }
        );
      }
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

    const allStepToolIds = Array.from(
      new Set([
        ...(flowStep.step_skills ?? []).flatMap((skill) =>
          (skill.skill_tools ?? []).map((tool) => tool.tool_id)
        ),
        ...(flowStep.step_tools ?? []).map((tool) => tool.tool_id),
      ].filter(Boolean))
    );
    const readinessStepToolIds = readinessToolIdsForStep(flowStep);
    if (readinessStepToolIds.length > 0) {
      const tested = await testedToolsForUser(db, user.id, readinessStepToolIds);
      const missing = missingTestedTools(readinessStepToolIds, tested);
      if (missing.length > 0) {
        return NextResponse.json(
          {
            error: "step_blocked_by_tools",
            step_key: stepKey,
            missing_tested_tools: missing,
            hint:
              "Primero prueba exitosamente las tools de integración/acción del paso (N1). Las tools internas de plataforma no requieren N1.",
          },
          { status: 400 }
        );
      }
    }

    const run = await createOperationalCaseTestRun(db, {
      userId: user.id,
      caseId: opCase.id,
      caseTypeId: caseType.id,
      level: "n4",
      stepKey,
      scenarioId: scenario.id,
      rootSkillSlug,
      request: {
        case_type_id: caseTypeId,
        case_id: opCase.id,
        step_key: stepKey,
        scenario_id: scenario.id,
        all_step_tool_ids: allStepToolIds,
      },
    });

    after(() => {
      void executeStepTestRun(run.id);
    });

    return NextResponse.json(
      {
        ok: true,
        async: true,
        run_id: run.id,
        run_status: run.status,
        step_key: stepKey,
        scenario_id: scenario.id,
        scenario_label: scenario.label,
        root_skill_slug: rootSkillSlug,
      },
      { status: 202 }
    );
  } catch (err) {
    console.error("[POST /api/tool-readiness/run-step] failed:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
