import { NextResponse } from "next/server";
import {
  flushPendingAiUsageMeterWrites,
  runAgent,
  runWithAiUsageContext,
  summarizeSkillQualificationEvidence,
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
import { type OperationalJudgeVerdict } from "@agents/workflows";
import { createClient } from "@/lib/supabase/server";
import {
  buildStudioQualificationInconclusiveResult,
  evaluateReusableSkillMechanicalGate,
  mapStudioQualificationRunToView,
  parseStudioQualificationArtifactRequest,
  StudioQualificationRequestError,
  summarizeQualificationUsage,
  type ReusableSkillQualificationPlan,
} from "@/lib/workflow-studio/reusable-skill-qualification";
import {
  OperationalJudgeInfrastructureError,
  requestOperationalJudgeVerdict,
} from "@/lib/workflow-studio/operational-judge-openrouter";
import {
  loadReusableSkillQualificationPlan,
  reusableSkillQualificationSystemBoundary,
} from "@/lib/workflow-studio/reusable-skill-qualification-server";

export const maxDuration = 180;

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
  if (!apiKey) {
    throw new OperationalJudgeInfrastructureError(
      "judge_not_configured",
      "Operational judge is not configured",
      { attempts: 0 }
    );
  }
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
  const expectedIds = params.plan.rubricDefinition.criteria.map(
    (criterion) => criterion.criterion_id
  );
  return requestOperationalJudgeVerdict({
    apiKey,
    modelId,
    prompt,
    expectedCriterionIds: expectedIds,
  });
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
    const view = mapStudioQualificationRunToView(latest ?? null, plan);
    return NextResponse.json(
      {
        ...view,
        repairProposal:
          view.repairEligible && repairProposal?.status === "proposed"
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
        try {
          const judgment = await judgeExecution({
            runId: runId!,
            plan: plan!,
            executorOutput: output.response,
            mechanicalEvidence,
          });
          return { output, mechanicalEvidence, judgment, gate };
        } catch (error) {
          if (!(error instanceof OperationalJudgeInfrastructureError)) throw error;
          return {
            output,
            mechanicalEvidence,
            gate,
            judgeInfrastructure: {
              code: error.code,
              message: error.message,
              ...error.details,
            },
          };
        }
      }
    );

    await flushPendingAiUsageMeterWrites();
    const usage = summarizeQualificationUsage(
      await listAiUsageEventsForStudioQualificationRun(db, { userId, runId })
    );
    if (
      "judgeInfrastructure" in execution &&
      execution.judgeInfrastructure
    ) {
      const result = buildStudioQualificationInconclusiveResult({
        summary:
          "La ejecución terminó, pero el juez no pudo producir una calificación válida. Reintenta la calificación.",
        latencyMs: Date.now() - startedAt,
        accountedCostMicroUsd: usage.accountedCostMicroUsd,
        scenario: plan.scenario,
        infrastructure: execution.judgeInfrastructure,
        execution: {
          turnId: execution.output.turnId,
          response: execution.output.response,
          mechanicalEvidence: execution.mechanicalEvidence,
        },
      });
      const finished = await finishStudioQualificationRun(db, {
        userId,
        runId,
        status: "non_convergent",
        result,
        error: {
          code: "qualification_judge_inconclusive",
          infrastructure: execution.judgeInfrastructure,
        },
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
        passed: false,
        detail: {
          result_kind: "inconclusive_infrastructure",
          fingerprint: plan.fingerprint,
          scenario_id: plan.scenario.id,
          judge_model_id: plan.models.judgeModelId,
          executor_model_ids: Object.values(plan.models.executorModels),
          execution: {
            turn_id: execution.output.turnId,
            response: execution.output.response.slice(0, 20_000),
          },
          mechanical_evidence: execution.mechanicalEvidence,
          judge_infrastructure: execution.judgeInfrastructure,
        },
      });
      return NextResponse.json(mapStudioQualificationRunToView(finished, plan));
    }

    const mechanicallyPassed = execution.gate.passed;
    const passed =
      mechanicallyPassed &&
      execution.judgment.verdict === "pass" &&
      execution.judgment.criteria.every((criterion) => criterion.passed);
    const result = {
      schema_version: "1",
      result_kind: passed ? "passed" : "failed_by_verdict",
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
        result_kind: passed ? "passed" : "failed_by_verdict",
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
        const result = buildStudioQualificationInconclusiveResult({
          summary:
            "La calificación no pudo completarse por una falla de infraestructura.",
          latencyMs: startedAt ? Date.now() - startedAt : 0,
          accountedCostMicroUsd: usage.accountedCostMicroUsd,
          scenario: plan.scenario,
          infrastructure: {
            code: "qualification_execution_failed",
            message,
          },
        });
        const finished = await finishStudioQualificationRun(db, {
          userId,
          runId,
          status: "non_convergent",
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
              result_kind: "inconclusive_infrastructure",
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
        error: `Qualification inconclusive: ${message}`,
        code: "qualification_inconclusive_infrastructure",
      },
      { status: error instanceof StudioQualificationRequestError ? error.status : 500 }
    );
  }
}
