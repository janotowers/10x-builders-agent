import assert from "node:assert/strict";
import {
  canTransitionStudioQualificationStatus,
  computeStudioQualificationFingerprint,
  deriveStudioQualificationStatus,
  operationalJudgeVerdictSchema,
  studioQualificationBlocksActivation,
  type StudioQualificationFingerprintInput,
} from "./studio-qualification";

const base: StudioQualificationFingerprintInput = {
  artifact: {
    kind: "case_workflow",
    id: "11111111-1111-1111-1111-111111111111",
    version: 3,
    contentHash: "sha256:artifact",
  },
  resolvedModels: {
    main_agent: "openai/gpt-5.4-mini",
    operational_judge: "anthropic/claude-opus-5",
  },
  scenarioSet: { id: "workflow-happy-path", version: "2", hash: "sha256:scenarios" },
  rubric: { id: "workflow-operational", version: "1", hash: "sha256:rubric" },
  sandboxPolicy: {
    id: "studio-operational-test",
    version: "1",
    hash: "sha256:policy",
  },
  runnerVersion: "1",
  dependencyVersions: { tools: "catalog-4", prompts: "prompt-2" },
};

const fingerprint = computeStudioQualificationFingerprint(base);
assert.match(fingerprint, /^sha256:[a-f0-9]{64}$/);
assert.equal(
  fingerprint,
  computeStudioQualificationFingerprint({
    ...base,
    resolvedModels: {
      operational_judge: "anthropic/claude-opus-5",
      main_agent: "openai/gpt-5.4-mini",
    },
    dependencyVersions: { prompts: "prompt-2", tools: "catalog-4" },
  }),
  "object insertion order must not affect the fingerprint"
);

for (const changed of [
  { ...base, artifact: { ...base.artifact, contentHash: "sha256:new-artifact" } },
  {
    ...base,
    resolvedModels: { ...base.resolvedModels, main_agent: "openai/gpt-6" },
  },
  {
    ...base,
    scenarioSet: { ...base.scenarioSet, version: "3" },
  },
  { ...base, rubric: { ...base.rubric, hash: "sha256:new-rubric" } },
  {
    ...base,
    sandboxPolicy: { ...base.sandboxPolicy, version: "2" },
  },
  { ...base, dependencyVersions: { ...base.dependencyVersions, tools: "catalog-5" } },
]) {
  assert.notEqual(computeStudioQualificationFingerprint(changed), fingerprint);
}

assert.equal(deriveStudioQualificationStatus(null, fingerprint), "missing");
assert.equal(
  deriveStudioQualificationStatus(
    { status: "passed", qualificationFingerprint: fingerprint },
    fingerprint
  ),
  "passed"
);
assert.equal(
  deriveStudioQualificationStatus(
    { status: "passed", qualificationFingerprint: "sha256:old" },
    fingerprint
  ),
  "stale",
  "changed qualification inputs invalidate rather than fail a pass"
);
assert.equal(studioQualificationBlocksActivation("passed"), false);
assert.equal(studioQualificationBlocksActivation("stale"), true);
assert.equal(studioQualificationBlocksActivation("missing"), true);

assert.equal(canTransitionStudioQualificationStatus("pending", "running"), true);
assert.equal(canTransitionStudioQualificationStatus("running", "passed"), true);
assert.equal(canTransitionStudioQualificationStatus("passed", "failed"), false);
assert.equal(canTransitionStudioQualificationStatus("passed", "stale"), true);
assert.equal(canTransitionStudioQualificationStatus("stale", "running"), false);

assert.equal(
  operationalJudgeVerdictSchema.safeParse({
    schema_version: "1",
    verdict: "pass",
    summary: "All acceptance criteria are supported by evidence.",
    confidence: 0.91,
    criteria: [
      {
        criterion_id: "result-contract",
        passed: true,
        score: 0.95,
        explanation: "The result contract is satisfied.",
      },
    ],
    remediation_items: [],
  }).success,
  true
);
assert.equal(
  operationalJudgeVerdictSchema.safeParse({
    schema_version: "1",
    verdict: "pass",
    summary: "Contradictory pass.",
    confidence: 0.5,
    criteria: [
      {
        criterion_id: "result-contract",
        passed: false,
        explanation: "The result contract is not satisfied.",
      },
    ],
  }).success,
  false
);

console.log("studio-qualification.selftest: ok");
