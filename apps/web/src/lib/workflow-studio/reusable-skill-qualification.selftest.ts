import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type {
  AccountSkill,
  AiUsageEvent,
  StudioQualificationRun,
} from "@agents/types";
import {
  buildReusableSkillDocumentaryRuntimeInput,
  buildReusableSkillQualificationPlan,
  buildReusableSkillSandboxPolicyDefinition,
  buildReusableSkillScenario,
  deriveQualificationStaleReasons,
  evaluateReusableSkillMechanicalGate,
  hashQualificationDescriptor,
  mapStudioQualificationRunToView,
  parseStudioQualificationArtifactRequest,
  REUSABLE_SKILL_ATTACHMENT_PIPELINE,
  REUSABLE_SKILL_DOCUMENTARY_SANDBOX_POLICY_ID,
  resolveReusableSkillQualificationModels,
  reusableSkillDraftPayloadHash,
  skillNeedsDocumentaryQualificationFixture,
  StudioQualificationRequestError,
  summarizeQualificationUsage,
} from "./reusable-skill-qualification";
import {
  assertReusableSkillRepairEligibility,
  buildReusableSkillRepairMetadata,
  MAX_REUSABLE_SKILL_REPAIR_ITERATIONS,
  parseReusableSkillRepairRequest,
  reusableSkillRepairIdempotencyKey,
} from "./reusable-skill-repair";

const skill: AccountSkill = {
  id: "11111111-1111-4111-8111-111111111111",
  user_id: "22222222-2222-4222-8222-222222222222",
  slug: "draft-procedure",
  body_md: [
    "---",
    "name: draft-procedure",
    "description: Prepare a fictional client brief",
    "allowed_tools: []",
    "---",
    "# Gather facts",
    "Build the brief from supplied facts.",
    "## Draft result",
    "Clearly label unknowns.",
  ].join("\n"),
  metadata_jsonb: {
    display_title: "Draft procedure",
    description: "Prepare a fictional client brief",
    allowed_tools: [],
  },
  status: "draft",
  version: 3,
  created_at: "2026-08-09T10:00:00.000Z",
  updated_at: "2026-08-09T11:00:00.000Z",
};

assert.deepEqual(
  parseStudioQualificationArtifactRequest({
    artifactKind: "reusable_skill",
    artifactId: skill.id,
  }),
  { artifactKind: "reusable_skill", artifactId: skill.id }
);
assert.throws(
  () =>
    parseStudioQualificationArtifactRequest({
      artifactKind: "case_workflow",
      artifactId: skill.id,
    }),
  (error) =>
    error instanceof StudioQualificationRequestError &&
    error.status === 422 &&
    error.code === "unsupported_artifact_kind"
);

const draftPayload = {
  slug: skill.slug,
  userId: skill.user_id,
  bodyMd: skill.body_md,
};
assert.equal(
  reusableSkillDraftPayloadHash(draftPayload),
  reusableSkillDraftPayloadHash({ ...draftPayload })
);
assert.notEqual(
  reusableSkillDraftPayloadHash(draftPayload),
  reusableSkillDraftPayloadHash({
    ...draftPayload,
    bodyMd: `${draftPayload.bodyMd}\nChanged`,
  })
);

const scenario = buildReusableSkillScenario(skill);
assert.deepEqual(scenario, buildReusableSkillScenario(skill));
assert.match(scenario.input.message, /fictional/i);
assert.match(scenario.input.message, /Do not call tools/i);
assert.deepEqual(
  scenario.input.message.includes("Gather facts"),
  true,
  "scenario is deterministically derived from body headings"
);

const models = resolveReusableSkillQualificationModels({
  mainAgentModelId: "openai/executor",
  compactionModelId: "anthropic/compact",
  configuredJudgeModelId: "openai/executor",
  defaultJudgeModelId: "anthropic/judge",
});
assert.equal(models.judgeModelId, "anthropic/judge");
assert.throws(
  () =>
    resolveReusableSkillQualificationModels({
      mainAgentModelId: "same/model",
      compactionModelId: "same/model",
      configuredJudgeModelId: "same/model",
      defaultJudgeModelId: "same/model",
    }),
  (error) =>
    error instanceof StudioQualificationRequestError &&
    error.code === "independent_judge_unavailable"
);

const sandbox = buildReusableSkillSandboxPolicyDefinition();
assert.ok(Object.keys(sandbox.policy).length > 0);
assert.equal(
  Object.values(sandbox.policy).every((mode) => mode === "deny"),
  true
);
assert.match(sandbox.baseline.hash, /^sha256:[a-f0-9]{64}$/);
assert.equal(sandbox.policy.gmail_send_email, "deny");
assert.equal(sandbox.policy.telegram_send_message_to_contact, "deny");

assert.equal(skillNeedsDocumentaryQualificationFixture(skill), false);
assert.equal(
  skillNeedsDocumentaryQualificationFixture({
    ...skill,
    metadata_jsonb: {
      ...skill.metadata_jsonb,
      allowed_tools: ["read_runtime_attachment"],
    },
  }),
  true
);
assert.equal(
  skillNeedsDocumentaryQualificationFixture(skill, [
    "list_runtime_attachments",
  ]),
  true
);

const documentaryRuntimeInput = buildReusableSkillDocumentaryRuntimeInput();
assert.equal(documentaryRuntimeInput.attachments.length, 2);
assert.deepEqual(
  buildReusableSkillDocumentaryRuntimeInput(),
  documentaryRuntimeInput,
  "private fixtures must be deterministic"
);
for (const attachment of documentaryRuntimeInput.attachments) {
  assert.equal(attachment.channel, "system");
  assert.equal(attachment.provenance.kind, "studio_qualification_fixture");
  assert.equal(attachment.provenance.source, "generated");
  assert.match(attachment.sha256, /^[a-f0-9]{64}$/);
  assert.ok(attachment.extractedText?.includes("FIXTURE_MARKER_"));
}
assert.ok(
  documentaryRuntimeInput.attachments.some(
    (attachment) => attachment.format === "text"
  )
);
assert.ok(
  documentaryRuntimeInput.attachments.some(
    (attachment) => attachment.format === "docx"
  )
);

const documentarySandbox =
  buildReusableSkillSandboxPolicyDefinition("private_documentary");
assert.equal(
  documentarySandbox.id,
  REUSABLE_SKILL_DOCUMENTARY_SANDBOX_POLICY_ID
);
assert.equal(documentarySandbox.policy.list_runtime_attachments, "auto_execute");
assert.equal(documentarySandbox.policy.read_runtime_attachment, "auto_execute");
assert.equal(
  documentarySandbox.policy.search_runtime_attachments,
  "auto_execute"
);
assert.equal(documentarySandbox.policy.gmail_send_email, "deny");
assert.equal(
  documentarySandbox.policy.telegram_send_message_to_contact,
  "deny"
);
assert.equal(documentarySandbox.policy.easybroker_publish_listing, "deny");
assert.equal(documentarySandbox.policy.notify_user, "deny");
assert.equal(documentarySandbox.policy.get_user_preferences, "deny");
assert.equal(
  Object.entries(documentarySandbox.policy).filter(
    ([, mode]) => mode !== "deny"
  ).length,
  3,
  "only fixture read tools may auto-execute"
);

const documentarySkill: AccountSkill = {
  ...skill,
  slug: "documentary-procedure",
  body_md: [
    "---",
    "name: documentary-procedure",
    "description: Summarize an attached brief",
    "allowed_tools:",
    "  - list_runtime_attachments",
    "  - read_runtime_attachment",
    "---",
    "# Read attachment",
    "Use the private fixture document.",
  ].join("\n"),
  metadata_jsonb: {
    display_title: "Documentary procedure",
    description: "Summarize an attached brief",
    allowed_tools: [
      "list_runtime_attachments",
      "read_runtime_attachment",
    ],
  },
};

const dependencyHash = hashQualificationDescriptor({
  composed_from: [skill.slug],
  body: skill.body_md,
});
const plan = buildReusableSkillQualificationPlan({
  skill,
  authenticatedUserId: skill.user_id,
  models,
  dependencyHash,
});
assert.equal(plan.fixtureMode, "none");
assert.equal(plan.runtimeInput, undefined);
const samePlan = buildReusableSkillQualificationPlan({
  skill: { ...skill, metadata_jsonb: { ...skill.metadata_jsonb } },
  authenticatedUserId: skill.user_id,
  models,
  dependencyHash,
});
assert.equal(plan.fingerprint, samePlan.fingerprint);
assert.match(plan.fingerprint, /^sha256:[a-f0-9]{64}$/);
assert.notEqual(
  plan.fingerprint,
  buildReusableSkillQualificationPlan({
    skill,
    authenticatedUserId: skill.user_id,
    models,
    dependencyHash: hashQualificationDescriptor({ changed: true }),
  }).fingerprint
);

const documentaryPlan = buildReusableSkillQualificationPlan({
  skill: documentarySkill,
  authenticatedUserId: documentarySkill.user_id,
  models,
  dependencyHash: hashQualificationDescriptor({
    composed_from: [documentarySkill.slug],
    body: documentarySkill.body_md,
  }),
});
assert.equal(documentaryPlan.fixtureMode, "private_documentary");
assert.equal(documentaryPlan.runtimeInput?.attachments.length, 2);
assert.match(
  documentaryPlan.scenario.input.message,
  /list_runtime_attachments/
);
assert.match(documentaryPlan.scenario.input.message, /private Studio fixtures/i);
assert.equal(
  documentaryPlan.sandboxPolicy.id,
  REUSABLE_SKILL_DOCUMENTARY_SANDBOX_POLICY_ID
);
assert.notEqual(documentaryPlan.fingerprint, plan.fingerprint);
const documentaryPlanSame = buildReusableSkillQualificationPlan({
  skill: {
    ...documentarySkill,
    metadata_jsonb: { ...documentarySkill.metadata_jsonb },
  },
  authenticatedUserId: documentarySkill.user_id,
  models,
  dependencyHash: hashQualificationDescriptor({
    composed_from: [documentarySkill.slug],
    body: documentarySkill.body_md,
  }),
});
assert.equal(documentaryPlan.fingerprint, documentaryPlanSame.fingerprint);
assert.ok(REUSABLE_SKILL_ATTACHMENT_PIPELINE.contract_version);
assert.ok(
  documentaryPlan.scenarioSet.hash !== plan.scenarioSet.hash,
  "documentary fixtures must change the scenario-set hash"
);
assert.ok(
  documentaryPlan.sandboxPolicy.hash !== plan.sandboxPolicy.hash,
  "documentary sandbox must change the sandbox hash"
);

const fixtureGatePass = evaluateReusableSkillMechanicalGate({
  fixtureMode: "private_documentary",
  mechanicalEvidence: {
    active_draft_applied: true,
    no_pending_confirmation: true,
    toolCalls: {
      total: 2,
      unique: ["list_runtime_attachments", "read_runtime_attachment"],
      sequence: ["list_runtime_attachments", "read_runtime_attachment"],
    },
  },
  responseText:
    "Summary of qualification-brief.txt with FIXTURE_MARKER_TXT_ALPHA_42",
  runtimeInput: documentaryPlan.runtimeInput,
});
assert.equal(fixtureGatePass.passed, true);
assert.equal(fixtureGatePass.only_fixture_read_tools, true);
assert.equal(fixtureGatePass.no_external_write_tools, true);
assert.equal(fixtureGatePass.fixture_markers_present, true);

const fixtureGateDenyExternal = evaluateReusableSkillMechanicalGate({
  fixtureMode: "private_documentary",
  mechanicalEvidence: {
    active_draft_applied: true,
    no_pending_confirmation: true,
    toolCalls: {
      total: 1,
      unique: ["gmail_send_email"],
      sequence: ["gmail_send_email"],
    },
  },
  responseText: "Sent the summary by email.",
  runtimeInput: documentaryPlan.runtimeInput,
});
assert.equal(fixtureGateDenyExternal.passed, false);
assert.equal(fixtureGateDenyExternal.only_fixture_read_tools, false);
assert.equal(fixtureGateDenyExternal.no_external_write_tools, false);

function qualificationRun(
  patch: Partial<StudioQualificationRun> = {}
): StudioQualificationRun {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    user_id: skill.user_id,
    artifact_kind: "reusable_skill",
    artifact_id: skill.id,
    artifact_version: plan.artifact.version,
    artifact_hash: plan.artifact.contentHash,
    status: "passed",
    qualification_fingerprint: plan.fingerprint,
    resolved_models_jsonb: plan.models.resolvedModels,
    judge_model_id: plan.models.judgeModelId,
    scenario_set_id: plan.scenarioSet.id,
    scenario_set_version: plan.scenarioSet.version,
    scenario_set_hash: plan.scenarioSet.hash,
    rubric_id: plan.rubric.id,
    rubric_version: plan.rubric.version,
    rubric_hash: plan.rubric.hash,
    sandbox_policy_id: plan.sandboxPolicy.id,
    sandbox_policy_version: plan.sandboxPolicy.version,
    sandbox_policy_hash: plan.sandboxPolicy.hash,
    runner_version: plan.runnerVersion,
    result_jsonb: {
      summary: "Qualified.",
      latency_ms: 1234,
      accounted_cost_micro_usd: 42,
      scenario_results: [
        {
          scenario_id: plan.scenario.id,
          label: plan.scenario.label,
          passed: true,
          judgment: { summary: "All required evidence is present." },
        },
      ],
    },
    error_jsonb: null,
    repair_iteration: 0,
    input_tokens: 10,
    output_tokens: 5,
    total_tokens: 15,
    reported_cost_micro_usd: 42,
    estimated_cost_micro_usd: 40,
    currency: "USD",
    pricing_version: "prices-v1",
    started_at: "2026-08-09T12:00:00.000Z",
    finished_at: "2026-08-09T12:00:01.234Z",
    created_at: "2026-08-09T12:00:00.000Z",
    updated_at: "2026-08-09T12:00:01.234Z",
    ...patch,
  };
}

assert.deepEqual(deriveQualificationStaleReasons(qualificationRun(), plan), []);
assert.deepEqual(
  deriveQualificationStaleReasons(
    qualificationRun({ artifact_hash: "sha256:old" }),
    plan
  ),
  ["artifact_changed"]
);
assert.deepEqual(
  deriveQualificationStaleReasons(
    qualificationRun({ resolved_models_jsonb: { main_agent: "old/model" } }),
    plan
  ),
  ["models_changed"]
);
assert.deepEqual(
  deriveQualificationStaleReasons(
    qualificationRun({ scenario_set_hash: "sha256:old" }),
    plan
  ),
  ["scenario_changed"]
);
assert.deepEqual(
  deriveQualificationStaleReasons(
    qualificationRun({ rubric_hash: "sha256:old" }),
    plan
  ),
  ["rubric_changed"]
);
assert.deepEqual(
  deriveQualificationStaleReasons(
    qualificationRun({ sandbox_policy_hash: "sha256:old" }),
    plan
  ),
  ["sandbox_changed"]
);

const documentaryRun: StudioQualificationRun = {
  ...qualificationRun(),
  artifact_id: documentarySkill.id,
  artifact_version: documentaryPlan.artifact.version,
  artifact_hash: documentaryPlan.artifact.contentHash,
  qualification_fingerprint: documentaryPlan.fingerprint,
  scenario_set_id: documentaryPlan.scenarioSet.id,
  scenario_set_version: documentaryPlan.scenarioSet.version,
  scenario_set_hash: documentaryPlan.scenarioSet.hash,
  rubric_id: documentaryPlan.rubric.id,
  rubric_version: documentaryPlan.rubric.version,
  rubric_hash: documentaryPlan.rubric.hash,
  sandbox_policy_id: documentaryPlan.sandboxPolicy.id,
  sandbox_policy_version: documentaryPlan.sandboxPolicy.version,
  sandbox_policy_hash: documentaryPlan.sandboxPolicy.hash,
};
assert.deepEqual(
  deriveQualificationStaleReasons(documentaryRun, documentaryPlan),
  []
);
assert.deepEqual(
  deriveQualificationStaleReasons(documentaryRun, plan).sort(),
  [
    "artifact_changed",
    "rubric_changed",
    "sandbox_changed",
    "scenario_changed",
  ].sort()
);
assert.equal(
  mapStudioQualificationRunToView(documentaryRun, plan).status,
  "stale",
  "switching away from documentary fixtures invalidates a prior pass"
);
assert.deepEqual(
  deriveQualificationStaleReasons(
    {
      ...documentaryRun,
      qualification_fingerprint: "sha256:stale-pipeline",
      // Keep descriptor ids matching so only the composite fingerprint drifts
      // (attachment pipeline / dependency hash changes).
    },
    {
      ...documentaryPlan,
      fingerprint: documentaryPlan.fingerprint,
    }
  ),
  ["runtime_dependencies_changed"]
);

const view = mapStudioQualificationRunToView(qualificationRun(), plan);
assert.equal(view.status, "passed");
assert.equal(view.costMicroUsd, 42);
assert.equal(view.latencyMs, 1234);
assert.equal(view.scenarios[0]?.passed, true);
assert.equal(view.runId, qualificationRun().id);
assert.equal(view.repairIteration, 0);
const staleView = mapStudioQualificationRunToView(
  qualificationRun({
    artifact_hash: "sha256:old",
    qualification_fingerprint: "sha256:old",
  }),
  plan
);
assert.equal(staleView.status, "stale");
assert.deepEqual(staleView.staleReasons, ["artifact_changed"]);

const failedRun = qualificationRun({ status: "failed", repair_iteration: 0 });
assert.deepEqual(
  parseReusableSkillRepairRequest({
    artifactKind: "reusable_skill",
    artifactId: skill.id,
    sourceRunId: failedRun.id,
  }),
  {
    artifactKind: "reusable_skill",
    artifactId: skill.id,
    sourceRunId: failedRun.id,
  }
);
assert.equal(
  assertReusableSkillRepairEligibility({
    run: failedRun,
    latestRun: failedRun,
    currentSkill: skill,
    currentFingerprint: plan.fingerprint,
  }),
  1
);
assert.throws(
  () =>
    assertReusableSkillRepairEligibility({
      run: failedRun,
      latestRun: qualificationRun({ id: randomUUID(), status: "failed" }),
      currentSkill: skill,
      currentFingerprint: plan.fingerprint,
    }),
  (error) =>
    error instanceof StudioQualificationRequestError &&
    error.code === "repair_source_not_latest"
);
assert.throws(
  () =>
    assertReusableSkillRepairEligibility({
      run: qualificationRun({
        status: "failed",
        repair_iteration: MAX_REUSABLE_SKILL_REPAIR_ITERATIONS,
      }),
      latestRun: qualificationRun({
        status: "failed",
        repair_iteration: MAX_REUSABLE_SKILL_REPAIR_ITERATIONS,
      }),
      currentSkill: skill,
      currentFingerprint: plan.fingerprint,
    }),
  (error) =>
    error instanceof StudioQualificationRequestError &&
    error.code === "repair_limit_reached"
);
const repairKey = reusableSkillRepairIdempotencyKey({
  sourceRunId: failedRun.id,
  sourceFingerprint: failedRun.qualification_fingerprint,
  repairIteration: 1,
});
assert.equal(
  repairKey,
  reusableSkillRepairIdempotencyKey({
    sourceRunId: failedRun.id,
    sourceFingerprint: failedRun.qualification_fingerprint,
    repairIteration: 1,
  })
);
assert.notEqual(
  repairKey,
  reusableSkillRepairIdempotencyKey({
    sourceRunId: failedRun.id,
    sourceFingerprint: failedRun.qualification_fingerprint,
    repairIteration: 2,
  })
);
const repairMetadata = buildReusableSkillRepairMetadata({
  sourceSkill: skill,
  sourceRun: failedRun,
  proposedBodyMd: `${skill.body_md}\n\n## Qualification fix\nAlways produce the fictional dry-run deliverable.`,
  compilerModelId: "openai/compiler",
  repairIteration: 1,
});
assert.deepEqual(repairMetadata.repair_provenance, {
  schema_version: "1",
  source_skill_id: skill.id,
  source_skill_slug: skill.slug,
  source_skill_version: skill.version,
  source_qualification_run_id: failedRun.id,
  source_qualification_fingerprint: failedRun.qualification_fingerprint,
  repair_iteration: 1,
  compiler_model_id: "openai/compiler",
});
assert.throws(
  () =>
    buildReusableSkillRepairMetadata({
      sourceSkill: skill,
      sourceRun: failedRun,
      proposedBodyMd: skill.body_md.replace(
        "allowed_tools: []",
        "allowed_tools:\n  - external-write"
      ),
      compilerModelId: "openai/compiler",
      repairIteration: 1,
    }),
  (error) =>
    error instanceof StudioQualificationRequestError &&
    error.code === "repair_proposal_expanded_capabilities"
);

function usageEvent(
  patch: Partial<AiUsageEvent> = {}
): AiUsageEvent {
  return {
    id: randomUUID(),
    user_id: skill.user_id,
    occurred_at: "2026-08-09T12:00:00.000Z",
    provider: "openrouter",
    resource_type: "ai_model",
    operation: "chat_completion",
    model_id: "openai/executor",
    model_role: "main_agent",
    channel: "case_runner",
    input_tokens: 10,
    output_tokens: 5,
    total_tokens: 15,
    cached_input_tokens: null,
    reasoning_tokens: null,
    reported_cost_micro_usd: null,
    estimated_cost_micro_usd: 7,
    currency: "USD",
    pricing_version: "prices-v1",
    latency_ms: 100,
    status: "ok",
    error_code: null,
    retry_ordinal: 0,
    provider_request_id: null,
    session_id: null,
    turn_id: null,
    operational_case_id: null,
    workflow_definition_id: null,
    studio_qualification_run_id: qualificationRun().id,
    work_item_id: null,
    work_item_attempt_id: null,
    metadata_jsonb: {},
    created_at: "2026-08-09T12:00:00.000Z",
    ...patch,
  };
}

const usage = summarizeQualificationUsage([
  usageEvent(),
  usageEvent({
    input_tokens: 4,
    output_tokens: 3,
    total_tokens: 7,
    reported_cost_micro_usd: 11,
    estimated_cost_micro_usd: 9,
    latency_ms: 50,
  }),
]);
assert.equal(usage.inputTokens, 14);
assert.equal(usage.totalTokens, 22);
assert.equal(usage.accountedCostMicroUsd, 18);
assert.equal(usage.latencyMs, 150);
assert.equal(usage.pricingVersion, "prices-v1");

console.log("reusable-skill-qualification.selftest: ok");
