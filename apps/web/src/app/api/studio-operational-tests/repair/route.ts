import { NextResponse } from "next/server";
import {
  flushPendingAiUsageMeterWrites,
  runWithAiUsageContext,
} from "@agents/agent";
import {
  claimStudioSkillRepairProposal,
  createServerClient,
  failStudioSkillRepairProposal,
  finishStudioSkillRepairProposal,
  getAccountSkillById,
  getStudioQualificationRun,
  listStudioQualificationRunsForArtifact,
} from "@agents/db";
import { createClient } from "@/lib/supabase/server";
import {
  compileReusableSkillRepair,
  resolveReusableSkillRepairModelId,
} from "@/lib/workflow-studio/compile-reusable-skill-repair";
import {
  assertReusableSkillRepairEligibility,
  buildReusableSkillRepairMetadata,
  parseReusableSkillRepairRequest,
  reusableSkillRepairIdempotencyKey,
} from "@/lib/workflow-studio/reusable-skill-repair";
import { StudioQualificationRequestError } from "@/lib/workflow-studio/reusable-skill-qualification";
import { loadReusableSkillQualificationPlan } from "@/lib/workflow-studio/reusable-skill-qualification-server";

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

function proposalResponse(
  proposal: Awaited<ReturnType<typeof claimStudioSkillRepairProposal>>["proposal"],
  skillSlug: string,
  idempotent: boolean
) {
  return {
    proposal: {
      id: proposal.id,
      status: proposal.status,
      sourceSkillId: proposal.source_skill_id,
      sourceSkillSlug: skillSlug,
      sourceRunId: proposal.source_run_id,
      sourceFingerprint: proposal.source_fingerprint,
      sourceSkillVersion: proposal.source_skill_version,
      repairIteration: proposal.repair_iteration,
      bodyMd: proposal.proposed_body_md,
      metadata: proposal.proposed_metadata_jsonb,
      compilerModelId: proposal.compiler_model_id,
      createdAt: proposal.created_at,
    },
    idempotent,
    requiresReview: true,
    requiresSeparateRetest: true,
    published: false,
    activated: false,
  };
}

export async function POST(request: Request) {
  let claimedProposalId: string | null = null;
  let userId: string | null = null;
  let compilerModelId: string | null = null;
  const db = createServerClient();
  try {
    const user = await authenticateUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    userId = user.id;
    const parsed = parseReusableSkillRepairRequest(
      await request.json().catch(() => ({}))
    );
    const [run, skill, loaded, runs] = await Promise.all([
      getStudioQualificationRun(db, {
        userId,
        runId: parsed.sourceRunId,
      }),
      getAccountSkillById(db, userId, parsed.artifactId),
      loadReusableSkillQualificationPlan({
        db,
        userId,
        artifactId: parsed.artifactId,
      }),
      listStudioQualificationRunsForArtifact(db, {
        userId,
        artifactKind: "reusable_skill",
        artifactId: parsed.artifactId,
        limit: 1,
      }),
    ]);
    if (!run || !skill) {
      throw new StudioQualificationRequestError(
        "Reusable skill or qualification run was not found.",
        404,
        "repair_source_not_found"
      );
    }
    const repairIteration = assertReusableSkillRepairEligibility({
      run,
      latestRun: runs[0] ?? null,
      currentSkill: skill,
      currentFingerprint: loaded.plan.fingerprint,
    });
    const claim = await claimStudioSkillRepairProposal(db, {
      userId,
      sourceSkillId: skill.id,
      sourceRunId: run.id,
      sourceFingerprint: run.qualification_fingerprint,
      sourceSkillVersion: skill.version,
      repairIteration,
      idempotencyKey: reusableSkillRepairIdempotencyKey({
        sourceRunId: run.id,
        sourceFingerprint: run.qualification_fingerprint,
        repairIteration,
      }),
    });
    if (!claim.claimed) {
      if (claim.proposal.status === "proposed") {
        return NextResponse.json(proposalResponse(claim.proposal, skill.slug, true));
      }
      throw new StudioQualificationRequestError(
        claim.proposal.status === "generating"
          ? "A repair proposal is already being generated for this run."
          : "The repair attempt for this run failed closed and cannot be repeated.",
        409,
        claim.proposal.status === "generating"
          ? "repair_already_generating"
          : "repair_attempt_failed"
      );
    }
    claimedProposalId = claim.proposal.id;
    compilerModelId = resolveReusableSkillRepairModelId();
    const compiled = await runWithAiUsageContext(
      {
        userId,
        channel: "studio_operational_test",
        studioQualificationRunId: run.id,
      },
      db,
      () =>
        compileReusableSkillRepair({
          sourceSkill: skill,
          sourceRun: run,
          repairIteration,
        })
    );
    await flushPendingAiUsageMeterWrites();
    compilerModelId = compiled.modelId;

    // Completion CAS: a new run or draft edit during generation invalidates
    // the proposal instead of letting stale model output become reviewable.
    const [currentSkill, currentLoaded, currentRuns] = await Promise.all([
      getAccountSkillById(db, userId, skill.id),
      loadReusableSkillQualificationPlan({
        db,
        userId,
        artifactId: skill.id,
      }),
      listStudioQualificationRunsForArtifact(db, {
        userId,
        artifactKind: "reusable_skill",
        artifactId: skill.id,
        limit: 1,
      }),
    ]);
    if (!currentSkill) {
      throw new StudioQualificationRequestError(
        "The source draft was removed while repair was generating.",
        409,
        "repair_source_stale"
      );
    }
    const currentIteration = assertReusableSkillRepairEligibility({
      run,
      latestRun: currentRuns[0] ?? null,
      currentSkill,
      currentFingerprint: currentLoaded.plan.fingerprint,
    });
    if (currentIteration !== repairIteration) {
      throw new StudioQualificationRequestError(
        "The repair iteration changed while generation was in progress.",
        409,
        "repair_source_stale"
      );
    }
    const metadata = buildReusableSkillRepairMetadata({
      sourceSkill: currentSkill,
      sourceRun: run,
      proposedBodyMd: compiled.bodyMd,
      compilerModelId: compiled.modelId,
      repairIteration,
    });
    const finished = await finishStudioSkillRepairProposal(db, {
      userId,
      proposalId: claim.proposal.id,
      bodyMd: compiled.bodyMd,
      metadata,
      compilerModelId: compiled.modelId,
    });
    if (!finished) {
      throw new StudioQualificationRequestError(
        "The repair proposal lost its completion claim.",
        409,
        "repair_completion_conflict"
      );
    }
    claimedProposalId = null;
    return NextResponse.json(proposalResponse(finished, skill.slug, false));
  } catch (error) {
    const message = errorMessage(error);
    if (claimedProposalId && userId) {
      try {
        await flushPendingAiUsageMeterWrites();
        await failStudioSkillRepairProposal(db, {
          userId,
          proposalId: claimedProposalId,
          compilerModelId,
          failure: {
            code:
              error instanceof StudioQualificationRequestError
                ? error.code
                : "repair_generation_failed",
            message,
          },
        });
      } catch (persistError) {
        console.error(
          "[POST /api/studio-operational-tests/repair] failed to persist terminal failure:",
          persistError
        );
      }
    }
    if (error instanceof StudioQualificationRequestError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status }
      );
    }
    console.error("[POST /api/studio-operational-tests/repair] failed:", error);
    return NextResponse.json(
      {
        error: `Repair failed closed: ${message}`,
        code: "repair_generation_failed",
      },
      { status: 500 }
    );
  }
}
