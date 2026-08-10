import { NextResponse } from "next/server";
import {
  flushPendingAiUsageMeterWrites,
  recordOpenRouterCallUsage,
  runAgent,
  runWithAiUsageContext,
  summarizeSkillQualificationEvidence,
  type OpenRouterUsagePayload,
} from "@agents/agent";
import {
  createServerClient,
  createSession,
  createStudioQualificationRun,
  finishStudioQualificationRun,
  getProfile,
  getStudioSkillRepairProposalForRun,
  getUserSkillSettings,
  getUserToolSettings,
  insertEvidenceRecord,
  listAiUsageEventsForStudioQualificationRun,
  listStudioQualificationRunsForArtifact,
  markStudioQualificationRunRunning,
  markStudioQualificationRunsStale,
} from "@agents/db";
import {
  operationalJudgeVerdictSchema,
  type OperationalJudgeVerdict,
} from "@agents/workflows";
import { createClient } from "@/lib/supabase/server";
import {
  evaluateReusableSkillMechanicalGate,
  mapStudioQualificationRunToView,
  parseStudioQualificationArtifactRequest,
  StudioQualificationRequestError,
  summarizeQualificationUsage,
  type ReusableSkillQualificationPlan,
} from "@/lib/workflow-studio/reusable-skill-qualification";
import {
  loadReusableSkillQualificationPlan,
  reusableSkillQualificationSystemBoundary,
} from "@/lib/workflow-studio/reusable-skill-qualification-server";

export const maxDuration = 180;

const JUDGE_RESPONSE_JSON_SCHEMA = {
  name: "studio_operational_judge_verdict",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "schema_version",
      "verdict",
      "summary",
      "confidence",
      "criteria",
      "remediation_items",
    ],
    properties: {
      schema_version: { type: "string", const: "1" },
      verdict: { type: "string", enum: ["pass", "fail"] },
      summary: { type: "string", minLength: 1 },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      criteria: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["criterion_id", "passed", "score", "explanation"],
          properties: {
            criterion_id: { type: "string", minLength: 1 },
            passed: { type: "boolean" },
            score: { type: "number", minimum: 0, maximum: 1 },
            explanation: { type: "string", minLength: 1 },
          },
        },
      },
      remediation_items: {
        type: "array",
        items: { type: "string", minLength: 1 },
      },
    },
  },
} as const;

function parseJsonContent(content: unknown): unknown {
  if (typeof content !== "string") return content;
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return JSON.parse(fenced?.[1] ?? trimmed);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function authenticateUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

async function judgeExecution(params: {
  runId: string;
  plan: ReusableSkillQualificationPlan;
  executorOutput: string;
  mechanicalEvidence: Record<string, unknown>;
}): Promise<OperationalJudgeVerdict> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not configured");
  const modelId = params.plan.models.judgeModelId;
  const prompt = [
    "Independently judge one controlled reusable-skill qualification run.",
    "Use only the supplied draft, fictional/private fixture scenario, executor output, and mechanical evidence.",
    "Fail any criterion not directly supported by evidence. A pass requires every rubric criterion to pass.",
    "Never suggest executing, repairing, publishing, or sending anything.",
    "",
    JSON.stringify({
      run_id: params.runId,
      artifact: params.plan.artifact,
      fixture_mode: params.plan.fixtureMode,
      draft_skill_markdown: params.plan.draftPayload.bodyMd,
      scenario: params.plan.scenario,
      rubric: params.plan.rubricDefinition,
      private_fixtures: (params.plan.runtimeInput?.attachments ?? []).map(
        (attachment) => ({
          attachment_id: attachment.id,
          file_name: attachment.fileName,
          format: attachment.format,
          sha256: attachment.sha256,
          provenance_kind: attachment.provenance.kind,
        })
      ),
      executor_output: params.executorOutput,
      mechanical_evidence: params.mechanicalEvidence,
    }),
  ].join("\n");
  const startedAt = Date.now();
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://agents.local",
    },
    body: JSON.stringify({
      model: modelId,
      temperature: 0,
      max_tokens: 1800,
      response_format: {
        type: "json_schema",
        json_schema: JUDGE_RESPONSE_JSON_SCHEMA,
      },
      usage: { include: true },
      messages: [
        {
          role: "system",
          content:
            "You are Gu OS Studio's independent operational judge. Return only the strict JSON-schema verdict. You have no tools.",
        },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!response.ok) {
    await recordOpenRouterCallUsage({
      modelId,
      modelRole: "studio_operational_judge",
      operation: "chat_completion",
      latencyMs: Date.now() - startedAt,
      status: "error",
      errorCode: `http_${response.status}`,
    });
    throw new Error(`Operational judge returned HTTP ${response.status}`);
  }
  const json = (await response.json()) as {
    id?: string;
    choices?: Array<{ message?: { content?: unknown } }>;
    usage?: OpenRouterUsagePayload;
  };
  await recordOpenRouterCallUsage({
    modelId,
    modelRole: "studio_operational_judge",
    operation: "chat_completion",
    usage: json.usage ?? null,
    providerRequestId: typeof json.id === "string" ? json.id : null,
    latencyMs: Date.now() - startedAt,
  });
  const verdict = operationalJudgeVerdictSchema.parse(
    parseJsonContent(json.choices?.[0]?.message?.content)
  );
  const expectedIds = params.plan.rubricDefinition.criteria.map(
    (criterion) => criterion.criterion_id
  );
  const actualIds = verdict.criteria.map((criterion) => criterion.criterion_id);
  if (
    actualIds.length !== expectedIds.length ||
    new Set(actualIds).size !== actualIds.length ||
    expectedIds.some((id) => !actualIds.includes(id))
  ) {
    throw new Error(
      "Operational judge verdict did not cover the exact rubric criteria"
    );
  }
  return verdict;
}

async function persistEvidence(params: {
  db: ReturnType<typeof createServerClient>;
  userId: string;
  runId: string;
  artifactHash: string;
  passed: boolean;
  detail: Record<string, unknown>;
}) {
  await insertEvidenceRecord(params.db, {
    userId: params.userId,
    subjectKind: "studio_qualification_run",
    subjectId: params.runId,
    gate: "reusable_skill_operational_qualification",
    artifactHash: params.artifactHash,
    result: params.passed ? "pass" : "fail",
    detail: params.detail,
  });
}

export async function GET(request: Request) {
  try {
    const user = await authenticateUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const url = new URL(request.url);
    const parsed = parseStudioQualificationArtifactRequest({
      artifactKind: url.searchParams.get("artifactKind"),
      artifactId: url.searchParams.get("artifactId"),
    });
    const db = createServerClient();
    const { plan } = await loadReusableSkillQualificationPlan({
      db,
      userId: user.id,
      artifactId: parsed.artifactId,
    });
    const [latest] = await listStudioQualificationRunsForArtifact(db, {
      userId: user.id,
      artifactKind: "reusable_skill",
      artifactId: parsed.artifactId,
      limit: 1,
    });
    const repairProposal = latest
      ? await getStudioSkillRepairProposalForRun(db, {
          userId: user.id,
          sourceRunId: latest.id,
        })
      : null;
    return NextResponse.json(
      {
        ...mapStudioQualificationRunToView(latest ?? null, plan),
        repairProposal:
          repairProposal?.status === "proposed"
            ? {
                id: repairProposal.id,
                status: repairProposal.status,
                sourceSkillSlug: plan.draftPayload.slug,
                sourceSkillVersion: repairProposal.source_skill_version,
                sourceRunId: repairProposal.source_run_id,
                sourceFingerprint: repairProposal.source_fingerprint,
                repairIteration: repairProposal.repair_iteration,
                bodyMd: repairProposal.proposed_body_md,
                compilerModelId: repairProposal.compiler_model_id,
                createdAt: repairProposal.created_at,
              }
            : null,
      }
    );
  } catch (error) {
    if (error instanceof StudioQualificationRequestError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status }
      );
    }
    console.error("[GET /api/studio-operational-tests] failed:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  let runId: string | null = null;
  let userId: string | null = null;
  let plan: ReusableSkillQualificationPlan | null = null;
  let profile: Awaited<ReturnType<typeof getProfile>> | null = null;
  let db: ReturnType<typeof createServerClient> | null = null;
  let startedAt = 0;
  try {
    const user = await authenticateUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    userId = user.id;
    const parsed = parseStudioQualificationArtifactRequest(
      await request.json().catch(() => ({}))
    );
    db = createServerClient();
    const loaded = await loadReusableSkillQualificationPlan({
      db,
      userId,
      artifactId: parsed.artifactId,
    });
    plan = loaded.plan;
    profile = loaded.profile;
    await markStudioQualificationRunsStale(db, {
      userId,
      artifactKind: "reusable_skill",
      artifactId: parsed.artifactId,
      currentFingerprint: plan.fingerprint,
    });
    const pending = await createStudioQualificationRun(db, {
      userId,
      artifactKind: "reusable_skill",
      artifactId: plan.artifact.id,
      artifactVersion: plan.artifact.version,
      artifactHash: plan.artifact.contentHash,
      qualificationFingerprint: plan.fingerprint,
      resolvedModels: plan.models.resolvedModels,
      judgeModelId: plan.models.judgeModelId,
      scenarioSet: plan.scenarioSet,
      rubric: plan.rubric,
      sandboxPolicy: plan.sandboxPolicy,
      runnerVersion: plan.runnerVersion,
    });
    runId = pending.id;
    const claimed = await markStudioQualificationRunRunning(db, {
      userId,
      runId,
    });
    if (!claimed) {
      throw new StudioQualificationRequestError(
        "Qualification run could not be claimed.",
        409,
        "qualification_claim_conflict"
      );
    }
    startedAt = Date.now();
    const [toolSettings, skillSettings, session] = await Promise.all([
      getUserToolSettings(db, userId),
      getUserSkillSettings(db, userId),
      createSession(db, userId, "case_runner"),
    ]);

    const execution = await runWithAiUsageContext(
      {
        userId,
        channel: "studio_operational_test",
        sessionId: session.id,
        studioQualificationRunId: runId,
      },
      db,
      async () => {
        const output = await runAgent({
          message: plan!.scenario.input.message,
          userId: userId!,
          sessionId: session.id,
          systemPrompt: [
            profile!.agent_system_prompt,
            reusableSkillQualificationSystemBoundary(plan!.fixtureMode),
          ].join("\n\n"),
          db: db!,
          enabledTools: toolSettings,
          enabledSkills: skillSettings,
          integrations: [],
          userTimezone: profile!.timezone,
          userName: profile!.name,
          userEmail: null,
          userPhone: null,
          businessBrain: {},
          isUnggaAdmin: false,
          channel: "case_runner",
          autoApproveTools: true,
          toolApprovalPolicy: plan!.sandboxPolicyDefinition.policy,
          forcedSkillId: plan!.draftPayload.slug,
          skillUnderTest: plan!.draftPayload,
          toolCallSource: "skill_test",
          runtimeInput: plan!.runtimeInput,
        });
        const mechanical = summarizeSkillQualificationEvidence(output);
        const gate = evaluateReusableSkillMechanicalGate({
          fixtureMode: plan!.fixtureMode,
          mechanicalEvidence: {
            active_draft_applied: mechanical.appliedSkillIds.includes(
              plan!.draftPayload.slug
            ),
            no_pending_confirmation: !mechanical.pendingConfirmation,
            toolCalls: mechanical.toolCalls,
          },
          responseText: output.response,
          runtimeInput: plan!.runtimeInput,
        });
        const mechanicalEvidence = {
          ...mechanical,
          expected_skill_id: plan!.draftPayload.slug,
          fixture_mode: plan!.fixtureMode,
          active_draft_applied: mechanical.appliedSkillIds.includes(
            plan!.draftPayload.slug
          ),
          no_tool_calls: mechanical.toolCalls.total === 0,
          only_fixture_read_tools: gate.only_fixture_read_tools,
          no_external_write_tools: gate.no_external_write_tools,
          fixture_markers_present: gate.fixture_markers_present,
          no_pending_confirmation: !mechanical.pendingConfirmation,
          private_fixture_ids: (plan!.runtimeInput?.attachments ?? []).map(
            (attachment) => attachment.id
          ),
        };
        const judgment = await judgeExecution({
          runId: runId!,
          plan: plan!,
          executorOutput: output.response,
          mechanicalEvidence,
        });
        return { output, mechanicalEvidence, judgment, gate };
      }
    );

    await flushPendingAiUsageMeterWrites();
    const usage = summarizeQualificationUsage(
      await listAiUsageEventsForStudioQualificationRun(db, { userId, runId })
    );
    const mechanicallyPassed = execution.gate.passed;
    const passed =
      mechanicallyPassed &&
      execution.judgment.verdict === "pass" &&
      execution.judgment.criteria.every((criterion) => criterion.passed);
    const result = {
      schema_version: "1",
      summary: execution.judgment.summary,
      latency_ms: Date.now() - startedAt,
      accounted_cost_micro_usd: usage.accountedCostMicroUsd,
      scenario_results: [
        {
          scenario_id: plan.scenario.id,
          label: plan.scenario.label,
          passed,
          execution: {
            turn_id: execution.output.turnId,
            response: execution.output.response.slice(0, 20_000),
            mechanical_evidence: execution.mechanicalEvidence,
          },
          judgment: execution.judgment,
        },
      ],
    };
    const finished = await finishStudioQualificationRun(db, {
      userId,
      runId,
      status: passed ? "passed" : "failed",
      result,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      reportedCostMicroUsd: usage.reportedCostMicroUsd,
      estimatedCostMicroUsd: usage.estimatedCostMicroUsd,
      pricingVersion: usage.pricingVersion,
    });
    if (!finished) throw new Error("Qualification run lost its completion CAS");
    await persistEvidence({
      db,
      userId,
      runId,
      artifactHash: plan.artifact.contentHash,
      passed,
      detail: {
        fingerprint: plan.fingerprint,
        scenario_id: plan.scenario.id,
        judge_model_id: plan.models.judgeModelId,
        executor_model_ids: Object.values(plan.models.executorModels),
        mechanical_evidence: execution.mechanicalEvidence,
        judgment: execution.judgment,
      },
    });
    return NextResponse.json(mapStudioQualificationRunToView(finished, plan));
  } catch (error) {
    if (
      error instanceof StudioQualificationRequestError &&
      (!runId || error.status !== 409)
    ) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status }
      );
    }
    const message = errorMessage(error);
    console.error("[POST /api/studio-operational-tests] failed:", error);
    if (db && userId && runId && plan) {
      try {
        await flushPendingAiUsageMeterWrites();
        const usage = summarizeQualificationUsage(
          await listAiUsageEventsForStudioQualificationRun(db, {
            userId,
            runId,
          })
        );
        const result = {
          schema_version: "1",
          summary: `Qualification failed closed: ${message}`,
          latency_ms: startedAt ? Date.now() - startedAt : 0,
          accounted_cost_micro_usd: usage.accountedCostMicroUsd,
          scenario_results: [
            {
              scenario_id: plan.scenario.id,
              label: plan.scenario.label,
              passed: false,
              detail: message,
            },
          ],
        };
        const finished = await finishStudioQualificationRun(db, {
          userId,
          runId,
          status: "failed",
          result,
          error: {
            code: "qualification_execution_failed",
            message,
          },
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
          reportedCostMicroUsd: usage.reportedCostMicroUsd,
          estimatedCostMicroUsd: usage.estimatedCostMicroUsd,
          pricingVersion: usage.pricingVersion,
        });
        if (finished) {
          await persistEvidence({
            db,
            userId,
            runId,
            artifactHash: plan.artifact.contentHash,
            passed: false,
            detail: {
              fingerprint: plan.fingerprint,
              error: { code: "qualification_execution_failed", message },
            },
          });
        }
      } catch (persistError) {
        console.error(
          "[POST /api/studio-operational-tests] failed to persist terminal failure:",
          persistError
        );
      }
    }
    return NextResponse.json(
      {
        error: `Qualification failed closed: ${message}`,
        code: "qualification_execution_failed",
      },
      { status: error instanceof StudioQualificationRequestError ? error.status : 500 }
    );
  }
}
