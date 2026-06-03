import { createToolCall } from "@agents/db";
import type { ToolCall, ToolCallMetadata } from "@agents/types";
import type { ToolContext } from "./tool-context";

export type ToolCallAuditContext = Pick<
  ToolContext,
  | "db"
  | "sessionId"
  | "turnId"
  | "caseId"
  | "operationalStepKey"
  | "activeSkillName"
  | "channel"
  | "toolCallSource"
>;

export function buildToolCallMetadata(
  ctx: Pick<
    ToolContext,
    | "caseId"
    | "operationalStepKey"
    | "activeSkillName"
    | "channel"
    | "toolCallSource"
  >,
  overrides?: Partial<ToolCallMetadata>
): ToolCallMetadata | undefined {
  const meta: ToolCallMetadata = {};
  if (ctx.caseId) meta.case_id = ctx.caseId;
  if (ctx.operationalStepKey) meta.operational_step_key = ctx.operationalStepKey;
  if (ctx.activeSkillName) meta.skill_slug = ctx.activeSkillName;
  if (ctx.toolCallSource) meta.source = ctx.toolCallSource;
  if (ctx.channel) meta.channel = ctx.channel;
  if (overrides) Object.assign(meta, overrides);
  return Object.keys(meta).length > 0 ? meta : undefined;
}

export async function createTrackedToolCall(
  ctx: ToolCallAuditContext,
  toolName: string,
  args: Record<string, unknown>,
  requiresConfirmation: boolean,
  options?: {
    executorKind?: "agent" | "deterministic";
    metadataOverrides?: Partial<ToolCallMetadata>;
  }
): Promise<ToolCall> {
  return createToolCall(
    ctx.db,
    ctx.sessionId,
    toolName,
    args,
    requiresConfirmation,
    ctx.turnId,
    {
      executorKind: options?.executorKind,
      metadata: buildToolCallMetadata(ctx, options?.metadataOverrides),
    }
  );
}
