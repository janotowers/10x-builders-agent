import {
  COMPACTION_MODEL_ID,
  DEFAULT_WORKFLOW_OPERATIONAL_JUDGE_MODEL_ID,
  getSkillRegistryForUser,
  MAIN_AGENT_MODEL_ID,
  overlaySkillRegistryForTurn,
  resolveSkill,
  WORKFLOW_OPERATIONAL_JUDGE_MODEL_ID,
} from "@agents/agent";
import {
  getAccountSkillById,
  getProfile,
  type DbClient,
} from "@agents/db";
import {
  buildReusableSkillQualificationPlan,
  hashQualificationDescriptor,
  resolveReusableSkillQualificationModels,
  skillNeedsDocumentaryQualificationFixture,
  StudioQualificationRequestError,
  type ReusableSkillQualificationFixtureMode,
  type ReusableSkillQualificationPlan,
} from "./reusable-skill-qualification";

export const REUSABLE_SKILL_QUALIFICATION_SYSTEM_BOUNDARY =
  "This turn is a Studio qualification against fictional data. Never perform or claim real-world actions. Use no tools and make no external writes.";

export const REUSABLE_SKILL_DOCUMENTARY_QUALIFICATION_SYSTEM_BOUNDARY =
  "This turn is a Studio qualification against private documentary fixtures injected as runtime_input. You may use only list_runtime_attachments, read_runtime_attachment, and search_runtime_attachments. Never send Gmail/Telegram, publish, schedule, mutate records, or claim real-world actions.";

export function reusableSkillQualificationSystemBoundary(
  fixtureMode: ReusableSkillQualificationFixtureMode
): string {
  return fixtureMode === "private_documentary"
    ? REUSABLE_SKILL_DOCUMENTARY_QUALIFICATION_SYSTEM_BOUNDARY
    : REUSABLE_SKILL_QUALIFICATION_SYSTEM_BOUNDARY;
}

export async function loadReusableSkillQualificationPlan(params: {
  db: DbClient;
  userId: string;
  artifactId: string;
}): Promise<{
  plan: ReusableSkillQualificationPlan;
  profile: Awaited<ReturnType<typeof getProfile>>;
}> {
  const [skill, profile] = await Promise.all([
    getAccountSkillById(params.db, params.userId, params.artifactId),
    getProfile(params.db, params.userId),
  ]);
  if (!skill) {
    throw new StudioQualificationRequestError(
      "Reusable skill draft was not found.",
      404,
      "artifact_not_found"
    );
  }
  const draftPayload = {
    slug: skill.slug,
    userId: params.userId,
    bodyMd: skill.body_md,
  };
  const baseRegistry = await getSkillRegistryForUser(params.db, params.userId);
  const registry = overlaySkillRegistryForTurn(
    baseRegistry,
    draftPayload,
    params.userId
  );
  const resolved = await resolveSkill(skill.slug, registry);
  const fixtureMode: ReusableSkillQualificationFixtureMode =
    skillNeedsDocumentaryQualificationFixture(skill, resolved.allowedTools)
      ? "private_documentary"
      : "none";
  const systemBoundary = reusableSkillQualificationSystemBoundary(fixtureMode);
  const models = resolveReusableSkillQualificationModels({
    mainAgentModelId: MAIN_AGENT_MODEL_ID,
    compactionModelId: COMPACTION_MODEL_ID,
    configuredJudgeModelId: WORKFLOW_OPERATIONAL_JUDGE_MODEL_ID,
    defaultJudgeModelId: DEFAULT_WORKFLOW_OPERATIONAL_JUDGE_MODEL_ID,
  });
  const dependencyHash = hashQualificationDescriptor({
    composed_from: resolved.composedFrom,
    merged_body: resolved.body,
    allowed_tools: resolved.allowedTools,
    requires_tenant_context: resolved.requiresTenantContext,
    memory_extraction: resolved.memoryExtraction,
    authoring_discovery_hash:
      typeof skill.metadata_jsonb.discovery_hash === "string"
        ? skill.metadata_jsonb.discovery_hash
        : null,
    reusable_skill_compilation_contract:
      skill.metadata_jsonb.reusable_skill_compilation_contract ?? null,
    fixture_mode: fixtureMode,
    executor_context: {
      system_prompt: [profile.agent_system_prompt, systemBoundary].join("\n\n"),
      timezone: profile.timezone,
      user_name: profile.name,
      business_brain: {},
      integrations: [],
    },
  });
  return {
    plan: buildReusableSkillQualificationPlan({
      skill,
      authenticatedUserId: params.userId,
      models,
      dependencyHash,
      resolvedAllowedTools: resolved.allowedTools,
    }),
    profile,
  };
}
