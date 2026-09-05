/**
 * Model-facing surface for the four Traditional Gu read capabilities
 * (R1 SL-1 / TD-5).
 *
 * The gateway itself lives in `apps/web/src/lib/legacy-gateway/` because it
 * reaches external source systems. This module is only the seam: it defines the
 * tool shapes, resolves which Organization a tool call is authorized against,
 * and turns a typed refusal into a structured tool result instead of a thrown
 * turn failure.
 *
 * Two decisions worth stating, because both are authority-adjacent:
 *
 *   * **The Organization is resolved, never supplied by the model.** A model
 *     argument naming an Organization would be a caller-supplied tenant claim,
 *     which the audit (16) and Technical Plan 6 both say must not be trusted.
 *     It is derived from the actor's active memberships, and when that is
 *     ambiguous the call fails closed rather than picking one.
 *   * **A refusal is a result, not an exception.** The model needs to know it
 *     may not read something, and needs to not retry. A structured
 *     `status: "refused"` with a reason does that; a thrown error would just
 *     end the turn.
 */
import { z } from "zod";
import { tool } from "@langchain/core/tools";
import type { DbClient } from "@agents/db";
import type { ToolContext } from "./tool-context";

/**
 * The gateway functions, injected from `apps/web`. Kept structural so this
 * package never imports the web app.
 */
export interface LegacyGatewayDeps {
  readLeadContext(params: {
    db: DbClient;
    organizationId: string;
    actorUserId: string;
    legacyLeadId: string;
  }): Promise<unknown>;
  readRecentMessages(params: {
    db: DbClient;
    organizationId: string;
    actorUserId: string;
    legacyLeadId: string;
    limit?: number;
  }): Promise<unknown>;
  readDealAppointments(params: {
    db: DbClient;
    organizationId: string;
    actorUserId: string;
    legacyDealId: string;
    legacyAppointmentId?: string;
  }): Promise<unknown>;
  readPropertyDetails(params: {
    db: DbClient;
    organizationId: string;
    actorUserId: string;
    legacyPropertyId: string;
  }): Promise<unknown>;
  /**
   * Active Organization memberships for the actor. Supplied by the same wiring
   * so this module needs no query layer of its own.
   */
  listActorOrganizations(params: {
    db: DbClient;
    actorUserId: string;
  }): Promise<string[]>;
  /** Recognizes the gateway's typed refusal without importing its class. */
  describeRefusal(error: unknown): { reason: string; detail?: string } | null;
}

export type LegacyGatewayToolResult =
  | { status: "ok"; result: unknown }
  | { status: "refused"; reason: string; detail?: string }
  | { status: "not_configured"; hint: string }
  | { status: "organization_not_resolved"; reason: string; hint: string }
  | { status: "failed"; error: string };

/**
 * Resolves the single Organization a tool call acts for.
 *
 * Exactly one active membership resolves. Zero and many both fail closed:
 * "many" is genuinely ambiguous, and guessing would pick a tenant on the user's
 * behalf - the failure mode Technical Plan 6 exists to prevent.
 */
export async function resolveToolOrganization(
  deps: LegacyGatewayDeps,
  ctx: { db: DbClient; userId: string }
): Promise<
  | { ok: true; organizationId: string }
  | { ok: false; result: LegacyGatewayToolResult }
> {
  const organizations = await deps.listActorOrganizations({
    db: ctx.db,
    actorUserId: ctx.userId,
  });
  if (organizations.length === 1) {
    return { ok: true, organizationId: organizations[0] };
  }
  return {
    ok: false,
    result: {
      status: "organization_not_resolved",
      reason:
        organizations.length === 0
          ? "the acting user has no active Organization membership"
          : "the acting user belongs to more than one Organization",
      hint:
        organizations.length === 0
          ? "Traditional Gu reads are Organization-scoped. Do not retry; this user cannot read legacy data."
          : "The Organization cannot be inferred and must not be guessed. Do not retry with a different id.",
    },
  };
}

const NOT_CONFIGURED: LegacyGatewayToolResult = {
  status: "not_configured",
  hint: "The legacy read gateway is not wired in this environment. Do not retry.",
};

async function run(
  deps: LegacyGatewayDeps | null,
  ctx: ToolContext,
  call: (organizationId: string) => Promise<unknown>
): Promise<LegacyGatewayToolResult> {
  if (!deps) return NOT_CONFIGURED;
  const organization = await resolveToolOrganization(deps, ctx);
  if (!organization.ok) return organization.result;
  try {
    return { status: "ok", result: await call(organization.organizationId) };
  } catch (error) {
    const refusal = deps.describeRefusal(error);
    if (refusal) {
      return { status: "refused", reason: refusal.reason, detail: refusal.detail };
    }
    return { status: "failed", error: (error as Error).message };
  }
}

/**
 * Builds the four tools. The caller decides availability - these are gated by
 * `LEGACY_GATEWAY_ENABLED` and by the user's own tool settings before this runs.
 */
export function buildLegacyGatewayTools(
  ctx: ToolContext,
  deps: LegacyGatewayDeps | null,
  isAvailable: (toolId: string) => boolean
) {
  const tools = [];

  if (isAvailable("legacy_lead_get_context")) {
    tools.push(
      tool(
        async (input) =>
          JSON.stringify(
            await run(deps, ctx, (organizationId) =>
              deps!.readLeadContext({
                db: ctx.db,
                organizationId,
                actorUserId: ctx.userId,
                legacyLeadId: input.legacy_lead_id,
              })
            )
          ),
        {
          name: "legacy_lead_get_context",
          description:
            "Reads the normalized Traditional Gu lead context for one legacy lead id, with provenance and freshness metadata. Read-only. The lead id is opaque - pass it whole, never parsed. Returns status='refused' with a reason when the lead does not belong to the caller's Organization, when the gateway is disabled, or when the source shape no longer matches its recorded contract; in every refused case, do NOT retry.",
          schema: z.object({ legacy_lead_id: z.string().min(1) }),
        }
      )
    );
  }

  if (isAvailable("legacy_lead_get_recent_messages")) {
    tools.push(
      tool(
        async (input) =>
          JSON.stringify(
            await run(deps, ctx, (organizationId) =>
              deps!.readRecentMessages({
                db: ctx.db,
                organizationId,
                actorUserId: ctx.userId,
                legacyLeadId: input.legacy_lead_id,
                limit: input.limit ?? undefined,
              })
            )
          ),
        {
          name: "legacy_lead_get_recent_messages",
          description:
            "Reads recent conversation items for one legacy lead across ALL threads - the Gu-number thread and each advisor's own-WhatsApp thread - each item carrying its thread, source and delivery status. Read-only. A delivery status of 'unknown' means the source recorded none; it does NOT mean the message was delivered.",
          schema: z.object({
            legacy_lead_id: z.string().min(1),
            limit: z.number().int().min(1).max(200).nullish(),
          }),
        }
      )
    );
  }

  if (isAvailable("appointment_get")) {
    tools.push(
      tool(
        async (input) =>
          JSON.stringify(
            await run(deps, ctx, (organizationId) =>
              deps!.readDealAppointments({
                db: ctx.db,
                organizationId,
                actorUserId: ctx.userId,
                legacyDealId: input.legacy_deal_id,
                legacyAppointmentId: input.legacy_appointment_id ?? undefined,
              })
            )
          ),
        {
          name: "appointment_get",
          description:
            "Reads a legacy deal's appointments from BOTH legacy stores and reports what each one holds. Appointment persistence is not atomic across those stores, so the result says which stores answered and retains any disagreement instead of picking a winner - report the conflict rather than resolving it. Read-only.",
          schema: z.object({
            legacy_deal_id: z.string().min(1),
            legacy_appointment_id: z.string().min(1).nullish(),
          }),
        }
      )
    );
  }

  if (isAvailable("property_get_details")) {
    tools.push(
      tool(
        async (input) =>
          JSON.stringify(
            await run(deps, ctx, (organizationId) =>
              deps!.readPropertyDetails({
                db: ctx.db,
                organizationId,
                actorUserId: ctx.userId,
                legacyPropertyId: input.legacy_property_id,
              })
            )
          ),
        {
          name: "property_get_details",
          description:
            "Reads authoritative Traditional Gu property details for one legacy property id, with provenance. Read-only, and always from the authoritative property record rather than the search mirror.",
          schema: z.object({ legacy_property_id: z.string().min(1) }),
        }
      )
    );
  }

  return tools;
}

/** The ids this module owns. Used by availability gating and by tests. */
export const LEGACY_GATEWAY_TOOL_IDS = [
  "legacy_lead_get_context",
  "legacy_lead_get_recent_messages",
  "appointment_get",
  "property_get_details",
] as const;
