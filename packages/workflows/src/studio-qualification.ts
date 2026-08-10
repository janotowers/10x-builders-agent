import { createHash } from "node:crypto";
import type {
  StudioQualificationArtifactKind,
  StudioQualificationRunStatus,
  ToolApprovalPolicy,
} from "@agents/types";
import { z } from "zod";
import { canonicalizeJson } from "./hash";

export interface StudioQualificationFingerprintInput {
  artifact: {
    kind: StudioQualificationArtifactKind;
    id: string;
    version?: number | null;
    contentHash: string;
  };
  /** Logical role → fully resolved provider model id. */
  resolvedModels: Record<string, string>;
  scenarioSet: { id: string; version: string; hash: string };
  rubric: { id: string; version: string; hash: string };
  sandboxPolicy: { id: string; version: string; hash: string };
  runnerVersion: string;
  /** Skill/tool/prompt registry versions or hashes that affect execution. */
  dependencyVersions?: Record<string, string>;
}

/**
 * Full qualification fingerprint. Any operationally meaningful input change
 * invalidates a previous result without claiming that the old result failed.
 */
export function computeStudioQualificationFingerprint(
  input: StudioQualificationFingerprintInput
): string {
  const canonical = canonicalizeJson({
    artifact: input.artifact,
    resolved_models: input.resolvedModels,
    scenario_set: input.scenarioSet,
    rubric: input.rubric,
    sandbox_policy: input.sandboxPolicy,
    runner_version: input.runnerVersion,
    dependency_versions: input.dependencyVersions ?? {},
  });
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

export type EffectiveStudioQualificationStatus =
  | StudioQualificationRunStatus
  | "missing";

export function isStudioQualificationRunStale(
  storedFingerprint: string,
  currentFingerprint: string
): boolean {
  return storedFingerprint !== currentFingerprint;
}

/**
 * Derived status used by activation/publish gates. The durable row remains
 * historical; callers may separately persist `stale` through the DB helper.
 */
export function deriveStudioQualificationStatus(
  latestRun:
    | {
        status: StudioQualificationRunStatus;
        qualificationFingerprint: string;
      }
    | null
    | undefined,
  currentFingerprint: string
): EffectiveStudioQualificationStatus {
  if (!latestRun) return "missing";
  if (
    latestRun.status === "stale" ||
    isStudioQualificationRunStale(
      latestRun.qualificationFingerprint,
      currentFingerprint
    )
  ) {
    return "stale";
  }
  return latestRun.status;
}

/** Only a fresh pass authorizes a new activation. */
export function studioQualificationBlocksActivation(
  status: EffectiveStudioQualificationStatus
): boolean {
  return status !== "passed";
}

const ALLOWED_STATUS_TRANSITIONS: Readonly<
  Record<StudioQualificationRunStatus, readonly StudioQualificationRunStatus[]>
> = {
  pending: ["running", "failed", "stale"],
  running: ["passed", "failed", "stale", "non_convergent"],
  passed: ["stale"],
  failed: ["stale"],
  stale: [],
  non_convergent: ["stale"],
};

export function canTransitionStudioQualificationStatus(
  from: StudioQualificationRunStatus,
  to: StudioQualificationRunStatus
): boolean {
  return ALLOWED_STATUS_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// Structured independent-judge contract
// ---------------------------------------------------------------------------

export const operationalJudgeCriterionSchema = z.object({
  criterion_id: z.string().min(1),
  passed: z.boolean(),
  score: z.number().min(0).max(1).optional(),
  explanation: z.string().min(1),
});

export const operationalJudgeVerdictSchema = z
  .object({
    schema_version: z.literal("1"),
    verdict: z.enum(["pass", "fail"]),
    summary: z.string().min(1),
    confidence: z.number().min(0).max(1),
    criteria: z.array(operationalJudgeCriterionSchema).min(1),
    remediation_items: z.array(z.string().min(1)).default([]),
  })
  .superRefine((value, ctx) => {
    const anyFailed = value.criteria.some((criterion) => !criterion.passed);
    if (value.verdict === "pass" && anyFailed) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "pass verdict cannot contain a failed criterion",
        path: ["verdict"],
      });
    }
  });

export type OperationalJudgeVerdict = z.infer<
  typeof operationalJudgeVerdictSchema
>;

export interface OperationalJudgeRequest {
  runId: string;
  artifact: {
    kind: StudioQualificationArtifactKind;
    id: string;
    version?: number | null;
    contentHash: string;
  };
  scenario: { id: string; version: string; acceptanceCriteria: string[] };
  rubric: { id: string; version: string; criteria: unknown[] };
  executorOutput: unknown;
  mechanicalEvidence: Record<string, unknown>;
}

export interface StudioOperationalJudge {
  readonly modelId: string;
  judge(request: OperationalJudgeRequest): Promise<OperationalJudgeVerdict>;
}

// ---------------------------------------------------------------------------
// Runner seams. Slice 2 defines contracts only; API/UI and artifact-specific
// adapters implement these later.
// ---------------------------------------------------------------------------

export interface StudioOperationalScenario {
  id: string;
  version: string;
  input: unknown;
  acceptanceCriteria: string[];
}

export interface StudioOperationalExecutionRequest {
  runId: string;
  userId: string;
  artifact: OperationalJudgeRequest["artifact"];
  scenario: StudioOperationalScenario;
  resolvedModels: Record<string, string>;
  toolApprovalPolicy: ToolApprovalPolicy;
}

export interface StudioOperationalExecutionResult {
  output: unknown;
  mechanicalEvidence: Record<string, unknown>;
  usage?: {
    inputTokens?: number | null;
    outputTokens?: number | null;
    totalTokens?: number | null;
    reportedCostMicroUsd?: number | null;
    estimatedCostMicroUsd?: number | null;
    pricingVersion?: string | null;
  };
}

export interface StudioOperationalExecutor {
  execute(
    request: StudioOperationalExecutionRequest
  ): Promise<StudioOperationalExecutionResult>;
}

export interface StudioQualificationRunnerInput {
  runId: string;
  userId: string;
  fingerprint: string;
  artifact: OperationalJudgeRequest["artifact"];
  scenarios: StudioOperationalScenario[];
  resolvedModels: Record<string, string>;
  toolApprovalPolicy: ToolApprovalPolicy;
}

export interface StudioQualificationRunnerResult {
  status: Extract<
    StudioQualificationRunStatus,
    "passed" | "failed" | "non_convergent"
  >;
  scenarioResults: Array<{
    scenarioId: string;
    execution: StudioOperationalExecutionResult;
    judgment: OperationalJudgeVerdict;
  }>;
}

export interface StudioQualificationRunner {
  run(
    input: StudioQualificationRunnerInput
  ): Promise<StudioQualificationRunnerResult>;
}
