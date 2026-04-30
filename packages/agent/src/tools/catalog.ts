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
    description:
      "Lists ONLY the GitHub repositories owned by the authenticated user. Do NOT use when the user is only asking you to change answer format (e.g. bullets, clarity, style, length) without requesting repository data. Does NOT search GitHub for arbitrary projects, brands, companies or topics. Use ONLY when the user explicitly asks to see or list THEIR own repos on GitHub.",
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
  {
    id: "read_file",
    name: "read_file",
    description:
      "Reads a text file from the server's configured workspace (FILE_TOOLS_ROOT). Path MUST be RELATIVE to the workspace root (never absolute), e.g. docs/plan.md or .cursor/rules/foo.md — NOT a human document title alone (e.g. a long name in quotes is not a path unless it matches a real relative path). Supports optional 1-based offset and limit to read a slice. If the user only gave a title, ask for the relative path or find the file via bash then read_file. Fails if the file is missing, too large, or escapes the workspace.",
    risk: "low",
    parameters_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Path relative to FILE_TOOLS_ROOT, e.g. 'notes/todo.md'. Absolute paths are rejected.",
        },
        offset: {
          type: "number",
          description: "1-based start line (optional).",
        },
        limit: {
          type: "number",
          description: "Max number of lines to return (optional).",
        },
      },
      required: ["path"],
    },
  },
  {
    id: "write_file",
    name: "write_file",
    description:
      "Creates a new text file or OVERWRITES an existing one in the server's workspace (FILE_TOOLS_ROOT). Path must be RELATIVE. Requires human confirmation because it replaces whatever content was there. Use edit_file for partial changes.",
    risk: "medium",
    parameters_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Target path relative to FILE_TOOLS_ROOT.",
        },
        content: {
          type: "string",
          description: "Full UTF-8 content to write (entire new file body).",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    id: "edit_file",
    name: "edit_file",
    description:
      "Replaces a SINGLE occurrence of old_string with new_string in an existing file inside the workspace (FILE_TOOLS_ROOT). The old_string must match exactly ONCE (include enough context to be unique). Fails if not found or if it matches multiple times. Requires confirmation.",
    risk: "high",
    parameters_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path relative to FILE_TOOLS_ROOT.",
        },
        old_string: {
          type: "string",
          description:
            "Exact literal fragment to replace (must appear exactly once).",
        },
        new_string: {
          type: "string",
          description: "Replacement text (may be empty to delete).",
        },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    id: "schedule_task",
    name: "schedule_task",
    description:
      "Programs a task for the agent to execute automatically at a future time (one_time) or on a recurring schedule (recurring). The agent will run the given prompt at the scheduled time and send the result to Telegram by default. Requires human confirmation before scheduling.",
    risk: "medium",
    parameters_schema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "The exact instruction the agent should execute at the scheduled time. Write it as if you were sending it to the agent right now (e.g. 'List my open GitHub issues and summarize them').",
        },
        schedule_type: {
          type: "string",
          enum: ["one_time", "recurring"],
          description: "Whether the task runs once or repeats.",
        },
        run_at: {
          type: "string",
          description:
            "ISO 8601 datetime with timezone offset for one_time tasks (e.g. '2026-04-25T09:00:00-06:00'). Required when schedule_type is one_time.",
        },
        cron_expr: {
          type: "string",
          description:
            "Standard 5-field cron expression for recurring tasks (e.g. '0 9 * * 1' = every Monday at 9 AM). Required when schedule_type is recurring.",
        },
        timezone: {
          type: "string",
          description:
            "IANA timezone name (e.g. 'America/Mexico_City'). Defaults to the user's profile timezone.",
        },
      },
      required: ["prompt", "schedule_type"],
    },
  },
  {
    id: "manage_scheduled_tasks",
    name: "manage_scheduled_tasks",
    description:
      "Lists the user's own scheduled tasks (action=list) or pauses/resumes one by id (action=pause|resume). Scoped to the authenticated user. Reversible state changes (pause and resume just flip the status), so it runs without a separate HITL confirmation card; the agent must still disambiguate in natural language before applying pause/resume. This tool does NOT delete tasks.",
    risk: "low",
    parameters_schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "pause", "resume"],
          description:
            "list = show tasks; pause = active→paused; resume = paused→active.",
        },
        task_id: {
          type: "string",
          description:
            "UUID of the task to pause/resume. Required for pause/resume, ignored for list.",
        },
      },
      required: ["action"],
    },
  },
  {
    id: "read_skill_reference",
    name: "read_skill_reference",
    description:
      "Reads one reference file (.md) from the currently-active skill's `references/` directory and returns its content. Used for progressive disclosure: the SKILL.md body stays small and references are loaded on demand. Pass only the filename stem (no extension). Risk low (read-only, scoped to the skill's references directory).",
    risk: "low",
    parameters_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "Filename stem (no extension). Lowercase letters, digits, hyphens. E.g. 'schema', 'joins', 'fewshots-leads'.",
        },
      },
      required: ["name"],
    },
  },
  {
    id: "bigquery_run_query",
    name: "bigquery_run_query",
    description:
      "Executes a single READ-ONLY SQL query (SELECT or WITH...SELECT) against Google BigQuery and returns up to max_results rows. The validator rejects any DDL/DML, multiple statements, or scripting blocks. Supports named parameters via `params` (e.g. `WHERE u.organization_id = @organization_id` plus `params: { organization_id: '...' }`); ALWAYS prefer parameters over inlining values. Use this tool when the user asks for counts, KPIs, trends, or any business metric in the warehouse. Returns a tagged result; if the deployment has not configured BigQuery yet, returns status='not_configured' with instructions instead of executing.",
    risk: "low",
    parameters_schema: {
      type: "object",
      properties: {
        sql: {
          type: "string",
          description:
            "Standard BigQuery SQL. Must be a single SELECT or `WITH ... SELECT` statement. Use `@name` placeholders for any value derived from user input or business context, and pass the actual values via `params`.",
        },
        project_id: {
          type: "string",
          description:
            "Optional GCP project id override. Defaults to BIGQUERY_PROJECT_ID env.",
        },
        location: {
          type: "string",
          description:
            "Optional BigQuery location (e.g. 'US', 'EU'). Defaults to BIGQUERY_LOCATION env.",
        },
        max_results: {
          type: "number",
          description:
            "Maximum rows to return (default 100, hard cap 1000). Use to keep results compact for the assistant.",
        },
        params: {
          type: "object",
          description:
            "Named query parameters. Keys are parameter names (without '@'); values are string|number|boolean. Map to BigQuery types as: string→STRING, integer→INT64, float→FLOAT64, boolean→BOOL.",
        },
      },
      required: ["sql"],
    },
  },
  {
    id: "bash",
    name: "bash",
    description:
      "Runs a one-shot shell command on the server host via bash -lc. Dangerous: only use when the user explicitly asked to run a command and the deployment allows it. Requires human confirmation. The terminal field is a logical label for logs only, not a persistent PTY session.",
    risk: "high",
    parameters_schema: {
      type: "object",
      properties: {
        terminal: {
          type: "string",
          description:
            "Logical label for correlation and logs (e.g. default). Not a real persistent terminal session.",
        },
        prompt: {
          type: "string",
          description: "Shell command string passed to bash -lc",
        },
      },
      required: ["prompt"],
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
