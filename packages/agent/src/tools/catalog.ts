/**
 * Tool **definitions** only (id, descriptions, risk, integration requirements).
 * Runtime behavior and LangChain Zod schemas live in `adapters.ts` and domain modules
 * (e.g. `calendar-adapters.ts`). See `docs/architecture.md` — Herramientas.
 */
import type { ToolDefinition, ToolRisk } from "@agents/types";

export const TOOL_CATALOG: ToolDefinition[] = [
  {
    id: "get_user_preferences",
    name: "get_user_preferences",
    description: "Returns the current user preferences and agent configuration.",
    risk: "low",
    parameters_schema: { type: "object", properties: {}, required: [] },
  },
  {
    id: "list_enabled_tools",
    name: "list_enabled_tools",
    description: "Lists all tools the user has currently enabled.",
    risk: "low",
    parameters_schema: { type: "object", properties: {}, required: [] },
  },
  {
    id: "github_list_repos",
    name: "github_list_repos",
    description: "Lists the user's GitHub repositories.",
    risk: "low",
    requires_integration: "github",
    parameters_schema: {
      type: "object",
      properties: {
        per_page: { type: "number", description: "Results per page (max 30)" },
      },
      required: [],
    },
  },
  {
    id: "github_list_issues",
    name: "github_list_issues",
    description: "Lists issues for a given repository.",
    risk: "low",
    requires_integration: "github",
    parameters_schema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        state: { type: "string", enum: ["open", "closed", "all"] },
      },
      required: ["owner", "repo"],
    },
  },
  {
    id: "github_create_repo",
    name: "github_create_repo",
    description:
      "Creates a NEW empty GitHub repository under the authenticated user's account. Only call when the user provided an explicit repository name (slug). If they asked to create a repo without naming it, do not call this tool — ask them for the name in natural language first. Pass only the repository name (e.g. my-app), not owner/repo.",
    risk: "high",
    requires_integration: "github",
    parameters_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Repository name (short slug only)" },
        description: { type: "string", description: "Repository description" },
        private: { type: "boolean", description: "Whether the repo is private" },
      },
      required: ["name"],
    },
  },
  {
    id: "github_create_issue",
    name: "github_create_issue",
    description:
      "Creates a new issue (ticket) inside an EXISTING GitHub repository only. The repository must already exist on GitHub. Do NOT use this when the user wants to create a brand-new repository — use github_create_repo instead.",
    risk: "medium",
    requires_integration: "github",
    parameters_schema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repo owner login (user or org)" },
        repo: { type: "string", description: "Existing repository name only" },
        title: { type: "string" },
        body: { type: "string" },
      },
      required: ["owner", "repo", "title"],
    },
  },
  {
    id: "calendar_list_calendars",
    name: "calendar_list_calendars",
    description: "Lists calendars in the connected Google Calendar account.",
    risk: "low",
    requires_integration: "google_calendar",
    parameters_schema: { type: "object", properties: {}, required: [] },
  },
  {
    id: "calendar_list_events",
    name: "calendar_list_events",
    description:
      "Lists events; requires BOTH time_min and time_max (ISO). Omit both if the user did not specify a period — tool returns needs_period. Output includes start_display/end_display in profile local time. historical=true for explicit past ranges.",
    risk: "low",
    requires_integration: "google_calendar",
    parameters_schema: {
      type: "object",
      properties: {
        calendar_id: { type: "string", description: "Calendar id or primary" },
        time_min: { type: "string" },
        time_max: { type: "string" },
        historical: {
          type: "boolean",
          description:
            "True only if the user explicitly asked for past/historical events.",
        },
      },
      required: [],
    },
  },
  {
    id: "calendar_create_event",
    name: "calendar_create_event",
    description:
      "Creates an event on Google Calendar. Always requires user confirmation before execution.",
    risk: "high",
    requires_integration: "google_calendar",
    parameters_schema: {
      type: "object",
      properties: {
        calendar_id: { type: "string" },
        summary: { type: "string" },
        start_datetime: { type: "string" },
        end_datetime: { type: "string" },
        description: { type: "string" },
      },
      required: ["summary", "start_datetime", "end_datetime"],
    },
  },
  {
    id: "calendar_update_event",
    name: "calendar_update_event",
    description:
      "Updates an existing Google Calendar event. Requires confirmation.",
    risk: "medium",
    requires_integration: "google_calendar",
    parameters_schema: {
      type: "object",
      properties: {
        calendar_id: { type: "string" },
        event_id: { type: "string" },
        summary: { type: "string" },
        start_datetime: { type: "string" },
        end_datetime: { type: "string" },
        description: { type: "string" },
      },
      required: ["event_id"],
    },
  },
  {
    id: "calendar_delete_event",
    name: "calendar_delete_event",
    description: "Deletes a Google Calendar event. Requires confirmation.",
    risk: "high",
    requires_integration: "google_calendar",
    parameters_schema: {
      type: "object",
      properties: {
        calendar_id: { type: "string" },
        event_id: { type: "string" },
      },
      required: ["event_id"],
    },
  },
];

export function getToolRisk(toolId: string): ToolRisk {
  return TOOL_CATALOG.find((t) => t.id === toolId)?.risk ?? "high";
}

export function toolRequiresConfirmation(toolId: string): boolean {
  const risk = getToolRisk(toolId);
  return risk === "medium" || risk === "high";
}
