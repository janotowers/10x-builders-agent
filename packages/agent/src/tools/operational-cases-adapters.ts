/**
 * LangChain adapters para las tools del subsistema de casos operacionales:
 *   - operational_case_update_state
 *   - operational_case_add_event
 *   - notify_user
 *
 * Estas tools sólo son visibles cuando hay un caso activo (canal
 * `case_runner` o cuando el agente lo invoca desde un turno web/Telegram
 * con `case_id` en contexto). El agente las usa para mover el estado del
 * caso y avisar al humano interno.
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import {
  createToolCall,
  updateToolCallStatus,
  createOperationalCase,
  getOperationalCase,
  getOperationalCaseTypeForUser,
  insertOperationalCaseEvent,
  updateOperationalCase,
} from "@agents/db";
import type {
  OperationalCaseExternalContact,
  OperationalCaseIntakeField,
} from "@agents/types";
import type { ToolContext } from "./tool-context";

const STATUS_VALUES = [
  "active",
  "waiting_external",
  "paused",
  "completed",
  "failed",
] as const;

const ACTOR_VALUES = ["system", "agent", "user", "external"] as const;
const EVENT_TYPE_VALUES = [
  "step_completed",
  "reminder_sent",
  "escalated",
  "human_decision",
  "external_response",
  "error",
] as const;

export type NotifyUserFn = (
  db: ToolContext["db"],
  userId: string,
  payload: { text: string; kind?: string; data?: Record<string, unknown> },
  urgency?: "low" | "normal" | "high"
) => Promise<{
  delivered: Array<{ channel: string; ok: boolean; reason?: string }>;
  attempted: Array<{ channel: string; ok: boolean; reason?: string }>;
}>;

interface NotifyDeps {
  notifyUser: NotifyUserFn;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function addOperationalCaseTools(
  ctx: ToolContext,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: any[],
  deps: NotifyDeps
): void {
  if (toolEnabled("operational_case_create", ctx)) {
    tools.push(
      tool(
        async (input: {
          case_type: string;
          context: Record<string, unknown>;
          external_contact?: Record<string, unknown>;
          next_action_at?: string;
          due_at?: string;
        }) => {
          const record = await createToolCall(
            ctx.db,
            ctx.sessionId,
            "operational_case_create",
            input as unknown as Record<string, unknown>,
            true,
            ctx.turnId
          );

          const caseType = await getOperationalCaseTypeForUser(
            ctx.db,
            ctx.userId,
            input.case_type
          );
          if (!caseType) {
            const out = {
              ok: false,
              error: "case_type_not_found_or_forbidden",
              hint: "The case_type slug is not visible to this user. Check the operational_case_types catalog.",
            };
            await updateToolCallStatus(ctx.db, record.id, "failed", out);
            return JSON.stringify(out);
          }
          if (caseType.status === "archived") {
            const out = {
              ok: false,
              error: "case_type_archived",
              hint: "This case_type is archived; ask the user to pick another or unarchive it from settings.",
            };
            await updateToolCallStatus(ctx.db, record.id, "failed", out);
            return JSON.stringify(out);
          }

          const intakeSchema = (caseType.intake_schema_jsonb ?? []) as
            | OperationalCaseIntakeField[]
            | undefined;
          const requiredFields =
            intakeSchema?.filter((field) => field?.required) ?? [];
          const missing = requiredFields
            .filter((field) => {
              const value = input.context?.[field.name];
              return (
                value === undefined ||
                value === null ||
                (typeof value === "string" && value.trim() === "")
              );
            })
            .map((field) => ({ name: field.name, label: field.label }));
          if (missing.length > 0) {
            const out = {
              ok: false,
              error: "missing_required_intake_fields",
              missing,
              hint: "Ask the user for these fields conversationally before retrying. Field names match keys expected in `context`.",
            };
            await updateToolCallStatus(ctx.db, record.id, "failed", out);
            return JSON.stringify(out);
          }

          const externalContact = (input.external_contact ?? undefined) as
            | OperationalCaseExternalContact
            | undefined;

          const created = await createOperationalCase(ctx.db, {
            userId: ctx.userId,
            caseTypeId: caseType.id,
            caseType: caseType.case_type,
            status: "active",
            currentStep: "intake",
            externalContact,
            nextActionAt: input.next_action_at ?? new Date().toISOString(),
            dueAt: input.due_at ?? null,
            context: input.context ?? {},
          });

          await insertOperationalCaseEvent(ctx.db, {
            caseId: created.id,
            eventType: "step_completed",
            actor: "agent",
            payload: {
              kind: "case_created",
              source: "agent_conversation",
              case_type: created.case_type,
              current_step: created.current_step,
            },
          });

          const out = {
            ok: true,
            case_id: created.id,
            case_type: created.case_type,
            version: created.version,
            status: created.status,
            current_step: created.current_step,
            next_action_at: created.next_action_at,
            hint: "Case created at current_step='intake'. Inform the inmobiliario via notify_user; do NOT message the external contact yet — that is the responsibility of the next operational step.",
          };
          await updateToolCallStatus(ctx.db, record.id, "executed", out);
          return JSON.stringify(out);
        },
        {
          name: "operational_case_create",
          description:
            "Creates a new operational case for the calling user from a known case_type. Validates required fields against intake_schema_jsonb. Starts at current_step='intake'.",
          schema: z.object({
            case_type: z.string().min(1),
            context: z.record(z.string(), z.any()),
            external_contact: z.record(z.string(), z.any()).optional(),
            next_action_at: z.string().optional(),
            due_at: z.string().optional(),
          }),
        }
      )
    );
  }

  if (toolEnabled("operational_case_update_state", ctx)) {
    tools.push(
      tool(
        async (input: {
          case_id: string;
          expected_version: number;
          status?: (typeof STATUS_VALUES)[number];
          current_step?: string;
          next_action_at?: string;
          due_at?: string;
          context_patch?: Record<string, unknown>;
          external_contact?: Record<string, unknown>;
          note?: string;
        }) => {
          const record = await createToolCall(
            ctx.db,
            ctx.sessionId,
            "operational_case_update_state",
            input as unknown as Record<string, unknown>,
            true,
            ctx.turnId
          );

          const opCase = await getOperationalCase(ctx.db, input.case_id);
          if (!opCase) {
            const out = { ok: false, error: "case_not_found" };
            await updateToolCallStatus(ctx.db, record.id, "failed", out);
            return JSON.stringify(out);
          }
          if (opCase.user_id !== ctx.userId) {
            const out = { ok: false, error: "case_belongs_to_another_user" };
            await updateToolCallStatus(ctx.db, record.id, "failed", out);
            return JSON.stringify(out);
          }
          if (opCase.version !== input.expected_version) {
            const out = {
              ok: false,
              error: "version_mismatch",
              actual_version: opCase.version,
              expected_version: input.expected_version,
              hint: "Re-read the case and retry with the new version.",
            };
            await updateToolCallStatus(ctx.db, record.id, "failed", out);
            return JSON.stringify(out);
          }

          const mergedContext =
            input.context_patch && Object.keys(input.context_patch).length > 0
              ? { ...opCase.context_jsonb, ...input.context_patch }
              : undefined;

          const updated = await updateOperationalCase(
            ctx.db,
            opCase.id,
            opCase.version,
            {
              status: input.status,
              currentStep: input.current_step,
              nextActionAt: input.next_action_at,
              dueAt: input.due_at,
              context: mergedContext,
              externalContact: input.external_contact as
                | import("@agents/types").OperationalCaseExternalContact
                | undefined,
            }
          );
          if (!updated) {
            const out = {
              ok: false,
              error: "concurrent_update",
              hint: "Another worker updated the case between read and write. Re-read and retry.",
            };
            await updateToolCallStatus(ctx.db, record.id, "failed", out);
            return JSON.stringify(out);
          }

          await insertOperationalCaseEvent(ctx.db, {
            caseId: opCase.id,
            eventType: "state_changed",
            actor: "agent",
            payload: {
              from: {
                status: opCase.status,
                current_step: opCase.current_step,
                version: opCase.version,
              },
              to: {
                status: updated.status,
                current_step: updated.current_step,
                version: updated.version,
              },
              ...(input.note ? { reason: input.note } : {}),
            },
          });

          const out = {
            ok: true,
            case_id: updated.id,
            version: updated.version,
            status: updated.status,
            current_step: updated.current_step,
          };
          await updateToolCallStatus(ctx.db, record.id, "executed", out);
          return JSON.stringify(out);
        },
        {
          name: "operational_case_update_state",
          description:
            "Updates the active operational case (status/current_step/next_action_at/...). Optimistic-locked by version.",
          schema: z.object({
            case_id: z.string().min(1),
            expected_version: z.number().int().nonnegative(),
            status: z.enum(STATUS_VALUES).optional(),
            current_step: z.string().min(1).optional(),
            next_action_at: z.string().optional(),
            due_at: z.string().optional(),
            context_patch: z.record(z.string(), z.any()).optional(),
            external_contact: z.record(z.string(), z.any()).optional(),
            note: z.string().optional(),
          }),
        }
      )
    );
  }

  if (toolEnabled("operational_case_add_event", ctx)) {
    tools.push(
      tool(
        async (input: {
          case_id: string;
          event_type: (typeof EVENT_TYPE_VALUES)[number];
          actor: (typeof ACTOR_VALUES)[number];
          payload?: Record<string, unknown>;
        }) => {
          const record = await createToolCall(
            ctx.db,
            ctx.sessionId,
            "operational_case_add_event",
            input as unknown as Record<string, unknown>,
            false,
            ctx.turnId
          );
          const opCase = await getOperationalCase(ctx.db, input.case_id);
          if (!opCase || opCase.user_id !== ctx.userId) {
            const out = { ok: false, error: "case_not_found_or_forbidden" };
            await updateToolCallStatus(ctx.db, record.id, "failed", out);
            return JSON.stringify(out);
          }
          const ev = await insertOperationalCaseEvent(ctx.db, {
            caseId: opCase.id,
            eventType: input.event_type,
            actor: input.actor,
            payload: input.payload ?? {},
          });
          const out = { ok: true, event_id: ev.id };
          await updateToolCallStatus(ctx.db, record.id, "executed", out);
          return JSON.stringify(out);
        },
        {
          name: "operational_case_add_event",
          description: "Appends an event to the active operational case timeline.",
          schema: z.object({
            case_id: z.string().min(1),
            event_type: z.enum(EVENT_TYPE_VALUES),
            actor: z.enum(ACTOR_VALUES),
            payload: z.record(z.string(), z.any()).optional(),
          }),
        }
      )
    );
  }

  if (toolEnabled("notify_user", ctx)) {
    tools.push(
      tool(
        async (input: {
          text: string;
          kind?: string;
          urgency?: "low" | "normal" | "high";
          case_id?: string;
        }) => {
          const record = await createToolCall(
            ctx.db,
            ctx.sessionId,
            "notify_user",
            input as unknown as Record<string, unknown>,
            false,
            ctx.turnId
          );
          try {
            const result = await deps.notifyUser(
              ctx.db,
              ctx.userId,
              {
                text: input.text,
                kind: input.kind,
                data: input.case_id ? { case_id: input.case_id } : undefined,
              },
              input.urgency ?? "normal"
            );
            const out = {
              ok: result.delivered.length > 0,
              attempted: result.attempted,
              delivered: result.delivered,
            };
            await updateToolCallStatus(ctx.db, record.id, "executed", out);
            return JSON.stringify(out);
          } catch (e) {
            const out = {
              ok: false,
              error: (e as Error).message ?? String(e),
            };
            await updateToolCallStatus(ctx.db, record.id, "failed", out);
            return JSON.stringify(out);
          }
        },
        {
          name: "notify_user",
          description:
            "Notifies the inmobiliario via their preferred channel (web/telegram).",
          schema: z.object({
            text: z.string().min(1),
            kind: z.string().min(1).optional(),
            urgency: z.enum(["low", "normal", "high"]).optional(),
            case_id: z.string().min(1).optional(),
          }),
        }
      )
    );
  }
}

function toolEnabled(toolId: string, ctx: ToolContext): boolean {
  if (
    ctx.activeSkillAllowedTools &&
    ctx.activeSkillAllowedTools.length > 0 &&
    !ctx.activeSkillAllowedTools.includes(toolId)
  ) {
    return false;
  }
  // user_tool_settings opt-in/out: si NO está en la lista, default ON.
  const setting = ctx.enabledTools.find((t) => t.tool_id === toolId);
  if (setting && setting.enabled === false) return false;
  return true;
}
