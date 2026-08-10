import { createHash } from "node:crypto";
import { parseAccountSkillSource } from "@agents/agent";
import type {
  AccountSkill,
  AccountSkillMetadata,
  StudioQualificationRun,
} from "@agents/types";
import { StudioQualificationRequestError } from "./reusable-skill-qualification";

/** Deliberately below the database-wide maximum of five. */
export const MAX_REUSABLE_SKILL_REPAIR_ITERATIONS = 3;

export function parseReusableSkillRepairRequest(value: unknown): {
  artifactKind: "reusable_skill";
  artifactId: string;
  sourceRunId: string;
} {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const artifactKind =
    typeof record.artifactKind === "string" ? record.artifactKind.trim() : "";
  const artifactId =
    typeof record.artifactId === "string" ? record.artifactId.trim() : "";
  const sourceRunId =
    typeof record.sourceRunId === "string" ? record.sourceRunId.trim() : "";
  if (!artifactKind || !artifactId || !sourceRunId) {
    throw new StudioQualificationRequestError(
      "artifactKind, artifactId, and sourceRunId are required"
    );
  }
  if (artifactKind !== "reusable_skill") {
    throw new StudioQualificationRequestError(
      "Governed repair currently supports only reusable skills.",
      422,
      "unsupported_artifact_kind"
    );
  }
  return { artifactKind, artifactId, sourceRunId };
}

export function assertReusableSkillRepairEligibility(input: {
  run: StudioQualificationRun;
  latestRun: StudioQualificationRun | null;
  currentSkill: AccountSkill;
  currentFingerprint: string;
}): number {
  const { run, latestRun, currentSkill, currentFingerprint } = input;
  if (run.artifact_kind !== "reusable_skill" || run.artifact_id !== currentSkill.id) {
    throw new StudioQualificationRequestError(
      "The failed run does not belong to this reusable skill.",
      409,
      "repair_source_mismatch"
    );
  }
  if (run.status !== "failed" && run.status !== "non_convergent") {
    throw new StudioQualificationRequestError(
      "Only a failed or non-convergent qualification can be repaired.",
      409,
      "repair_source_not_failed"
    );
  }
  if (!latestRun || latestRun.id !== run.id) {
    throw new StudioQualificationRequestError(
      "This is no longer the latest applicable qualification run.",
      409,
      "repair_source_not_latest"
    );
  }
  if (
    latestRun.status !== "failed" &&
    latestRun.status !== "non_convergent"
  ) {
    throw new StudioQualificationRequestError(
      "The latest qualification is no longer eligible for repair.",
      409,
      "repair_source_not_failed"
    );
  }
  if (
    latestRun.qualification_fingerprint !== currentFingerprint ||
    latestRun.artifact_version !== currentSkill.version
  ) {
    throw new StudioQualificationRequestError(
      "The draft or qualification inputs changed. Requalify before requesting repair.",
      409,
      "repair_source_stale"
    );
  }
  if (run.repair_iteration >= MAX_REUSABLE_SKILL_REPAIR_ITERATIONS) {
    throw new StudioQualificationRequestError(
      "The governed repair limit was reached. Human revision is required.",
      409,
      "repair_limit_reached"
    );
  }
  return run.repair_iteration + 1;
}

export function reusableSkillRepairIdempotencyKey(input: {
  sourceRunId: string;
  sourceFingerprint: string;
  repairIteration: number;
}): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        "reusable-skill-repair-v1",
        input.sourceRunId,
        input.sourceFingerprint,
        input.repairIteration,
      ]),
      "utf8"
    )
    .digest("hex");
  return `reusable-skill-repair-v1:${digest}`;
}

export function buildReusableSkillRepairMetadata(input: {
  sourceSkill: AccountSkill;
  sourceRun: StudioQualificationRun;
  proposedBodyMd: string;
  compilerModelId: string;
  repairIteration: number;
}): AccountSkillMetadata {
  const source = parseAccountSkillSource(
    input.sourceSkill.body_md,
    input.sourceSkill.slug,
    input.sourceSkill.user_id
  );
  const parsed = parseAccountSkillSource(
    input.proposedBodyMd,
    input.sourceSkill.slug,
    input.sourceSkill.user_id
  );
  const sourceTools = new Set(source.metadata.allowedTools);
  const sourceIncludes = new Set(source.metadata.includes);
  const introducedTools = [...parsed.metadata.allowedTools].filter(
    (toolId) => !sourceTools.has(toolId)
  );
  const introducedIncludes = [...parsed.metadata.includes].filter(
    (skillSlug) => !sourceIncludes.has(skillSlug)
  );
  if (introducedTools.length || introducedIncludes.length) {
    throw new StudioQualificationRequestError(
      [
        introducedTools.length
          ? `Repair introduced unreviewed tools: ${introducedTools.join(", ")}.`
          : "",
        introducedIncludes.length
          ? `Repair introduced unreviewed skill includes: ${introducedIncludes.join(", ")}.`
          : "",
      ]
        .filter(Boolean)
        .join(" "),
      422,
      "repair_proposal_expanded_capabilities"
    );
  }

  return {
    ...input.sourceSkill.metadata_jsonb,
    name: parsed.metadata.name,
    description: parsed.metadata.description,
    scope: parsed.metadata.scope,
    allowed_tools: [...parsed.metadata.allowedTools],
    includes: [...parsed.metadata.includes],
    requires_tenant_context: parsed.metadata.requiresTenantContext,
    memory_extraction: parsed.metadata.memoryExtraction,
    repair_provenance: {
      schema_version: "1",
      source_skill_id: input.sourceSkill.id,
      source_skill_slug: input.sourceSkill.slug,
      source_skill_version: input.sourceSkill.version,
      source_qualification_run_id: input.sourceRun.id,
      source_qualification_fingerprint:
        input.sourceRun.qualification_fingerprint,
      repair_iteration: input.repairIteration,
      compiler_model_id: input.compilerModelId,
    },
  };
}
