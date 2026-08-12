import { createHash } from "node:crypto";
import {
  authoringCapabilityNeedSchema,
  authoringDataSourcesContractSchema,
  authoringInvocationChannelSchema,
  authoringOutboundContractSchema,
  authoringRecipientProvenanceReviewSchema,
  authoringSourceStrategySchema,
  canonicalizeJson,
  inputRequirementSchema,
  type AuthoringDiscoveryOutput,
} from "@agents/workflows";
import { z } from "zod";

const discoveryHashSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/);

export const reusableSkillCompilationContractSchema = z
  .object({
    schema_version: z.literal("1"),
    discovery_hash: discoveryHashSchema,
    title: z.string().trim().min(1).max(160),
    slug: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9-]*$/),
    objective: z.string().trim().min(1).max(4000),
    acceptance_criteria: z
      .array(z.string().trim().min(1).max(500))
      .max(64),
    source_contract: z
      .object({
        strategy: authoringSourceStrategySchema.nullable(),
        data_sources: authoringDataSourcesContractSchema,
        audited_sources: z
          .array(z.string().trim().min(1).max(500))
          .max(64),
      })
      .strict(),
    input_contract: z
      .object({
        requirements: z.array(inputRequirementSchema).max(32),
        invocation_channels: z
          .array(authoringInvocationChannelSchema)
          .max(8),
      })
      .strict(),
    outbound_contract: authoringOutboundContractSchema.nullable(),
    recipient_provenance_review:
      authoringRecipientProvenanceReviewSchema.nullable(),
    requested_effects: z
      .array(
        z.enum([
          "send_message",
          "human_approval",
          "schedule_recurrence",
          "external_write",
          "create_case",
        ])
      )
      .max(8),
    capabilities: z.array(authoringCapabilityNeedSchema).max(16),
  })
  .strict();

export type ReusableSkillCompilationContract = z.infer<
  typeof reusableSkillCompilationContractSchema
>;

export function computeReusableSkillDiscoveryHash(
  discovery: AuthoringDiscoveryOutput
): string {
  return `sha256:${createHash("sha256")
    .update(
      canonicalizeJson({
        discovery,
        gap_plan: discovery.gap_plan ?? null,
      }),
      "utf8"
    )
    .digest("hex")}`;
}

export function buildReusableSkillCompilationContract(params: {
  discovery: AuthoringDiscoveryOutput;
  discoveryHash: string;
  title: string;
  slug: string;
}): ReusableSkillCompilationContract {
  if (params.discovery.final_kind !== "reusable_skill") {
    throw new Error("Reusable skill compilation requires reusable_skill discovery.");
  }
  const computedHash = computeReusableSkillDiscoveryHash(params.discovery);
  if (params.discoveryHash !== computedHash) {
    throw new Error("Persisted authoring discovery hash does not match discovery.");
  }
  return reusableSkillCompilationContractSchema.parse({
    schema_version: "1",
    discovery_hash: params.discoveryHash,
    title: params.title,
    slug: params.slug,
    objective: params.discovery.understanding.objective,
    acceptance_criteria:
      params.discovery.understanding.acceptance_criteria,
    source_contract: {
      strategy: params.discovery.source_strategy ?? null,
      data_sources: params.discovery.data_sources,
      audited_sources: params.discovery.understanding.sources,
    },
    input_contract: {
      requirements: params.discovery.input_requirements,
      invocation_channels: params.discovery.invocation_channels,
    },
    outbound_contract: params.discovery.outbound_contract ?? null,
    recipient_provenance_review:
      params.discovery.recipient_provenance_review ?? null,
    requested_effects: params.discovery.requested_side_effects,
    capabilities: params.discovery.capability_needs,
  });
}

export function reusableSkillContractRequiresExternalWrite(
  contract: ReusableSkillCompilationContract
): boolean {
  return contract.requested_effects.some(
    (effect) => effect === "send_message" || effect === "external_write"
  );
}
