import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { TOOL_CATALOG } from "./catalog";
import type { ToolContext } from "./tool-context";
import { createToolCall, updateToolCallStatus } from "@agents/db";
import {
  googleCalendarJson,
  calendarEventsPath,
  buildEventResource,
} from "./calendar-api";
import {
  resolveCalendarListWindow,
  calendarListEventsNeedsPeriod,
} from "./calendar-list-window";
import { eventDisplayFields } from "./calendar-event-display";

function calendarToolEnabled(toolId: string, ctx: ToolContext): boolean {
  if (
    ctx.channel === "heartbeat" &&
    toolId !== "calendar_list_calendars" &&
    toolId !== "calendar_list_events"
  ) {
    return false;
  }
  const setting = ctx.enabledTools.find((t) => t.tool_id === toolId);
  if (!setting?.enabled) return false;
  const def = TOOL_CATALOG.find((t) => t.id === toolId);
  if (def?.requires_integration !== "google_calendar") return false;
  return ctx.integrations.some(
    (i) => i.provider === "google_calendar" && i.status === "active"
  );
}

function tz(ctx: ToolContext): string {
  return ctx.userTimezone ?? "UTC";
}

const nullableOptional = <T extends z.ZodTypeAny>(schema: T) =>
  schema.nullish().transform((value) => value ?? undefined);

const nullableBooleanDefault = (defaultValue: boolean) =>
  z.preprocess(
    (value) => (value === null || value === "" ? undefined : value),
    z.boolean().default(defaultValue)
  );

const calendarIdSchema = z
  .preprocess(
    (value) => (value === null || value === "" ? undefined : value),
    z.string().default("primary")
  )
  .describe("Calendar id, usually primary");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function addCalendarTools(ctx: ToolContext, tools: any[]): void {
  const token = ctx.googleCalendarAccessToken;
  if (!token) {
    const hasCalendarIntegration = ctx.integrations.some(
      (i) => i.provider === "google_calendar" && i.status === "active"
    );
    if (hasCalendarIntegration) {
      console.warn(
        "[agent] Google Calendar está activo en user_integrations pero no hay access token usable (revisa ENCRYPTION_KEY, expiración del token o reconecta en Ajustes). Las herramientas calendar_* no se registrarán."
      );
    }
    return;
  }

  if (calendarToolEnabled("calendar_list_calendars", ctx)) {
    tools.push(
      tool(
        async () => {
          const record = await createToolCall(
            ctx.db,
            ctx.sessionId,
            "calendar_list_calendars",
            {},
            false,
            ctx.turnId
          );
          const { status, data } = await googleCalendarJson(
            token,
            "/users/me/calendarList"
          );
          if (status >= 400) {
            const err = { error: "Calendar API error", status, details: data };
            await updateToolCallStatus(ctx.db, record.id, "failed", err);
            return JSON.stringify(err);
          }
          const items = (data as { items?: unknown[] }).items ?? [];
          const calendars = (
            items as Array<Record<string, unknown>>
          ).map((c) => ({
            id: c.id,
            summary: c.summary,
            primary: c.primary,
            timeZone: c.timeZone,
          }));
          const result = { calendars };
          await updateToolCallStatus(
            ctx.db,
            record.id,
            "executed",
            result as unknown as Record<string, unknown>
          );
          return JSON.stringify(result);
        },
        {
          name: "calendar_list_calendars",
          description: "Lists the user's Google calendars (connected account).",
          schema: z.object({}),
        }
      )
    );
  }

  if (calendarToolEnabled("calendar_list_events", ctx)) {
    tools.push(
      tool(
        async (input: {
          calendar_id: string;
          time_min?: string;
          time_max?: string;
          historical?: boolean;
        }) => {
          const record = await createToolCall(
            ctx.db,
            ctx.sessionId,
            "calendar_list_events",
            input,
            false,
            ctx.turnId
          );
          const profileTz = tz(ctx);

          if (calendarListEventsNeedsPeriod(input.time_min, input.time_max)) {
            const result = {
              needs_period: true,
              profile_timezone: profileTz,
              assistant_hint:
                "El usuario no definió un período. Pregunta de forma breve qué intervalo quiere: por ejemplo hoy, mañana, esta semana, la próxima semana, el mes en curso, o fechas concretas (desde/hasta). Usa get_user_preferences.timezone para convertir a ISO 8601 time_min y time_max. Luego vuelve a llamar calendar_list_events con ambos campos.",
            };
            await updateToolCallStatus(
              ctx.db,
              record.id,
              "executed",
              result as unknown as Record<string, unknown>
            );
            return JSON.stringify(result);
          }

          const now = new Date();
          const window = resolveCalendarListWindow(
            {
              time_min: input.time_min!.trim(),
              time_max: input.time_max!.trim(),
              historical: input.historical,
            },
            now
          );
          const { timeMin, timeMax } = window;
          const q = `?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&singleEvents=true&orderBy=startTime&maxResults=100`;
          const { status, data } = await googleCalendarJson(
            token,
            calendarEventsPath(input.calendar_id, q)
          );
          if (status >= 400) {
            const err = { error: "Calendar API error", status, details: data };
            await updateToolCallStatus(ctx.db, record.id, "failed", err);
            return JSON.stringify(err);
          }
          const items = (data as { items?: unknown[] }).items ?? [];
          const events = (
            items as Array<Record<string, unknown>>
          ).map((e) => {
            const disp = eventDisplayFields(e, profileTz);
            return {
              id: e.id,
              summary: e.summary,
              start: e.start,
              end: e.end,
              start_display: disp.start_display,
              end_display: disp.end_display,
              htmlLink: e.htmlLink,
              status: e.status,
            };
          });

          const result: Record<string, unknown> = {
            events,
            applied_window: {
              time_min: timeMin,
              time_max: timeMax,
              profile_timezone: profileTz,
            },
            display_hint:
              "Muestra al usuario start_display y end_display (hora local según profile_timezone). No etiquetes como UTC salvo que el usuario lo pida.",
          };
          if (window.coerced) {
            result.range_coerced = true;
            result.coercion_reason = window.coercion_reason;
            result.assistant_hint =
              "El rango era inválido o terminaba en el pasado sin historical=true; se consultaron los próximos 7 días desde ahora. Explícalo y lista solo estos eventos con start_display/end_display.";
          }
          await updateToolCallStatus(
            ctx.db,
            record.id,
            "executed",
            result as unknown as Record<string, unknown>
          );
          return JSON.stringify(result);
        },
        {
          name: "calendar_list_events",
          description:
            "Lists events in a date range. You MUST pass BOTH time_min and time_max (ISO 8601) after the user chose a period (or you derived it: today, this week, etc.) using their profile timezone. If the user was vague and gave no period, OMIT both — the tool returns needs_period and you must ask them. historical=true only for explicit past/history requests; otherwise past-only ranges are coerced to the next 7 days. Use start_display/end_display in the response JSON for local times.",
          schema: z.object({
            calendar_id: calendarIdSchema,
            time_min: nullableOptional(z.string()).describe(
              "ISO 8601 inclusive start. Required together with time_max to query; omit BOTH if you need to ask the user for a period."
            ),
            time_max: nullableOptional(z.string()).describe(
              "ISO 8601 exclusive or end bound. Required together with time_min; omit BOTH to receive needs_period."
            ),
            historical: nullableBooleanDefault(false)
              .describe(
                "True only if the user clearly asked for old/past calendar history. Default false."
              ),
          }),
        }
      )
    );
  }

  if (calendarToolEnabled("calendar_create_event", ctx)) {
    tools.push(
      tool(
        async (input: {
          calendar_id: string;
          summary: string;
          start_datetime: string;
          end_datetime: string;
          description?: string;
        }) => {
          const calId = input.calendar_id || "primary";
          const body = buildEventResource({
            summary: input.summary,
            start_datetime: input.start_datetime,
            end_datetime: input.end_datetime,
            timezone: tz(ctx),
            description: input.description,
          });
          console.log("[calendar_create_event] calendar_id:", calId, "| body:", JSON.stringify(body));
          const { status, data } = await googleCalendarJson(
            token,
            `/calendars/${calId === "primary" ? "primary" : encodeURIComponent(calId)}/events`,
            { method: "POST", body: JSON.stringify(body) }
          );
          console.log("[calendar_create_event] API response:", status, JSON.stringify(data));
          if (status >= 400) {
            return JSON.stringify({
              error: "Calendar API error",
              status,
              details: data,
            });
          }
          const created = data as Record<string, unknown>;
          const result = {
            message: "Event created",
            htmlLink: created.htmlLink,
            id: created.id,
          };
          return JSON.stringify(result);
        },
        {
          name: "calendar_create_event",
          description:
            "Creates a calendar event in Google Calendar. Requires user confirmation.",
          schema: z.object({
            calendar_id: calendarIdSchema,
            summary: z.string(),
            start_datetime: z.string(),
            end_datetime: z.string(),
            description: z
              .preprocess(
                (value) => (value === null ? undefined : value),
                z.string().default("")
              ),
          }),
        }
      )
    );
  }

  if (calendarToolEnabled("calendar_update_event", ctx)) {
    tools.push(
      tool(
        async (input: {
          calendar_id: string;
          event_id: string;
          summary?: string;
          start_datetime?: string;
          end_datetime?: string;
          description?: string;
        }) => {
          const patch: Record<string, unknown> = {};
          if (input.summary !== undefined) patch.summary = input.summary;
          if (input.description !== undefined) patch.description = input.description;
          if (input.start_datetime && input.end_datetime) {
            patch.start = {
              dateTime: input.start_datetime,
              timeZone: tz(ctx),
            };
            patch.end = {
              dateTime: input.end_datetime,
              timeZone: tz(ctx),
            };
          }
          const { status, data } = await googleCalendarJson(
            token,
            `/calendars/${input.calendar_id === "primary" ? "primary" : encodeURIComponent(input.calendar_id)}/events/${encodeURIComponent(input.event_id)}`,
            { method: "PATCH", body: JSON.stringify(patch) }
          );
          if (status >= 400) {
            return JSON.stringify({
              error: "Calendar API error",
              status,
              details: data,
            });
          }
          const updated = data as Record<string, unknown>;
          const result = {
            message: "Event updated",
            htmlLink: updated.htmlLink,
            id: updated.id,
          };
          return JSON.stringify(result);
        },
        {
          name: "calendar_update_event",
          description: "Updates an existing Google Calendar event. Requires confirmation.",
          schema: z.object({
            calendar_id: calendarIdSchema,
            event_id: z.string(),
            summary: nullableOptional(z.string()),
            start_datetime: nullableOptional(z.string()),
            end_datetime: nullableOptional(z.string()),
            description: nullableOptional(z.string()),
          }),
        }
      )
    );
  }

  if (calendarToolEnabled("calendar_delete_event", ctx)) {
    tools.push(
      tool(
        async (input: { calendar_id: string; event_id: string }) => {
          const { status, data } = await googleCalendarJson(
            token,
            `/calendars/${input.calendar_id === "primary" ? "primary" : encodeURIComponent(input.calendar_id)}/events/${encodeURIComponent(input.event_id)}`,
            { method: "DELETE" }
          );
          if (status >= 400 && status !== 204) {
            return JSON.stringify({
              error: "Calendar API error",
              status,
              details: data,
            });
          }
          const result = { message: "Event deleted" };
          return JSON.stringify(result);
        },
        {
          name: "calendar_delete_event",
          description: "Deletes a Google Calendar event. Requires confirmation.",
          schema: z.object({
            calendar_id: calendarIdSchema,
            event_id: z.string(),
          }),
        }
      )
    );
  }
}
