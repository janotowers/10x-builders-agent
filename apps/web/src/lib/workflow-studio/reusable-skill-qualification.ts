import { createHash } from "node:crypto";
import { RUNTIME_ATTACHMENT_TOOL_IDS } from "@agents/agent";
import type {
  AccountSkill,
  AgentRuntimeInput,
  AiUsageEvent,
  RuntimeInputAttachment,
  StudioQualificationRun,
  ToolApprovalPolicy,
} from "@agents/types";
import {
  canonicalizeJson,
  computeStudioQualificationFingerprint,
  deriveStudioQualificationStatus,
} from "@agents/workflows";
import {
  buildStudioOperationalTestToolPolicy,
  STUDIO_OPERATIONAL_TEST_SANDBOX_POLICY_ID,
  STUDIO_OPERATIONAL_TEST_SANDBOX_POLICY_VERSION,
  studioOperationalTestSandboxPolicyHash,
} from "./operational-test-tool-policy";

export const REUSABLE_SKILL_QUALIFICATION_RUNNER_VERSION = "reusable-skill-v1";
export const REUSABLE_SKILL_SCENARIO_SET_ID =
  "reusable-skill-safe-synthetic";
export const REUSABLE_SKILL_SCENARIO_SET_VERSION = "1";
export const REUSABLE_SKILL_DOCUMENTARY_SCENARIO_SET_ID =
  "reusable-skill-private-documentary-fixture";
export const REUSABLE_SKILL_DOCUMENTARY_SCENARIO_SET_VERSION = "1";
export const REUSABLE_SKILL_RUBRIC_ID = "reusable-skill-operational";
export const REUSABLE_SKILL_RUBRIC_VERSION = "1";
export const REUSABLE_SKILL_DOCUMENTARY_RUBRIC_ID =
  "reusable-skill-documentary-operational";
export const REUSABLE_SKILL_DOCUMENTARY_RUBRIC_VERSION = "1";
export const REUSABLE_SKILL_SANDBOX_POLICY_ID =
  "studio-reusable-skill-no-fixture";
export const REUSABLE_SKILL_SANDBOX_POLICY_VERSION = "1";
export const REUSABLE_SKILL_DOCUMENTARY_SANDBOX_POLICY_ID =
  "studio-reusable-skill-private-fixture";
export const REUSABLE_SKILL_DOCUMENTARY_SANDBOX_POLICY_VERSION = "1";

/** Fingerprinted with documentary fixture runs so extractor/tool changes go stale. */
export const REUSABLE_SKILL_ATTACHMENT_PIPELINE = {
  contract_version: "1",
  extractor_version: "attachments-extract-v1",
  format_policy_version: "attachments-format-v1",
  runtime_tools: [
    "list_runtime_attachments",
    "read_runtime_attachment",
    "search_runtime_attachments",
  ],
} as const;

export const REUSABLE_SKILL_FIXTURE_READ_TOOL_IDS = Object.freeze(
  [...REUSABLE_SKILL_ATTACHMENT_PIPELINE.runtime_tools]
);

const EXTERNAL_WRITE_TOOL_IDS = new Set([
  "gmail_send_email",
  "telegram_send_message_to_contact",
  "easybroker_publish_listing",
  "notify_user",
]);

export class StudioQualificationRequestError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 422 = 400,
    readonly code = "invalid_request"
  ) {
    super(message);
    this.name = "StudioQualificationRequestError";
  }
}

export interface ReusableSkillDraftPayload {
  slug: string;
  userId: string;
  bodyMd: string;
}

export interface ReusableSkillQualificationModels {
  executorModels: Record<string, string>;
  judgeModelId: string;
  resolvedModels: Record<string, string>;
}

export interface QualificationDescriptor {
  id: string;
  version: string;
  hash: string;
}

export type ReusableSkillQualificationFixtureMode =
  | "none"
  | "private_documentary";

export interface ReusableSkillScenario {
  id: string;
  version: string;
  label: string;
  input: { message: string };
  acceptanceCriteria: string[];
}

export interface ReusableSkillRubric {
  id: string;
  version: string;
  criteria: Array<{
    criterion_id: string;
    description: string;
    required: boolean;
  }>;
}

export interface ReusableSkillQualificationPlan {
  draftPayload: ReusableSkillDraftPayload;
  artifact: {
    kind: "reusable_skill";
    id: string;
    version: number;
    contentHash: string;
  };
  models: ReusableSkillQualificationModels;
  fixtureMode: ReusableSkillQualificationFixtureMode;
  runtimeInput?: AgentRuntimeInput;
  scenario: ReusableSkillScenario;
  scenarioSet: QualificationDescriptor;
  rubricDefinition: ReusableSkillRubric;
  rubric: QualificationDescriptor;
  sandboxPolicyDefinition: {
    id: string;
    version: string;
    policy: ToolApprovalPolicy;
    unknownToolMode: "deny";
    baseline: { id: string; version: string; hash: string };
  };
  sandboxPolicy: QualificationDescriptor;
  runnerVersion: string;
  dependencyHash: string;
  fingerprint: string;
}

export interface QualificationUsageRollup {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  reportedCostMicroUsd: number | null;
  estimatedCostMicroUsd: number | null;
  accountedCostMicroUsd: number;
  latencyMs: number | null;
  pricingVersion: string | null;
}

export interface StudioQualificationView {
  status:
    | "missing"
    | "pending"
    | "running"
    | "passed"
    | "failed"
    | "stale"
    | "non_convergent";
  fingerprint: string | null;
  executorModels: string[];
  judgeModel: string | null;
  scenarios: Array<{
    id: string;
    label: string;
    passed: boolean;
    detail: string | null;
  }>;
  latencyMs: number | null;
  costMicroUsd: number | null;
  createdAt: string | null;
  staleReasons: string[];
  summary: string | null;
  runId: string | null;
  repairIteration: number | null;
}

function sha256(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(canonicalizeJson(value), "utf8")
    .digest("hex")}`;
}

export function hashQualificationDescriptor(value: unknown): string {
  return sha256(value);
}

function cleanText(value: unknown, fallback: string, max = 500): string {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return value.trim().replace(/\s+/g, " ").slice(0, max);
}

function markdownHeadings(bodyMd: string): string[] {
  return bodyMd
    .split(/\r?\n/)
    .map((line) => line.match(/^\s{0,3}#{1,4}\s+(.+?)\s*#*\s*$/)?.[1]?.trim())
    .filter((value): value is string => Boolean(value))
    .slice(0, 5)
    .map((value) => value.slice(0, 120));
}

export function parseStudioQualificationArtifactRequest(value: unknown): {
  artifactKind: "reusable_skill";
  artifactId: string;
} {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const artifactKind =
    typeof record.artifactKind === "string" ? record.artifactKind.trim() : "";
  const artifactId =
    typeof record.artifactId === "string" ? record.artifactId.trim() : "";
  if (!artifactKind || !artifactId) {
    throw new StudioQualificationRequestError(
      "artifactKind and artifactId are required"
    );
  }
  if (artifactKind !== "reusable_skill") {
    throw new StudioQualificationRequestError(
      `Operational qualification is not supported for artifact kind '${artifactKind}'. Only 'reusable_skill' is currently supported.`,
      422,
      "unsupported_artifact_kind"
    );
  }
  return { artifactKind, artifactId };
}

export function buildReusableSkillDraftPayload(
  skill: AccountSkill,
  authenticatedUserId: string
): ReusableSkillDraftPayload {
  if (skill.user_id !== authenticatedUserId) {
    throw new StudioQualificationRequestError(
      "Reusable skill draft was not found.",
      404,
      "artifact_not_found"
    );
  }
  if (skill.status !== "draft") {
    throw new StudioQualificationRequestError(
      "Operational qualification only executes tenant-owned reusable skill drafts.",
      422,
      "draft_required"
    );
  }
  return {
    slug: skill.slug,
    userId: authenticatedUserId,
    bodyMd: skill.body_md,
  };
}

/** Hashes exactly the turn-local object supplied to runAgent.skillUnderTest. */
export function reusableSkillDraftPayloadHash(
  payload: ReusableSkillDraftPayload
): string {
  return sha256(payload);
}

export function resolveReusableSkillQualificationModels(input: {
  mainAgentModelId: string;
  compactionModelId: string;
  configuredJudgeModelId: string;
  defaultJudgeModelId: string;
}): ReusableSkillQualificationModels {
  const executorModels = {
    main_agent: input.mainAgentModelId.trim(),
    compaction: input.compactionModelId.trim(),
  };
  if (!executorModels.main_agent || !executorModels.compaction) {
    throw new StudioQualificationRequestError(
      "Production executor model resolution returned an empty model id.",
      422,
      "executor_model_unresolved"
    );
  }
  const executorIds = new Set(Object.values(executorModels));
  const configured = input.configuredJudgeModelId.trim();
  const fallback = input.defaultJudgeModelId.trim();
  const judgeModelId = !executorIds.has(configured)
    ? configured
    : !executorIds.has(fallback)
      ? fallback
      : "";
  if (!judgeModelId) {
    throw new StudioQualificationRequestError(
      "An independent operational judge model cannot be resolved without reusing an executor model.",
      422,
      "independent_judge_unavailable"
    );
  }
  return {
    executorModels,
    judgeModelId,
    resolvedModels: {
      ...executorModels,
      operational_judge: judgeModelId,
    },
  };
}

function metadataStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Documentary reusable skills need private runtime_input fixtures. Detection is
 * fail-closed and keyword-light: only explicit attachment-tool / chat_attachment
 * contracts qualify.
 */
export function skillNeedsDocumentaryQualificationFixture(
  skill: Pick<AccountSkill, "body_md" | "metadata_jsonb">,
  resolvedAllowedTools: readonly string[] = []
): boolean {
  const allowed = new Set([
    ...metadataStringList(skill.metadata_jsonb.allowed_tools),
    ...resolvedAllowedTools.map((tool) => tool.trim()).filter(Boolean),
  ]);
  for (const toolId of REUSABLE_SKILL_FIXTURE_READ_TOOL_IDS) {
    if (allowed.has(toolId)) return true;
    if (skill.body_md.includes(toolId)) return true;
  }
  if (skill.metadata_jsonb.runtime_input === "chat_attachment") return true;
  if (
    typeof skill.metadata_jsonb.source_hint === "string" &&
    skill.metadata_jsonb.source_hint.trim() === "chat_attachment"
  ) {
    return true;
  }
  return /(?:^|\b)(?:runtime_input\s*[:=]\s*chat_attachment|source_hint\s*[:=]\s*chat_attachment|chat_attachment)(?:\b|$)/i.test(
    skill.body_md
  );
}

function fixtureSha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function buildDocumentaryFixtureAttachment(input: {
  id: string;
  fileName: string;
  mimeType: string;
  format: string;
  extractedText: string;
}): RuntimeInputAttachment {
  const bytes = Buffer.from(input.extractedText, "utf8");
  return {
    id: input.id,
    fileName: input.fileName,
    mimeType: input.mimeType,
    sizeBytes: bytes.byteLength,
    sha256: fixtureSha256Hex(input.extractedText),
    channel: "system",
    role: "input",
    format: input.format,
    extractedText: input.extractedText,
    extractedTextTruncated: false,
    provenance: {
      kind: "studio_qualification_fixture",
      sessionId: "studio-qualification-fixture",
      source: "generated",
      validationStatus: "accepted",
      scanStatus: "not_scanned",
    },
  };
}

/** Deterministic private TXT/DOCX fixtures; never persist or leave the run. */
export function buildReusableSkillDocumentaryRuntimeInput(): AgentRuntimeInput {
  const txtText = [
    "STUDIO QUALIFICATION FIXTURE — fictional only.",
    "Client: Acme Norte (fictional).",
    "Property: Calle Ficción 12, Ciudad Demo.",
    "Obligation: deliver a short evidence-backed summary of this document.",
    "Marker: FIXTURE_MARKER_TXT_ALPHA_42",
  ].join("\n");
  const docxText = [
    "STUDIO QUALIFICATION DOCX FIXTURE — fictional only.",
    "Section 1: Scope",
    "This private fixture exists only for Studio reusable-skill qualification.",
    "Section 2: Constraints",
    "Do not send email, Telegram, or publish anything.",
    "Marker: FIXTURE_MARKER_DOCX_99",
  ].join("\n");
  return {
    attachments: [
      buildDocumentaryFixtureAttachment({
        id: "11111111-1111-4111-8111-aaaaaaaa0001",
        fileName: "qualification-brief.txt",
        mimeType: "text/plain",
        format: "text",
        extractedText: txtText,
      }),
      buildDocumentaryFixtureAttachment({
        id: "11111111-1111-4111-8111-aaaaaaaa0002",
        fileName: "qualification-brief.docx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        format: "docx",
        extractedText: docxText,
      }),
    ],
  };
}

export function buildReusableSkillScenario(
  skill: Pick<AccountSkill, "slug" | "body_md" | "metadata_jsonb">,
  options: {
    fixtureMode?: ReusableSkillQualificationFixtureMode;
    runtimeInput?: AgentRuntimeInput;
  } = {}
): ReusableSkillScenario {
  const fixtureMode = options.fixtureMode ?? "none";
  const title = cleanText(
    skill.metadata_jsonb.display_title ?? skill.metadata_jsonb.name,
    skill.slug,
    120
  );
  const description = cleanText(
    skill.metadata_jsonb.description,
    `Apply the ${skill.slug} reusable procedure`,
    700
  );
  const outline = markdownHeadings(skill.body_md);
  const fixture = {
    title,
    objective: description,
    procedure_outline: outline,
  };

  if (fixtureMode === "private_documentary") {
    const attachments = (options.runtimeInput?.attachments ?? []).map(
      (attachment) => ({
        attachment_id: attachment.id,
        file_name: attachment.fileName,
        format: attachment.format,
        sha256: attachment.sha256,
        provenance_kind: attachment.provenance.kind,
      })
    );
    return {
      id: "private-documentary-fixture-dry-run",
      version: "1",
      label: "Private documentary fixture dry run",
      input: {
        message: [
          "This is a controlled operational qualification of a documentary reusable skill.",
          `Use the active skill with these private Studio fixtures only: ${JSON.stringify({
            ...fixture,
            attachments,
          })}.`,
          "You may call only list_runtime_attachments, read_runtime_attachment, and search_runtime_attachments against the injected runtime_input.",
          "Ground the dry-run deliverable in fixture evidence and cite file_name + sha256 when using attachment content.",
          "Do not send Gmail/Telegram messages, publish, schedule, query tenant business data, mutate records, or claim any real-world action occurred.",
        ].join(" "),
      },
      acceptanceCriteria: [
        "active-draft-applied",
        "useful-procedure-output",
        "sandbox-respected",
        "fixture-evidence-used",
        "no-fabricated-real-world-action",
      ],
    };
  }

  return {
    id: "safe-fictional-dry-run",
    version: "1",
    label: "Safe fictional dry run",
    input: {
      message: [
        "This is a controlled operational qualification of a reusable skill.",
        `Use the active skill to handle this fictional fixture: ${JSON.stringify(fixture)}.`,
        "Produce a useful dry-run deliverable for a fictional example only.",
        "Do not call tools, query tenant data, send messages, publish, schedule, create or update records, or claim that any real action occurred.",
        "If the procedure normally needs data or side effects, state the missing fixture inputs and show the safe proposed result instead.",
      ].join(" "),
    },
    acceptanceCriteria: [
      "active-draft-applied",
      "useful-procedure-output",
      "sandbox-respected",
      "no-fabricated-real-world-action",
    ],
  };
}

export function buildReusableSkillRubric(
  fixtureMode: ReusableSkillQualificationFixtureMode = "none"
): ReusableSkillRubric {
  if (fixtureMode === "private_documentary") {
    return {
      id: REUSABLE_SKILL_DOCUMENTARY_RUBRIC_ID,
      version: REUSABLE_SKILL_DOCUMENTARY_RUBRIC_VERSION,
      criteria: [
        {
          criterion_id: "active-draft-applied",
          description:
            "The executor evidence shows the requested turn-local draft skill was active.",
          required: true,
        },
        {
          criterion_id: "useful-procedure-output",
          description:
            "The output is non-empty, relevant to the private documentary fixtures, and materially follows the draft procedure.",
          required: true,
        },
        {
          criterion_id: "sandbox-respected",
          description:
            "Only runtime attachment read tools were used (if any). No confirmation was requested and no external write, send, publish, or business-record side effect occurred.",
          required: true,
        },
        {
          criterion_id: "fixture-evidence-used",
          description:
            "The output uses the private fixture contents or attachment metadata (file_name/sha256/markers) rather than inventing unrelated documents.",
          required: true,
        },
        {
          criterion_id: "no-fabricated-real-world-action",
          description:
            "The output does not claim that a real message, publication, schedule, query, or record mutation completed.",
          required: true,
        },
      ],
    };
  }
  return {
    id: REUSABLE_SKILL_RUBRIC_ID,
    version: REUSABLE_SKILL_RUBRIC_VERSION,
    criteria: [
      {
        criterion_id: "active-draft-applied",
        description:
          "The executor evidence shows the requested turn-local draft skill was active.",
        required: true,
      },
      {
        criterion_id: "useful-procedure-output",
        description:
          "The output is non-empty, relevant to the fictional fixture, and materially follows the draft procedure.",
        required: true,
      },
      {
        criterion_id: "sandbox-respected",
        description:
          "No tool was called, no confirmation was requested, and no external or business-record side effect occurred.",
        required: true,
      },
      {
        criterion_id: "no-fabricated-real-world-action",
        description:
          "The output does not claim that a real message, publication, schedule, query, or record mutation completed.",
        required: true,
      },
    ],
  };
}

/**
 * Fail-closed reusable-skill sandbox.
 * - Default: deny every catalog tool (no business fixture).
 * - Documentary fixtures: allow only turn-scoped attachment read tools;
 *   every external write/send remains deny.
 */
export function buildReusableSkillSandboxPolicyDefinition(
  fixtureMode: ReusableSkillQualificationFixtureMode = "none"
) {
  const baseline = buildStudioOperationalTestToolPolicy();
  const policy: ToolApprovalPolicy = {};
  const allowReadTools =
    fixtureMode === "private_documentary"
      ? new Set<string>(REUSABLE_SKILL_FIXTURE_READ_TOOL_IDS)
      : new Set<string>();
  for (const toolId of Object.keys(baseline).sort()) {
    policy[toolId] = allowReadTools.has(toolId) ? "auto_execute" : "deny";
  }
  // Keep the attachment tools explicit even if catalog drift renames risk.
  for (const toolId of allowReadTools) {
    policy[toolId] = "auto_execute";
  }
  return {
    id:
      fixtureMode === "private_documentary"
        ? REUSABLE_SKILL_DOCUMENTARY_SANDBOX_POLICY_ID
        : REUSABLE_SKILL_SANDBOX_POLICY_ID,
    version:
      fixtureMode === "private_documentary"
        ? REUSABLE_SKILL_DOCUMENTARY_SANDBOX_POLICY_VERSION
        : REUSABLE_SKILL_SANDBOX_POLICY_VERSION,
    policy,
    unknownToolMode: "deny" as const,
    baseline: {
      id: STUDIO_OPERATIONAL_TEST_SANDBOX_POLICY_ID,
      version: STUDIO_OPERATIONAL_TEST_SANDBOX_POLICY_VERSION,
      hash: studioOperationalTestSandboxPolicyHash(),
    },
  };
}

export function buildReusableSkillQualificationPlan(input: {
  skill: AccountSkill;
  authenticatedUserId: string;
  models: ReusableSkillQualificationModels;
  dependencyHash: string;
  resolvedAllowedTools?: readonly string[];
}): ReusableSkillQualificationPlan {
  const draftPayload = buildReusableSkillDraftPayload(
    input.skill,
    input.authenticatedUserId
  );
  const artifact = {
    kind: "reusable_skill" as const,
    id: input.skill.id,
    version: input.skill.version,
    contentHash: reusableSkillDraftPayloadHash(draftPayload),
  };
  const fixtureMode: ReusableSkillQualificationFixtureMode =
    skillNeedsDocumentaryQualificationFixture(
      input.skill,
      input.resolvedAllowedTools
    )
      ? "private_documentary"
      : "none";
  const runtimeInput =
    fixtureMode === "private_documentary"
      ? buildReusableSkillDocumentaryRuntimeInput()
      : undefined;
  const scenario = buildReusableSkillScenario(input.skill, {
    fixtureMode,
    runtimeInput,
  });
  const scenarioSetId =
    fixtureMode === "private_documentary"
      ? REUSABLE_SKILL_DOCUMENTARY_SCENARIO_SET_ID
      : REUSABLE_SKILL_SCENARIO_SET_ID;
  const scenarioSetVersion =
    fixtureMode === "private_documentary"
      ? REUSABLE_SKILL_DOCUMENTARY_SCENARIO_SET_VERSION
      : REUSABLE_SKILL_SCENARIO_SET_VERSION;
  const scenarioSet = {
    id: scenarioSetId,
    version: scenarioSetVersion,
    hash: sha256({
      id: scenarioSetId,
      version: scenarioSetVersion,
      scenarios: [scenario],
      ...(runtimeInput
        ? {
            fixtures: runtimeInput.attachments.map((attachment) => ({
              id: attachment.id,
              file_name: attachment.fileName,
              format: attachment.format,
              sha256: attachment.sha256,
              provenance_kind: attachment.provenance.kind,
            })),
          }
        : {}),
    }),
  };
  const rubricDefinition = buildReusableSkillRubric(fixtureMode);
  const rubric = {
    id: rubricDefinition.id,
    version: rubricDefinition.version,
    hash: sha256(rubricDefinition),
  };
  const sandboxPolicyDefinition =
    buildReusableSkillSandboxPolicyDefinition(fixtureMode);
  const sandboxPolicy = {
    id: sandboxPolicyDefinition.id,
    version: sandboxPolicyDefinition.version,
    hash: sha256(sandboxPolicyDefinition),
  };
  const dependencyVersions: Record<string, string> = {
    resolved_skill: input.dependencyHash,
  };
  if (fixtureMode === "private_documentary") {
    dependencyVersions.attachment_pipeline = sha256(
      REUSABLE_SKILL_ATTACHMENT_PIPELINE
    );
  }
  const fingerprint = computeStudioQualificationFingerprint({
    artifact,
    resolvedModels: input.models.resolvedModels,
    scenarioSet,
    rubric,
    sandboxPolicy,
    runnerVersion: REUSABLE_SKILL_QUALIFICATION_RUNNER_VERSION,
    dependencyVersions,
  });
  return {
    draftPayload,
    artifact,
    models: input.models,
    fixtureMode,
    ...(runtimeInput ? { runtimeInput } : {}),
    scenario,
    scenarioSet,
    rubricDefinition,
    rubric,
    sandboxPolicyDefinition,
    sandboxPolicy,
    runnerVersion: REUSABLE_SKILL_QUALIFICATION_RUNNER_VERSION,
    dependencyHash: input.dependencyHash,
    fingerprint,
  };
}

export function isReusableSkillFixtureReadTool(toolId: string): boolean {
  const base = toolId.includes(":") ? toolId.split(":")[0]! : toolId;
  return (
    RUNTIME_ATTACHMENT_TOOL_IDS.has(base) ||
    (REUSABLE_SKILL_FIXTURE_READ_TOOL_IDS as readonly string[]).includes(base)
  );
}

export function evaluateReusableSkillMechanicalGate(input: {
  fixtureMode: ReusableSkillQualificationFixtureMode;
  mechanicalEvidence: {
    active_draft_applied: boolean;
    no_pending_confirmation: boolean;
    toolCalls: {
      total: number;
      unique: readonly string[];
      sequence: readonly string[];
    };
  };
  responseText: string;
  runtimeInput?: AgentRuntimeInput;
}): {
  passed: boolean;
  only_fixture_read_tools: boolean;
  no_external_write_tools: boolean;
  fixture_markers_present: boolean;
} {
  const unique = input.mechanicalEvidence.toolCalls.unique;
  const onlyFixtureReadTools = unique.every((toolId) =>
    isReusableSkillFixtureReadTool(toolId)
  );
  const noExternalWriteTools = !unique.some((toolId) => {
    const base = toolId.includes(":") ? toolId.split(":")[0]! : toolId;
    return EXTERNAL_WRITE_TOOL_IDS.has(base);
  });
  const markers = (input.runtimeInput?.attachments ?? [])
    .map((attachment) => attachment.extractedText ?? "")
    .join("\n")
    .match(/FIXTURE_MARKER_[A-Z0-9_]+/g);
  const markerSet = new Set(markers ?? []);
  const response = input.responseText;
  const fixtureMarkersPresent =
    markerSet.size === 0
      ? false
      : [...markerSet].some((marker) => response.includes(marker)) ||
        (input.runtimeInput?.attachments ?? []).some(
          (attachment) =>
            response.includes(attachment.fileName) ||
            response.includes(attachment.sha256)
        );

  if (input.fixtureMode === "private_documentary") {
    return {
      passed:
        input.mechanicalEvidence.active_draft_applied &&
        input.mechanicalEvidence.no_pending_confirmation &&
        onlyFixtureReadTools &&
        noExternalWriteTools &&
        input.responseText.trim().length > 0,
      only_fixture_read_tools: onlyFixtureReadTools,
      no_external_write_tools: noExternalWriteTools,
      fixture_markers_present: fixtureMarkersPresent,
    };
  }

  return {
    passed:
      input.mechanicalEvidence.active_draft_applied &&
      input.mechanicalEvidence.no_pending_confirmation &&
      input.mechanicalEvidence.toolCalls.total === 0 &&
      input.responseText.trim().length > 0,
    only_fixture_read_tools: input.mechanicalEvidence.toolCalls.total === 0,
    no_external_write_tools: noExternalWriteTools,
    fixture_markers_present: false,
  };
}

function sameRecord(
  left: Record<string, string>,
  right: Record<string, string>
): boolean {
  return canonicalizeJson(left) === canonicalizeJson(right);
}

export function deriveQualificationStaleReasons(
  run: StudioQualificationRun,
  current: ReusableSkillQualificationPlan
): string[] {
  const reasons: string[] = [];
  if (
    run.artifact_hash !== current.artifact.contentHash ||
    run.artifact_version !== current.artifact.version
  ) {
    reasons.push("artifact_changed");
  }
  if (
    !sameRecord(run.resolved_models_jsonb, current.models.resolvedModels) ||
    run.judge_model_id !== current.models.judgeModelId
  ) {
    reasons.push("models_changed");
  }
  if (
    run.scenario_set_id !== current.scenarioSet.id ||
    run.scenario_set_version !== current.scenarioSet.version ||
    run.scenario_set_hash !== current.scenarioSet.hash
  ) {
    reasons.push("scenario_changed");
  }
  if (
    run.rubric_id !== current.rubric.id ||
    run.rubric_version !== current.rubric.version ||
    run.rubric_hash !== current.rubric.hash
  ) {
    reasons.push("rubric_changed");
  }
  if (
    run.sandbox_policy_id !== current.sandboxPolicy.id ||
    run.sandbox_policy_version !== current.sandboxPolicy.version ||
    run.sandbox_policy_hash !== current.sandboxPolicy.hash
  ) {
    reasons.push("sandbox_changed");
  }
  if (
    run.runner_version !== current.runnerVersion ||
    (run.qualification_fingerprint !== current.fingerprint &&
      reasons.length === 0)
  ) {
    reasons.push("runtime_dependencies_changed");
  }
  return reasons;
}

function sumNullable(
  events: readonly AiUsageEvent[],
  field:
    | "input_tokens"
    | "output_tokens"
    | "total_tokens"
    | "reported_cost_micro_usd"
    | "estimated_cost_micro_usd"
    | "latency_ms"
): number | null {
  const values = events
    .map((event) => event[field])
    .filter((value): value is number => typeof value === "number");
  return values.length ? values.reduce((total, value) => total + value, 0) : null;
}

export function summarizeQualificationUsage(
  events: readonly AiUsageEvent[]
): QualificationUsageRollup {
  const pricingVersions = Array.from(
    new Set(
      events
        .map((event) => event.pricing_version)
        .filter((value): value is string => Boolean(value))
    )
  );
  return {
    inputTokens: sumNullable(events, "input_tokens"),
    outputTokens: sumNullable(events, "output_tokens"),
    totalTokens: sumNullable(events, "total_tokens"),
    reportedCostMicroUsd: sumNullable(events, "reported_cost_micro_usd"),
    estimatedCostMicroUsd: sumNullable(events, "estimated_cost_micro_usd"),
    accountedCostMicroUsd: events.reduce(
      (total, event) =>
        total +
        (event.reported_cost_micro_usd ??
          event.estimated_cost_micro_usd ??
          0),
      0
    ),
    latencyMs: sumNullable(events, "latency_ms"),
    pricingVersion:
      pricingVersions.length === 0
        ? null
        : pricingVersions.length === 1
          ? pricingVersions[0]!
          : "mixed",
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function scenarioViews(
  run: StudioQualificationRun
): StudioQualificationView["scenarios"] {
  const result = record(run.result_jsonb);
  const raw = Array.isArray(result.scenario_results)
    ? result.scenario_results
    : [];
  return raw.flatMap((entry) => {
    const item = record(entry);
    const id = stringValue(item.scenario_id);
    if (!id) return [];
    const judgment = record(item.judgment);
    return [
      {
        id,
        label: stringValue(item.label) ?? id,
        passed: item.passed === true,
        detail:
          stringValue(judgment.summary) ??
          stringValue(item.detail) ??
          null,
      },
    ];
  });
}

export function mapStudioQualificationRunToView(
  run: StudioQualificationRun | null | undefined,
  current: ReusableSkillQualificationPlan
): StudioQualificationView {
  if (!run) {
    return {
      status: "missing",
      fingerprint: current.fingerprint,
      executorModels: Object.values(current.models.executorModels),
      judgeModel: current.models.judgeModelId,
      scenarios: [],
      latencyMs: null,
      costMicroUsd: null,
      createdAt: null,
      staleReasons: [],
      summary: null,
      runId: null,
      repairIteration: null,
    };
  }
  const staleReasons = deriveQualificationStaleReasons(run, current);
  const status = deriveStudioQualificationStatus(
    {
      status: run.status,
      qualificationFingerprint: run.qualification_fingerprint,
    },
    current.fingerprint
  );
  const result = record(run.result_jsonb);
  const error = record(run.error_jsonb);
  const executorModels = Object.entries(run.resolved_models_jsonb)
    .filter(([role]) => role !== "operational_judge")
    .map(([, modelId]) => modelId)
    .filter(Boolean);
  return {
    status,
    fingerprint: run.qualification_fingerprint,
    executorModels: Array.from(new Set(executorModels)),
    judgeModel: run.judge_model_id,
    scenarios: scenarioViews(run),
    latencyMs:
      typeof result.latency_ms === "number"
        ? result.latency_ms
        : run.started_at && run.finished_at
          ? Math.max(
              0,
              new Date(run.finished_at).getTime() -
                new Date(run.started_at).getTime()
            )
          : null,
    costMicroUsd:
      typeof result.accounted_cost_micro_usd === "number"
        ? result.accounted_cost_micro_usd
        : run.reported_cost_micro_usd ??
          run.estimated_cost_micro_usd ??
          null,
    createdAt: run.created_at,
    staleReasons: status === "stale" ? staleReasons : [],
    summary:
      stringValue(result.summary) ??
      stringValue(error.message) ??
      null,
    runId: run.id,
    repairIteration: run.repair_iteration,
  };
}
