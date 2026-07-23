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
    id: "calendar_list_tasks",
    name: "calendar_list_tasks",
    description:
      "Lists Google Tasks that can appear in Google Calendar; read-only. This is distinct from internal scheduled_tasks.",
    risk: "low",
    requires_integration: "google_calendar",
    parameters_schema: {
      type: "object",
      properties: {
        due_min: { type: "string", description: "ISO 8601 inclusive lower bound for task due date/time." },
        due_max: { type: "string", description: "ISO 8601 exclusive upper bound for task due date/time." },
        tasklist_id: { type: "string", description: "Optional Google Tasks tasklist id; defaults to all tasklists." },
        show_completed: { type: "boolean", description: "Whether to include completed tasks. Default false." },
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
    id: "list_user_memories",
    name: "list_user_memories",
    description:
      "Lists the user's own long-term memories saved by the agent (semantic / episodic / procedural). Always scoped to the authenticated user. Read-only; safe to call without confirmation. Use when the user asks 'what do you remember about me', 'show me my memories', or wants to triage what's saved before deciding what to forget.",
    risk: "low",
    parameters_schema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["episodic", "semantic", "procedural"],
          description: "Optional filter by memory type.",
        },
        status: {
          type: "string",
          enum: ["active", "archived", "all"],
          description:
            "Active = inyectables hoy; archived = soft-deleted; all = ambos. Default 'active'.",
        },
        q: {
          type: "string",
          description: "Optional substring to filter by content (ILIKE).",
        },
        limit: {
          type: "number",
          description: "Default 25, hard cap 100 for chat output.",
        },
        offset: {
          type: "number",
          description: "Pagination offset (default 0).",
        },
      },
      required: [],
    },
  },
  {
    id: "search_user_memories",
    name: "search_user_memories",
    description:
      "Semantic search over the user's own long-term memories using the embedding of a query string. Use when the user asks loosely ('what do you know about my work', 'recuerdas algo sobre tenis'). Read-only; no confirmation. Returns ranked matches with similarity scores.",
    risk: "low",
    parameters_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Free-text query. The tool will embed it and search nearest memories.",
        },
        limit: {
          type: "number",
          description: "Default 8, hard cap 20.",
        },
      },
      required: ["query"],
    },
  },
  {
    id: "archive_user_memory",
    name: "archive_user_memory",
    description:
      "Archives ONE of the user's own long-term memories (soft-delete reversible). The memory stops being injected into future turns but is preserved and can be restored from the UI or with restore_user_memory. Requires explicit human confirmation before executing.",
    risk: "medium",
    parameters_schema: {
      type: "object",
      properties: {
        memory_id: {
          type: "string",
          description: "UUID of the memory to archive (from list/search).",
        },
      },
      required: ["memory_id"],
    },
  },
  {
    id: "delete_user_memory",
    name: "delete_user_memory",
    description:
      "PERMANENTLY DELETES one of the user's own long-term memories. NOT reversible. Prefer archive_user_memory in most cases. Requires explicit human confirmation before executing.",
    risk: "high",
    parameters_schema: {
      type: "object",
      properties: {
        memory_id: {
          type: "string",
          description: "UUID of the memory to delete (from list/search).",
        },
      },
      required: ["memory_id"],
    },
  },
  // ============================================================
  // Operational cases — case mutation tools
  // Used by skills running under canal `case_runner` para mover el estado
  // del caso e insertar eventos. Las ediciones del caso son `medium` para
  // que el agente las haga sin HITL en cada paso (el HITL real está en las
  // tools de juicio comercial: precio, contrato, publicación).
  // ============================================================
  {
    id: "operational_case_create",
    name: "operational_case_create",
    description:
      "Creates a new operational case (instance) for the calling user from a known case_type. Use ONLY when the user asks to start a new long-running workflow conversationally (e.g. 'help me option a property') and there is no case_id already in scope. The created case starts at current_step='intake' and status='active' so the next cron tick or follow-up turn can route it. Validates that the case_type belongs to the user (private) or is global, and that all required fields from intake_schema_jsonb are present in `context`. Does NOT send any external message; downstream skills are responsible for the first contact.",
    risk: "medium",
    parameters_schema: {
      type: "object",
      properties: {
        case_type: {
          type: "string",
          description:
            "Slug of the operational_case_type (e.g. 'property_optioning'). Must be visible to the user.",
        },
        context: {
          type: "object",
          description:
            "Initial context_jsonb. Must include every field declared as required in the case_type's intake_schema_jsonb.",
        },
        external_contact: {
          type: "object",
          description:
            "Optional external contact for the case (e.g. { channel: 'telegram', chat_id: 12345, display_name: '...' }). Required by downstream skills that message externally; pass it now if the user already gave you the data.",
        },
        next_action_at: {
          type: "string",
          description:
            "ISO 8601 datetime for the first cron tick. Defaults to now() so the first operational step runs as soon as possible.",
        },
        due_at: {
          type: "string",
          description: "Optional ISO 8601 hard deadline for the whole workflow.",
        },
      },
      required: ["case_type", "context"],
    },
  },
  {
    id: "operational_case_update_state",
    name: "operational_case_update_state",
    description:
      "Updates the active operational case (status, current_step, next_action_at, due_at, context_jsonb). Pass only the fields that change. Always include 'expected_version' from the [Caso operacional activo] block to avoid lost updates. Inserts a corresponding event_type='state_changed' in operational_case_events.",
    risk: "medium",
    parameters_schema: {
      type: "object",
      properties: {
        case_id: { type: "string", description: "UUID of the case (from [Caso operacional activo])." },
        expected_version: {
          type: "number",
          description:
            "Current version from the case context. The update is rejected (409) if this no longer matches.",
        },
        status: {
          type: "string",
          enum: [
            "active",
            "waiting_internal",
            "waiting_external",
            "paused",
            "completed",
            "failed",
          ],
        },
        current_step: { type: "string" },
        next_action_at: { type: "string", description: "ISO 8601 datetime." },
        due_at: { type: "string", description: "ISO 8601 datetime." },
        context_patch: {
          type: "object",
          description:
            "Object merged shallowly into context_jsonb (does NOT replace existing keys not present here).",
        },
        external_contact: {
          type: "object",
          description:
            "{ channel, chat_id, display_name, identifier } — set when binding the case to a Telegram chat for the first time.",
        },
        note: {
          type: "string",
          description:
            "Optional one-line note explaining why; persisted in event payload as `reason`.",
        },
      },
      required: ["case_id", "expected_version"],
    },
  },
  {
    id: "operational_case_update_intake",
    name: "operational_case_update_intake",
    description:
      "Updates only intake_schema fields for an active operational case. Recomputes missing_required deterministically and, when complete, moves the case from intake to the configured first operational step so the next case tick can run.",
    risk: "low",
    parameters_schema: {
      type: "object",
      properties: {
        case_id: { type: "string", description: "UUID of the case in current_step='intake'." },
        expected_version: {
          type: "number",
          description:
            "Current version from the case context. The update is rejected if this no longer matches.",
        },
        intake_patch: {
          type: "object",
          description:
            "Fields extracted from the conversation. Only keys declared in intake_schema_jsonb are persisted.",
        },
        external_contact: {
          type: "object",
          description:
            "Optional external contact to bind while completing intake, e.g. { channel, chat_id, display_name }.",
        },
        next_action_at: {
          type: "string",
          description:
            "Optional ISO 8601 datetime for the first operational tick after intake completes. Defaults to now.",
        },
        note: { type: "string" },
      },
      required: ["case_id", "expected_version", "intake_patch"],
    },
  },
  {
    id: "operational_case_persist_comparables_analysis",
    name: "operational_case_persist_comparables_analysis",
    description:
      "Builds and persists context_jsonb.comparables_analysis deterministically from this turn's EasyBroker, BigQuery and Avaclick results. Use after comparable search/valuation tools; do not hand-write comparables_analysis with operational_case_update_state.",
    risk: "low",
    parameters_schema: {
      type: "object",
      properties: {
        case_id: {
          type: "string",
          description: "UUID of the active operational case.",
        },
        expected_version: {
          type: "number",
          description:
            "Current case version before persisting comparables_analysis.",
        },
        note: {
          type: "string",
          description: "Optional note for the audit event.",
        },
      },
      required: ["case_id", "expected_version"],
    },
  },
  {
    id: "operational_case_add_event",
    name: "operational_case_add_event",
    description:
      "Appends an audit event to the active operational case. Use when something noteworthy happened that does not change state (e.g. 'human_decision' pre-approving a price; 'reminder_sent' just sent). For state changes prefer operational_case_update_state which already records 'state_changed'.",
    risk: "low",
    parameters_schema: {
      type: "object",
      properties: {
        case_id: { type: "string" },
        event_type: {
          type: "string",
          enum: [
            "step_completed",
            "reminder_sent",
            "escalated",
            "human_decision",
            "external_response",
            "error",
          ],
        },
        actor: { type: "string", enum: ["system", "agent", "user", "external"] },
        payload: {
          type: "object",
          description: "Free-form JSON describing the event.",
        },
      },
      required: ["case_id", "event_type", "actor"],
    },
  },
  {
    id: "operational_case_register_document",
    name: "operational_case_register_document",
    description:
      "Registers a file that is already stored in Supabase Storage as document evidence for an operational case. Use when the owner or inmobiliario provides predial, escritura, INE, comprobante de domicilio, boleta registral, or related files. This does not upload bytes; it records metadata and audit trail for an existing storage_path.",
    risk: "low",
    parameters_schema: {
      type: "object",
      properties: {
        case_id: { type: "string", description: "UUID of the operational case." },
        kind: {
          type: "string",
          description:
            "Canonical document kind, e.g. escritura_descripcion, predial, ine, comprobante_domicilio, boleta_registral, escritura_primera_hoja, escritura_ultima_hoja.",
        },
        storage_path: {
          type: "string",
          description: "Private path in Supabase Storage for the document bytes.",
        },
        storage_bucket: {
          type: "string",
          description: "Storage bucket. Defaults to case-documents.",
        },
        display_name: { type: "string" },
        original_name: { type: "string" },
        content_type: { type: "string" },
        file_size_bytes: { type: "number" },
        sha256: { type: "string" },
        source: {
          type: "string",
          enum: [
            "external_telegram",
            "advisor_web",
            "advisor_telegram",
            "settings_test",
            "unknown",
          ],
        },
        blocking: { type: "boolean" },
        metadata: { type: "object" },
      },
      required: ["case_id", "kind", "storage_path"],
    },
    asset_profile: {
      test: [
        {
          asset_key: "test_property_document",
          label: "Documentos de propiedad para prueba",
          description:
            "Sube uno o más archivos (escritura-descripción, predial, INE, etc.). Se registran sólo en el caso aislado de prueba.",
          accept: ["image/*", "application/pdf"],
          max_size_mb: 15,
          collection: true,
          min_count: 1,
          max_count: 8,
        },
      ],
    },
  },
  {
    id: "operational_case_list_documents",
    name: "operational_case_list_documents",
    description:
      "Lists received documents attached to an operational case, including kind, source, blocking flag, and cached extraction metadata. Use before deciding whether request-property-documents or extract-property-characteristics can advance.",
    risk: "low",
    parameters_schema: {
      type: "object",
      properties: {
        case_id: { type: "string", description: "UUID of the operational case." },
      },
      required: ["case_id"],
    },
    asset_profile: {
      test: [
        {
          asset_key: "test_property_document",
          label: "Documentos de propiedad para prueba",
          description:
            "Sube uno o más archivos. Al probar, se registran en el caso aislado antes de listar.",
          accept: ["image/*", "application/pdf"],
          max_size_mb: 15,
          collection: true,
          min_count: 1,
          max_count: 8,
        },
      ],
    },
  },
  {
    id: "operational_case_extract_document_fields",
    name: "operational_case_extract_document_fields",
    description:
      "Runs cached extraction for a case document image or PDF and stores the extracted JSON. Use for escritura_descripcion, predial, boleta registral, and similar documents before asking the owner for missing characteristics. Does not re-run when extraction is already cached unless force=true.",
    risk: "low",
    parameters_schema: {
      type: "object",
      properties: {
        document_id: {
          type: "string",
          description: "UUID from operational_case_documents.",
        },
        force: {
          type: "boolean",
          description:
            "Set true only if the document was replaced or the user explicitly asks to re-extract.",
        },
      },
      required: ["document_id"],
    },
    asset_profile: {
      test: [
        {
          asset_key: "test_property_document",
          label: "Documentos de propiedad para extracción",
          description:
            "Sube uno o más PDFs o imágenes legibles. La prueba de extracción usa primero escritura-descripción si existe.",
          accept: ["image/*", "application/pdf"],
          max_size_mb: 15,
          collection: true,
          min_count: 1,
          max_count: 8,
        },
      ],
    },
  },
  {
    id: "notify_user",
    name: "notify_user",
    description:
      "Sends a notification to the inmobiliario (the human running the agent), choosing channel by their preferences (web/telegram, presence, urgency). Use to ask for a decision, deliver a finished package, or escalate. Does NOT message external contacts (use telegram_send_message_to_contact for that).",
    risk: "low",
    parameters_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Message body." },
        kind: {
          type: "string",
          description:
            "Short tag for logs/UI (e.g. 'case_reminder', 'package_ready', 'escalation').",
        },
        urgency: {
          type: "string",
          enum: ["low", "normal", "high"],
          description:
            "low/normal respect web presence; high ignores it and fans out to all preferred channels.",
        },
        case_id: {
          type: "string",
          description: "Optional: case this notification is about (for audit).",
        },
      },
      required: ["text"],
    },
  },
  // ============================================================
  // Real estate — domain tools
  // Comunicación, EasyBroker, BigQuery comparables, generación de
  // documentos, watermarking, integración con Ungga.
  // ============================================================
  {
    id: "telegram_send_message_to_contact",
    name: "telegram_send_message_to_contact",
    description:
      "Sends a Telegram message to an EXTERNAL contact (the property owner, the lead) — NOT to the inmobiliario. The contact must have started a chat with the bot first (so we have their chat_id). Requires HITL confirmation. Use this to request documents, schedule the photo session, send reminders. For the inmobiliario use notify_user.",
    risk: "high",
    requires_integration: "telegram_bot",
    parameters_schema: {
      type: "object",
      properties: {
        chat_id: { type: "number", description: "Telegram chat_id of the external contact." },
        text: { type: "string", description: "Message body (UTF-8, ≤ 4096 chars)." },
        case_id: {
          type: "string",
          description:
            "Operational case this message is part of. Used to bind the chat to the case if it is not bound yet, and to log a `reminder_sent` or equivalent event.",
        },
        purpose: {
          type: "string",
          description:
            "Short tag for the audit event (e.g. 'request_documents', 'remind_documents', 'confirm_photo_session').",
        },
      },
      required: ["chat_id", "text"],
    },
  },
  {
    id: "easybroker_search_listings",
    name: "easybroker_search_listings",
    description:
      "Searches active/published EasyBroker listings (read-only) using property type/status server filters and normalized zona/operation/price/area filters. Use for current market comparables and published inventory.",
    risk: "low",
    requires_integration: "easybroker_web",
    parameters_schema: {
      type: "object",
      properties: {
        zona: { type: "string" },
        operation: { type: "string", enum: ["sale", "rent"] },
        operations: {
          type: "array",
          items: { type: "string", enum: ["sale", "rent"] },
          description: "One or more operations to include.",
        },
        property_type: { type: "string" },
        property_types: {
          type: "array",
          items: { type: "string" },
          description: "One or more EasyBroker property types to include.",
        },
        min_price: { type: "number" },
        max_price: { type: "number" },
        min_area_m2: { type: "number" },
        max_area_m2: { type: "number" },
        bedrooms: {
          type: "number",
          description:
            "Exact bedroom count for buyer/renter option searches. Comparable valuation searches ignore this; the contract keeps zona/operation/type/area only.",
        },
        min_bedrooms: {
          type: "number",
          description: "Minimum bedroom count for buyer/renter option searches.",
        },
        bathrooms: {
          type: "number",
          description:
            "Exact bathroom count for buyer/renter option searches. Comparable valuation searches ignore this.",
        },
        min_bathrooms: {
          type: "number",
          description: "Minimum bathroom count for buyer/renter option searches.",
        },
        parking_spaces: {
          type: "number",
          description:
            "Exact parking space count for buyer/renter option searches. Comparable valuation searches ignore this.",
        },
        min_parking_spaces: {
          type: "number",
          description: "Minimum parking space count for buyer/renter option searches.",
        },
        shared_commission_only: {
          type: "boolean",
          description:
            "When true, filters MLS results to properties that share commission.",
        },
        page: { type: "number", description: "1-based page (default 1)." },
        limit: {
          type: "number",
          description: "Page size (default 20, max 50).",
        },
      },
      required: [],
    },
  },
  {
    id: "easybroker_search_closed_deals",
    name: "easybroker_search_closed_deals",
    description:
      "Read-only search over EasyBroker MLS with Estatus=Solo cerradas verified. Use as historical reference for comparables, but do not assume the exposed price is the final closing price unless the account captures it that way. If Solo cerradas cannot be verified, the tool returns filter_not_applied with empty results.",
    risk: "low",
    requires_integration: "easybroker_web",
    parameters_schema: {
      type: "object",
      properties: {
        zona: { type: "string" },
        operation: { type: "string", enum: ["sale", "rent"] },
        operations: {
          type: "array",
          items: { type: "string", enum: ["sale", "rent"] },
          description: "One or more operations to include.",
        },
        property_type: { type: "string" },
        property_types: {
          type: "array",
          items: { type: "string" },
          description: "One or more EasyBroker property types to include.",
        },
        min_price: { type: "number" },
        max_price: { type: "number" },
        min_area_m2: { type: "number" },
        max_area_m2: { type: "number" },
        bedrooms: {
          type: "number",
          description:
            "Exact bedroom count for buyer/renter option searches. Comparable valuation searches ignore this.",
        },
        min_bedrooms: {
          type: "number",
          description: "Minimum bedroom count.",
        },
        bathrooms: {
          type: "number",
          description:
            "Exact bathroom count for buyer/renter option searches. Comparable valuation searches ignore this.",
        },
        min_bathrooms: {
          type: "number",
          description: "Minimum bathroom count.",
        },
        parking_spaces: {
          type: "number",
          description:
            "Exact parking space count for buyer/renter option searches. Comparable valuation searches ignore this.",
        },
        min_parking_spaces: {
          type: "number",
          description: "Minimum parking space count.",
        },
        date_from: { type: "string" },
        date_to: { type: "string" },
        limit: { type: "number" },
      },
      required: [],
    },
  },
  {
    id: "bigquery_lookup_local_comparables",
    name: "bigquery_lookup_local_comparables",
    description:
      "Queries the Ungga warehouse (BigQuery) for published internal inventory matching a zone/type/operation, used as comparable asking prices. Read-only; tenant-filtered automatically. Returns normalized rows plus price percentiles over parsed asking prices. Does not represent closed prices.",
    risk: "low",
    parameters_schema: {
      type: "object",
      properties: {
        zona: { type: "string", description: "Free-text zone or city name." },
        operation: { type: "string", enum: ["sale", "rent"] },
        property_type: { type: "string" },
        target_price: {
          type: "number",
          description:
            "Reference asking price for the subject property. If min_price/max_price are omitted, the tool derives an approximate comparison band around this price.",
        },
        price: {
          type: "number",
          description: "Alias for target_price.",
        },
        min_price: {
          type: "number",
          description: "Minimum asking price to include after best-effort price_display parsing.",
        },
        max_price: {
          type: "number",
          description: "Maximum asking price to include after best-effort price_display parsing.",
        },
        min_area_m2: { type: "number" },
        max_area_m2: { type: "number" },
        months_back: {
          type: "number",
          description:
            "Maximum listing age in months based on created_time/high date (default 24, max 60).",
        },
        limit: {
          type: "number",
          description:
            "Max comparable rows returned and used for local stats (default 100, cap 250).",
        },
      },
      required: [],
    },
  },
  {
    id: "geocode_property_address",
    name: "geocode_property_address",
    description:
      "Geocodes a property address in Mexico and returns latitude/longitude with confidence and top candidates.",
    risk: "low",
    parameters_schema: {
      type: "object",
      properties: {
        street: { type: "string" },
        exterior_number: { type: "string" },
        neighborhood: { type: "string" },
        municipality: { type: "string" },
        state: { type: "string" },
        postal_code: { type: "string" },
        country: { type: "string", description: "ISO country code or country name. Default MX." },
      },
      required: [],
    },
  },
  {
    id: "get_avaclick_valuation",
    name: "get_avaclick_valuation",
    description:
      "Gets an external digital valuation opinion (sale/rent ranges) from Avaclick for house/condo-house/condo-apartment in Mexico. Not a legal or fiscal appraisal.",
    risk: "low",
    requires_integration: "avaclick",
    parameters_schema: {
      type: "object",
      properties: {
        customer_name: { type: "string" },
        customer_email: { type: "string" },
        customer_phone: { type: "string" },
        property_type: {
          type: "string",
          enum: ["house", "condo_house", "condo_apartment"],
        },
        latitude: { type: "number" },
        longitude: { type: "number" },
        state_name: { type: "string" },
        municipality_name: { type: "string" },
        neighborhood_name: { type: "string" },
        zip_code: { type: "string" },
        street: { type: "string" },
        lot: { type: "string" },
        block: { type: "string" },
        interior_number: { type: "string" },
        exterior_number: { type: "string" },
        land_area_m2: { type: "number" },
        construction_area_m2: { type: "number" },
        has_elevator: { type: "boolean" },
        apartment_floor: { type: "number" },
        age_years: { type: "number" },
        parking_spaces: { type: "number" },
        bedrooms: { type: "number" },
        full_bathrooms: { type: "number" },
        half_bathrooms: { type: "number" },
        floors: { type: "number" },
        conservation: {
          type: "string",
          enum: ["new", "very_good", "good", "regular", "bad"],
        },
        private_amenities: {
          type: "array",
          items: { type: "string" },
        },
        common_amenities: {
          type: "array",
          items: { type: "string" },
        },
      },
      required: ["property_type"],
    },
  },
  {
    id: "generate_document_from_template",
    name: "generate_document_from_template",
    description:
      "Renders a DOCX document by filling {{placeholders}} in a tenant template stored in account_assets. Use for the commission contract, property report, or listing description sheet. Placeholder values are derived automatically from the operational case (property_data, pricing_proposal, contact); `data` is optional and only needed to override or add fields. This tool creates an internal draft; human approval applies to review/send decisions, not to draft rendering itself.",
    risk: "medium",
    parameters_schema: {
      type: "object",
      properties: {
        template_slug: {
          type: "string",
          description:
            "Slug of the template (e.g. 'commission_contract', 'listing_description'). Used to select the account asset and name the generated file.",
        },
        asset_key: {
          type: "string",
          description:
            "Optional explicit account_assets.asset_key. Omit entirely when unknown (do not send empty string). If omitted, the tool tries template_slug, template_slug_template, then commission_contract_template.",
        },
        format: { type: "string", enum: ["docx", "pdf"], description: "Output format. Current renderer supports docx; pdf returns unsupported_format." },
        data: {
          type: "object",
          description:
            "Optional. Object with placeholder values that override or extend the values auto-derived from the case. Prefer omitting `data` entirely to let the tool fill the template from the operational case context; do not send empty strings for optional fields.",
        },
        case_id: {
          type: "string",
          description: "Operational case this document belongs to (for audit and to auto-derive placeholder values).",
        },
      },
      required: ["template_slug", "format"],
    },
  },
  {
    id: "image_watermark",
    name: "image_watermark",
    description:
      "Applies the active tenant's watermark PNG to one or more images. Returns paths or URLs to the watermarked outputs. Used to brand property photos before publishing. Requires that the tenant configured a watermark asset.",
    risk: "low",
    parameters_schema: {
      type: "object",
      properties: {
        input_paths: {
          type: "array",
          items: { type: "string" },
          description:
            "Server-side paths or URLs of the source images (within FILE_TOOLS_ROOT or signed URLs).",
        },
        asset_key: {
          type: "string",
          description:
            "Optional explicit account_assets.asset_key for the watermark. Defaults to watermark, watermark_png, brand_watermark, or a matching image asset.",
        },
        position: {
          type: "string",
          enum: ["bottom-right", "bottom-left", "top-right", "top-left", "center"],
          description: "Where to place the watermark. Default 'bottom-right'.",
        },
        opacity: {
          type: "number",
          description: "0–1 (default 0.6).",
        },
        scale: {
          type: "number",
          description:
            "Watermark width as a fraction of the photo width (0.05–0.5, default 0.18).",
        },
      },
      required: ["input_paths"],
    },
    asset_profile: {
      account: [
        {
          asset_key: "listing_photo_watermark",
          label: "Watermark para fotos de publicación",
          description:
            "Imagen transparente o logo que se aplicará a las fotos antes de publicar.",
          accept: ["image/png", "image/jpeg", "image/webp", "image/svg+xml"],
          max_size_mb: 5,
          required: true,
        },
      ],
      test: [
        {
          asset_key: "test_property_listing_photos",
          label: "Fotos de propiedad para pruebas de listing",
          description:
            "Carga fotos temporales de un inmueble para analizar cobertura visual, aplicar watermark y validar publicación.",
          accept: ["image/jpeg", "image/png", "image/webp"],
          max_size_mb: 15,
          required: true,
          param: "input_paths",
          min_count: 1,
          max_count: 30,
          collection: true,
        },
      ],
    },
  },
  {
    id: "analyze_property_images",
    name: "analyze_property_images",
    description:
      "Analyzes property photos/images with a vision model and returns structured, evidence-based observations (coverage by space, features_by_space, style/materials/lighting notes, copy-safe phrases, and do-not-claim constraints). This does not infer that unseen features do not exist.",
    risk: "low",
    parameters_schema: {
      type: "object",
      properties: {
        image_paths: {
          type: "array",
          items: { type: "string" },
          description:
            "Storage paths or URLs for images to analyze (e.g. raw_photos).",
        },
        purpose: {
          type: "string",
          description:
            "Optional context for analysis (default: listing_description).",
        },
        case_id: {
          type: "string",
          description:
            "Operational case id for context persistence and audit linkage.",
        },
      },
      required: ["image_paths"],
    },
    asset_profile: {
      test: [
        {
          asset_key: "test_property_listing_photos",
          label: "Fotos de propiedad para pruebas de listing",
          description:
            "Carga fotos temporales de un inmueble para analizar cobertura visual, aplicar watermark y validar publicación.",
          accept: ["image/jpeg", "image/png", "image/webp"],
          max_size_mb: 15,
          required: true,
          param: "image_paths",
          min_count: 2,
          max_count: 30,
          collection: true,
        },
      ],
    },
  },
  {
    id: "lookup_property_surroundings",
    name: "lookup_property_surroundings",
    description:
      "Builds verified surroundings context for a property (points of interest, mobility cues, and area summary) from address/coordinates using geocoding + nearby place lookup. Prefer case_id to reuse geocoded coordinates from the case. Do not pass latitude/longitude=0 as placeholders. Results are persisted for listing copy generation.",
    risk: "low",
    parameters_schema: {
      type: "object",
      properties: {
        address: { type: "string" },
        neighborhood: { type: "string" },
        municipality: { type: "string" },
        state: { type: "string" },
        country: { type: "string" },
        latitude: {
          type: "number",
          description:
            "Optional. Only pass real coordinates; never 0 as a placeholder. Prefer omitting and using case_id.",
        },
        longitude: {
          type: "number",
          description:
            "Optional. Only pass real coordinates; never 0 as a placeholder. Prefer omitting and using case_id.",
        },
        radius_meters: {
          type: "number",
          description: "Search radius in meters for nearby places (default 1500).",
        },
        max_results_per_category: {
          type: "number",
          description:
            "Max POIs per category to include in output (default 4, max 8).",
        },
        case_id: {
          type: "string",
          description:
            "Operational case id for context persistence, audit linkage, and reuse of prior geocode.",
        },
      },
      required: [],
    },
  },
  {
    id: "prepare_listing_description_draft",
    name: "prepare_listing_description_draft",
    description:
      "Generates a structured real-estate listing description draft from verified ingredients in the operational case (property_data, pricing, photo_analysis, zone_context, advisor highlights).",
    risk: "low",
    parameters_schema: {
      type: "object",
      properties: {
        case_id: {
          type: "string",
          description:
            "Operational case id used to read ingredients and persist draft outputs.",
        },
        purpose: {
          type: "string",
          description:
            "Optional purpose tag (default: listing_description).",
        },
      },
      required: ["case_id"],
    },
  },
  {
    id: "easybroker_create_listing",
    name: "easybroker_create_listing",
    description:
      "Creates a new not_published property in EasyBroker using the active tenant's API key. WRITE: requires HITL. Prefer case_id; the adapter allowlists/sanitizes the payload and resolves coords from the case. Do not send custom_fields or free-form features. After creation use easybroker_upload_images to attach photos.",
    risk: "high",
    requires_integration: "easybroker",
    parameters_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        operation: { type: "string", enum: ["sale", "rent"] },
        property_type: { type: "string" },
        price: { type: "number" },
        currency: { type: "string", description: "ISO 4217 (e.g. 'MXN')." },
        status: {
          type: "string",
          enum: ["published", "sold", "rented", "reserved", "suspended", "not_published"],
          description: "Defaults to not_published for safety.",
        },
        street: {
          type: "string",
          description: "Required by EasyBroker. Can also be provided as location.street.",
        },
        location: {
          type: "object",
          description:
            "Address helpers for the adapter (street, neighborhood/city/state, postal_code, latitude, longitude). Only EasyBroker-permitted location keys are sent.",
        },
        construction_size: { type: "number" },
        lot_size: { type: "number" },
        area_m2: { type: "number", description: "Alias for construction_size." },
        bedrooms: { type: "number" },
        bathrooms: { type: "number" },
        half_bathrooms: { type: "number" },
        parking: { type: "number", description: "Alias for parking_spaces." },
        parking_spaces: { type: "number" },
        features: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional. Only names that match GET /v1/features for the account are sent.",
        },
        tags: { type: "array", items: { type: "string" } },
        share_commission: { type: "boolean" },
        collaboration_notes: { type: "string" },
        shared_commission_percentage: {
          type: "number",
          description:
            "EasyBroker only accepts 50 or null. Prefer mapping from commission_terms.",
        },
        commission: {
          type: "object",
          description:
            "Owner closing commission nested under operations[]. Prefer mapping from commission_terms.commission_pct as { type: 'percentage', value }.",
          properties: {
            type: {
              type: "string",
              enum: ["percentage", "amount", "months"],
            },
            value: { type: "number" },
            currency: { type: "string" },
          },
        },
        videos: { type: "array", items: { type: "string" } },
        virtual_tour: { type: "string" },
        custom_fields: {
          type: "object",
          description: "Ignored. Do not use; the adapter owns the EasyBroker contract.",
        },
        custom_fields_json: {
          type: "string",
          description: "Ignored. Do not use; the adapter owns the EasyBroker contract.",
        },
        case_id: { type: "string" },
        dry_run: { type: "boolean" },
      },
      required: ["title", "description", "operation", "property_type", "price"],
    },
  },
  {
    id: "easybroker_upload_images",
    name: "easybroker_upload_images",
    description:
      "Uploads images to an existing EasyBroker listing from the case photo_manifest. WRITE: requires HITL. Prefer only case_id + listing_id; the adapter applies brand watermark when configured and derives identity-safe pairs. Do not invent upload paths.",
    risk: "high",
    requires_integration: "easybroker",
    parameters_schema: {
      type: "object",
      properties: {
        listing_id: { type: "string" },
        case_id: {
          type: "string",
          description:
            "Operational case id. Required so the adapter can watermark (if brand asset exists) and derive photo pairs from photo_manifest.",
        },
        image_paths: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional. Ignored when case_id has a photo_manifest; the adapter owns path identity.",
        },
        image_titles: { type: "array", items: { type: "string" } },
        dry_run: { type: "boolean" },
      },
      required: ["listing_id", "case_id"],
    },
    asset_profile: {
      test: [
        {
          asset_key: "test_property_listing_photos",
          label: "Fotos de propiedad para pruebas de listing",
          description:
            "Carga fotos temporales de un inmueble para analizar cobertura visual, aplicar watermark y validar publicación.",
          accept: ["image/jpeg", "image/png", "image/webp"],
          max_size_mb: 15,
          required: true,
          param: "image_paths",
          min_count: 1,
          max_count: 30,
          collection: true,
        },
      ],
    },
  },
  {
    id: "easybroker_publish_listing",
    name: "easybroker_publish_listing",
    description:
      "Publishes an existing EasyBroker listing (status=published) after draft + images + preflight. WRITE: requires HITL unless E2E auto-execute.",
    risk: "high",
    requires_integration: "easybroker",
    parameters_schema: {
      type: "object",
      properties: {
        listing_id: { type: "string" },
        case_id: { type: "string" },
        dry_run: { type: "boolean" },
      },
      required: ["listing_id"],
    },
  },
  {
    id: "ungga_publish_listing",
    name: "ungga_publish_listing",
    description:
      "Ungga listing in two phases: prepare_draft then publish_draft. Prefer case_id + action only; adapter enriches listing fields and photo URLs from the case. publish_draft also needs ungga_property_id or draft_url. Internal API preferred; supported CLI/Playwright fallback in pocs/ungga-cli.",
    risk: "high",
    requires_integration: "ungga",
    parameters_schema: {
      type: "object",
      properties: {
        case_id: {
          type: "string",
          description:
            "Operational case id (required). Adapter enriches title/price/commission/image_urls from case context.",
        },
        action: {
          type: "string",
          enum: ["prepare_draft", "publish_draft"],
          description:
            "prepare_draft: wizard + save draft. publish_draft: publish an approved draft by GU-ID.",
        },
        ungga_property_id: {
          type: "string",
          description: "GU-ID for publish_draft when draft_url is absent.",
        },
        draft_url: {
          type: "string",
          description:
            "Optional publish_draft shortcut pointing to /app/propiedades/{GU-ID}.",
        },
      },
      required: ["case_id"],
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
