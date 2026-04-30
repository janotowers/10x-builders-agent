/**
 * LangChain tool registration for GitHub and internal tools. Calendar tools live in
 * `calendar-adapters.ts` (`addCalendarTools`).
 *
 * **Layers:** `catalog.ts` = definitions and policy (`risk`, integrations); adapters.ts (this file) =
 * execution, Zod schemas, DB tool_call tracking, and confirmation branches.
 *
 * **Style:** handlers are registered with `if (isToolAvailable) { tools.push(tool(...)) }`.
 * An equivalent pattern is a `Record<toolId, handler>` map plus one loop over `TOOL_CATALOG`;
 * neither is inherently more robust — choose based on readability and file size. When this
 * file grows, prefer shared helpers and split by domain (see `docs/architecture.md`).
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { Cron } from "croner";
import { TOOL_CATALOG } from "./catalog";
import { githubApi } from "./github-api";
import { userWantsNewGithubRepository } from "./github-intent";
import { userMessageAnchorsCalendarPeriodOnly } from "./calendar-period-intent";
import { userMessageIsPresenceOrGreetingOnly } from "./chat-greeting-intent";
import { userMessageIsResponseFormatOrStyleOnly } from "./response-style-intent";
import { userMessageIsCalendarRelated } from "./calendar-intent";
import { userMessageIsLocalShellOrFilesystemIntent } from "./local-shell-intent";
import { userMessageIsFileToolsIntent } from "./file-tools-intent";
import {
  createToolCall,
  updateToolCallStatus,
  createScheduledTask,
  listScheduledTasks,
  setScheduledTaskStatus,
} from "@agents/db";
import { addCalendarTools } from "./calendar-adapters";
import { executeBashCommand, getActiveShellName } from "./bashExec";
import {
  executeReadFile,
  executeWriteFile,
  executeEditFile,
} from "./fileTools";
import { executeBigQueryQuery } from "./bigquery-adapter";
import { readSkillReference } from "./skill-references";
import { defaultSkillsRoot } from "../skills/runtime";
import type { ToolContext } from "./tool-context";

export type { ToolContext } from "./tool-context";

function isToolAvailable(toolId: string, ctx: ToolContext): boolean {
  const setting = ctx.enabledTools.find((t) => t.tool_id === toolId);
  if (!setting?.enabled) return false;

  // Skill-aware narrowing (V1-B): when the pre-graph selector picked a skill
  // for this turn, the tool list is intersected with that skill's
  // `allowed_tools`. When no skill is active, this check is a no-op and the
  // filtering below behaves exactly as it did before V1-B.
  if (
    Array.isArray(ctx.activeSkillAllowedTools) &&
    ctx.activeSkillAllowedTools.length > 0 &&
    !ctx.activeSkillAllowedTools.includes(toolId)
  ) {
    return false;
  }

  if (toolId === "bash" && process.env.BASH_TOOL_ENABLED !== "true") {
    return false;
  }

  if (
    (toolId === "read_file" ||
      toolId === "write_file" ||
      toolId === "edit_file") &&
    (process.env.FILE_TOOLS_ENABLED !== "true" ||
      !process.env.FILE_TOOLS_ROOT?.trim())
  ) {
    return false;
  }

  const def = TOOL_CATALOG.find((t) => t.id === toolId);
  if (def?.requires_integration) {
    const hasIntegration = ctx.integrations.some(
      (i) => i.provider === def.requires_integration && i.status === "active"
    );
    if (!hasIntegration) return false;
    // Fila en user_integrations no implica token usable (cifrado, expiración, etc.)
    if (def.requires_integration === "github" && !ctx.githubToken) return false;
    if (
      def.requires_integration === "google_calendar" &&
      !ctx.googleCalendarAccessToken
    ) {
      return false;
    }
  }

  if (
    toolId === "github_create_issue" &&
    ctx.lastUserMessage &&
    userWantsNewGithubRepository(ctx.lastUserMessage)
  ) {
    return false;
  }

  if (
    (toolId === "github_list_repos" || toolId === "github_list_issues") &&
    userMessageAnchorsCalendarPeriodOnly(ctx.lastUserMessage)
  ) {
    return false;
  }

  if (
    (toolId === "github_list_repos" || toolId === "github_list_issues") &&
    userMessageIsResponseFormatOrStyleOnly(ctx.lastUserMessage)
  ) {
    return false;
  }

  if (
    (toolId === "github_list_repos" ||
      toolId === "github_list_issues" ||
      toolId === "github_create_repo" ||
      toolId === "github_create_issue") &&
    ctx.lastUserMessage &&
    userMessageIsLocalShellOrFilesystemIntent(ctx.lastUserMessage)
  ) {
    return false;
  }

  const isGreeting = userMessageIsPresenceOrGreetingOnly(ctx.lastUserMessage);

  if (
    (toolId === "github_list_repos" || toolId === "github_list_issues") &&
    isGreeting
  ) {
    return false;
  }

  if (
    (toolId === "github_create_repo" || toolId === "github_create_issue") &&
    isGreeting
  ) {
    return false;
  }

  if (
    (toolId === "github_create_repo" || toolId === "github_create_issue") &&
    ctx.lastUserMessage &&
    userMessageIsCalendarRelated(ctx.lastUserMessage)
  ) {
    return false;
  }

  // Si la petición del usuario es claramente sobre archivos del workspace,
  // ocultamos calendarios y creación en GitHub para que no "salte" a otro carril.
  if (
    ctx.lastUserMessage &&
    userMessageIsFileToolsIntent(ctx.lastUserMessage) &&
    (toolId.startsWith("calendar_") ||
      toolId === "github_create_repo" ||
      toolId === "github_create_issue")
  ) {
    return false;
  }

  return true;
}

export function buildLangChainTools(ctx: ToolContext) {
  const tools = [];

  // ── Internal tools ─────────────────────────────────────────

  if (isToolAvailable("get_user_preferences", ctx)) {
    tools.push(
      tool(
        async () => {
          const { getProfile } = await import("@agents/db");
          const profile = await getProfile(ctx.db, ctx.userId);
          return JSON.stringify({
            name: profile.name,
            timezone: profile.timezone,
            language: profile.language,
            agent_name: profile.agent_name,
            email: profile.email ?? null,
            phone: profile.phone ?? null,
          });
        },
        {
          name: "get_user_preferences",
          description:
            "Returns the current user preferences and agent configuration, including canonical contact fields (email, phone) when set. Prefer this over asking the user when you need their own email or phone.",
          schema: z.object({}),
        }
      )
    );
  }

  if (isToolAvailable("read_skill_reference", ctx)) {
    tools.push(
      tool(
        async (input) => {
          const record = await createToolCall(
            ctx.db,
            ctx.sessionId,
            "read_skill_reference",
            input,
            false
          );
          const result = await readSkillReference({
            name: input.name,
            activeSkillName: ctx.activeSkillName,
            skillsRoot: ctx.skillsRoot ?? defaultSkillsRoot(),
          });
          const status: "executed" | "failed" =
            result.status === "ok" ? "executed" : "failed";
          await updateToolCallStatus(
            ctx.db,
            record.id,
            status,
            result as unknown as Record<string, unknown>
          );
          return JSON.stringify(result);
        },
        {
          name: "read_skill_reference",
          description:
            "Reads ONE reference file from the currently-active skill's `references/` directory and returns its content. Use this when the active skill's body points you to a reference (e.g. 'see references/schema.md for the full table list'). Pass only the filename stem (without extension), e.g. `schema`, `joins`, `glossary`, `fewshots-leads`. Returns `status='no_active_skill'` if no skill is selected for this turn (do NOT call it then). Returns `status='not_found'` if the file does not exist (do NOT retry; the SKILL.md body lists what is available).",
          schema: z.object({
            name: z.string().min(1).max(64),
          }),
        }
      )
    );
  }

  if (isToolAvailable("bigquery_run_query", ctx)) {
    tools.push(
      tool(
        async (input) => {
          const record = await createToolCall(
            ctx.db,
            ctx.sessionId,
            "bigquery_run_query",
            input,
            false
          );
          const result = await executeBigQueryQuery({
            sql: input.sql,
            projectId: input.project_id,
            location: input.location,
            maxResults: input.max_results,
            params: input.params,
          });
          const status: "executed" | "failed" =
            result.status === "ok" ? "executed" : "failed";
          await updateToolCallStatus(
            ctx.db,
            record.id,
            status,
            result as unknown as Record<string, unknown>
          );
          return JSON.stringify(result);
        },
        {
          name: "bigquery_run_query",
          description:
            "Executes a single READ-ONLY SQL query (SELECT or WITH...SELECT) against BigQuery and returns up to max_results rows. Validator rejects DDL/DML/scripting and multiple statements. If BigQuery is not yet configured in this environment the tool returns status='not_configured' with instructions instead of executing — explain that to the user and stop.",
          schema: z.object({
            sql: z.string().min(1),
            project_id: z.string().min(1).optional(),
            location: z.string().min(1).optional(),
            max_results: z.number().int().positive().max(1000).optional(),
            params: z
              .record(z.union([z.string(), z.number(), z.boolean()]))
              .optional(),
          }),
        }
      )
    );
  }

  if (isToolAvailable("list_enabled_tools", ctx)) {
    tools.push(
      tool(
        async () => {
          const enabled = ctx.enabledTools
            .filter((t) => t.enabled)
            .map((t) => t.tool_id)
            .filter((id) => isToolAvailable(id, ctx));
          return JSON.stringify(enabled);
        },
        {
          name: "list_enabled_tools",
          description:
            "Lists tools that are enabled and can run in this session (integrations connected and tokens available).",
          schema: z.object({}),
        }
      )
    );
  }

  // ── GitHub read tools ──────────────────────────────────────

  if (isToolAvailable("github_list_repos", ctx)) {
    tools.push(
      tool(
        async (input) => {
          const record = await createToolCall(
            ctx.db,
            ctx.sessionId,
            "github_list_repos",
            input,
            false
          );

          if (!ctx.githubToken) {
            const err = { error: "GitHub token not available" };
            await updateToolCallStatus(ctx.db, record.id, "failed", err);
            return JSON.stringify(err);
          }

          const { status, data } = await githubApi(
            ctx.githubToken,
            "GET",
            `/user/repos?per_page=${input.per_page}&sort=updated`
          );

          if (status >= 400) {
            const err = { error: "GitHub API error", status, details: data };
            await updateToolCallStatus(ctx.db, record.id, "failed", err);
            return JSON.stringify(err);
          }

          const repos = (data as Array<Record<string, unknown>>).map((r) => ({
            full_name: r.full_name,
            description: r.description,
            html_url: r.html_url,
            private: r.private,
            language: r.language,
            updated_at: r.updated_at,
          }));

          const result = { repos };
          await updateToolCallStatus(
            ctx.db,
            record.id,
            "executed",
            result as unknown as Record<string, unknown>
          );
          return JSON.stringify(result);
        },
        {
          name: "github_list_repos",
          description:
            "Lists ONLY the GitHub repositories owned by the authenticated user. Do NOT use when the user is only setting preferences for how you should answer (bullets, tone, format, length, language style) with no request for repo data. Does NOT search GitHub for arbitrary projects, brands, companies or topics. Use ONLY when the user explicitly asks to see or list THEIR own repos on GitHub.",
          schema: z.object({
            per_page: z.number().max(30).optional().default(10),
          }),
        }
      )
    );
  }

  if (isToolAvailable("github_list_issues", ctx)) {
    tools.push(
      tool(
        async (input) => {
          const record = await createToolCall(
            ctx.db,
            ctx.sessionId,
            "github_list_issues",
            input,
            false
          );

          if (!ctx.githubToken) {
            const err = { error: "GitHub token not available" };
            await updateToolCallStatus(ctx.db, record.id, "failed", err);
            return JSON.stringify(err);
          }

          const { status, data } = await githubApi(
            ctx.githubToken,
            "GET",
            `/repos/${input.owner}/${input.repo}/issues?state=${input.state}`
          );

          if (status >= 400) {
            const err = { error: "GitHub API error", status, details: data };
            await updateToolCallStatus(ctx.db, record.id, "failed", err);
            return JSON.stringify(err);
          }

          const issues = (data as Array<Record<string, unknown>>).map((i) => ({
            number: i.number,
            title: i.title,
            state: i.state,
            html_url: i.html_url,
            created_at: i.created_at,
            labels: (i.labels as Array<Record<string, unknown>>)?.map(
              (l) => l.name
            ),
          }));

          const result = { issues };
          await updateToolCallStatus(
            ctx.db,
            record.id,
            "executed",
            result as unknown as Record<string, unknown>
          );
          return JSON.stringify(result);
        },
        {
          name: "github_list_issues",
          description: "Lists issues for a given repository.",
          schema: z.object({
            owner: z.string(),
            repo: z.string(),
            state: z
              .enum(["open", "closed", "all"])
              .optional()
              .default("open"),
          }),
        }
      )
    );
  }

  // ── GitHub write tools (create_repo antes que create_issue: el modelo suele priorizar las primeras tools)
  // ───────────────────────────────────────────────────────────

  if (isToolAvailable("github_create_repo", ctx)) {
    tools.push(
      tool(
        async (input) => {
          if (!ctx.githubToken) {
            const err = { error: "GitHub token not available" };
            return JSON.stringify(err);
          }

          const { status, data } = await githubApi(
            ctx.githubToken,
            "POST",
            "/user/repos",
            {
              name: input.name,
              description: input.description,
              private: input.private,
            }
          );

          if (status >= 400) {
            return JSON.stringify({
              error: "GitHub API error",
              status,
              details: data,
            });
          }

          const created = data as Record<string, unknown>;
          const result = {
            message: "Repository created",
            html_url: created.html_url,
            full_name: created.full_name,
          };
          return JSON.stringify(result);
        },
        {
          name: "github_create_repo",
          description:
            "Creates a NEW repository under the user's GitHub account. Repo name only, not owner/repo.",
          schema: z
            .object({
              name: z.string(),
              description: z.string().optional().default(""),
              private: z.boolean().optional(),
              isPrivate: z.boolean().optional(),
            })
            .transform((v) => ({
              name: v.name,
              description: v.description ?? "",
              private: Boolean(v.private ?? v.isPrivate),
            })),
        }
      )
    );
  }

  if (isToolAvailable("github_create_issue", ctx)) {
    tools.push(
      tool(
        async (input) => {
          if (!ctx.githubToken) {
            const err = { error: "GitHub token not available" };
            return JSON.stringify(err);
          }

          const { status, data } = await githubApi(
            ctx.githubToken,
            "POST",
            `/repos/${input.owner}/${input.repo}/issues`,
            { title: input.title, body: input.body }
          );

          if (status >= 400) {
            return JSON.stringify({
              error: "GitHub API error",
              status,
              details: data,
            });
          }

          const created = data as Record<string, unknown>;
          const result = {
            message: "Issue created",
            issue_url: created.html_url,
            number: created.number,
          };
          return JSON.stringify(result);
        },
        {
          name: "github_create_issue",
          description:
            "Creates an issue inside an EXISTING repo only. Never use for creating a new repository — use github_create_repo.",
          schema: z.object({
            owner: z.string(),
            repo: z.string(),
            title: z.string(),
            body: z.string().optional().default(""),
          }),
        }
      )
    );
  }

  if (isToolAvailable("bash", ctx)) {
    const shell = getActiveShellName();
    const shellHint =
      shell === "powershell"
        ? "The server runs Windows PowerShell. Use PowerShell syntax (e.g. Get-ChildItem, Get-Content)."
        : "The server shell is bash. Use standard Unix/bash syntax.";
    tools.push(
      tool(
        async (input: { terminal?: string; prompt: string }) => {
          const result = await executeBashCommand({
            terminal: input.terminal?.trim() || "default",
            prompt: input.prompt,
          });
          return JSON.stringify(result);
        },
        {
          name: "bash",
          description: `Runs a single shell command on the server host. Requires user confirmation. ${shellHint} Set terminal to a short label for logs; prompt is the command.`,
          schema: z.object({
            terminal: z.string().max(128).optional().default("default"),
            prompt: z.string().min(1).max(32000),
          }),
        }
      )
    );
  }

  // ── File manipulation tools ────────────────────────────────

  if (isToolAvailable("read_file", ctx)) {
    tools.push(
      tool(
        async (input: { path: string; offset?: number; limit?: number }) => {
          const record = await createToolCall(
            ctx.db,
            ctx.sessionId,
            "read_file",
            input,
            false
          );
          const result = await executeReadFile(input);
          const out = JSON.stringify(result);
          const asRecord = result as unknown as Record<string, unknown>;
          if (
            typeof result === "object" &&
            result !== null &&
            (result as { ok?: boolean }).ok === false
          ) {
            await updateToolCallStatus(ctx.db, record.id, "failed", asRecord);
          } else {
            await updateToolCallStatus(ctx.db, record.id, "executed", asRecord);
          }
          return out;
        },
        {
          name: "read_file",
          description:
            "Reads a file from the server workspace (FILE_TOOLS_ROOT). Path must be RELATIVE (e.g. docs/x.md), not a free-form document title — if the user only names a document, find the path with bash or ask for the relative path. Optional offset/limit (lines). offset is 1-based; 0 is treated as 'from the start'.",
          schema: z.object({
            path: z.string().min(1),
            offset: z.number().int().min(0).optional(),
            limit: z.number().int().min(1).max(5000).optional(),
          }),
        }
      )
    );
  }

  if (isToolAvailable("write_file", ctx)) {
    tools.push(
      tool(
        async (input: { path: string; content: string }) => {
          const result = await executeWriteFile(input);
          return JSON.stringify(result);
        },
        {
          name: "write_file",
          description:
            "Creates or OVERWRITES a file in the server workspace (FILE_TOOLS_ROOT). Requires confirmation. Path must be RELATIVE.",
          schema: z.object({
            path: z.string().min(1),
            content: z.string(),
          }),
        }
      )
    );
  }

  if (isToolAvailable("edit_file", ctx)) {
    tools.push(
      tool(
        async (input: {
          path: string;
          old_string: string;
          new_string: string;
        }) => {
          const result = await executeEditFile(input);
          return JSON.stringify(result);
        },
        {
          name: "edit_file",
          description:
            "Replaces a single unique occurrence of old_string with new_string in an existing file inside FILE_TOOLS_ROOT. Requires confirmation.",
          schema: z.object({
            path: z.string().min(1),
            old_string: z.string().min(1),
            new_string: z.string(),
          }),
        }
      )
    );
  }

  if (isToolAvailable("schedule_task", ctx)) {
    tools.push(
      tool(
        async (input: {
          prompt: string;
          schedule_type: "one_time" | "recurring";
          run_at?: string;
          cron_expr?: string;
          timezone?: string;
        }) => {
          const tz = input.timezone?.trim() || ctx.userTimezone || "UTC";

          // Compute next_run_at
          let nextRunAt: string;
          if (input.schedule_type === "one_time") {
            if (!input.run_at) {
              return JSON.stringify({
                ok: false,
                error: "run_at es obligatorio para tareas de tipo one_time.",
              });
            }
            const d = new Date(input.run_at);
            if (isNaN(d.getTime())) {
              return JSON.stringify({
                ok: false,
                error: "run_at no es una fecha ISO válida.",
              });
            }
            nextRunAt = d.toISOString();
          } else {
            if (!input.cron_expr) {
              return JSON.stringify({
                ok: false,
                error:
                  "cron_expr es obligatorio para tareas recurrentes (p.ej. '0 9 * * 1').",
              });
            }
            try {
              const cron = new Cron(input.cron_expr, { timezone: tz });
              const next = cron.nextRun();
              if (!next) throw new Error("sin próxima ejecución");
              nextRunAt = next.toISOString();
            } catch {
              return JSON.stringify({
                ok: false,
                error: `cron_expr inválida: "${input.cron_expr}". Usa formato estándar de 5 campos (minuto hora díaMes mes díaSemana).`,
              });
            }
          }

          const task = await createScheduledTask(ctx.db, {
            userId: ctx.userId,
            prompt: input.prompt,
            scheduleType: input.schedule_type,
            runAt: input.run_at,
            cronExpr: input.cron_expr,
            timezone: tz,
            nextRunAt,
          });

          const humanDate = new Date(nextRunAt).toLocaleString("es-MX", {
            weekday: "long",
            year: "numeric",
            month: "long",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            timeZone: tz,
          });

          return JSON.stringify({
            ok: true,
            task_id: task.id,
            schedule_type: task.schedule_type,
            next_run_at: nextRunAt,
            human_date: humanDate,
            timezone: tz,
            prompt: task.prompt,
          });
        },
        {
          name: "schedule_task",
          description:
            "Programs a task (prompt) to run automatically at a future time (one_time) or on a recurring schedule. Result is sent to Telegram by default. Requires confirmation before scheduling.",
          schema: z.object({
            prompt: z.string().min(1),
            schedule_type: z.enum(["one_time", "recurring"]),
            run_at: z.string().optional(),
            cron_expr: z.string().optional(),
            timezone: z.string().optional(),
          }),
        }
      )
    );
  }

  if (isToolAvailable("manage_scheduled_tasks", ctx)) {
    tools.push(
      tool(
        async (input: {
          action: "list" | "pause" | "resume";
          task_id?: string;
        }) => {
          const record = await createToolCall(
            ctx.db,
            ctx.sessionId,
            "manage_scheduled_tasks",
            input,
            false
          );

          try {
            if (input.action === "list") {
              const tasks = await listScheduledTasks(ctx.db, ctx.userId);
              const tz = ctx.userTimezone || "UTC";
              const summary = tasks.map((t) => {
                const nextLocal = t.next_run_at
                  ? new Date(t.next_run_at).toLocaleString("es-MX", {
                      weekday: "short",
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                      timeZone: tz,
                    })
                  : null;
                return {
                  id: t.id,
                  status: t.status,
                  schedule_type: t.schedule_type,
                  cron_expr: t.cron_expr,
                  run_at: t.run_at,
                  next_run_at: t.next_run_at,
                  next_run_local: nextLocal,
                  timezone: t.timezone,
                  prompt: t.prompt.length > 240
                    ? t.prompt.slice(0, 240) + "…"
                    : t.prompt,
                };
              });
              const result = { ok: true, count: summary.length, tasks: summary };
              await updateToolCallStatus(
                ctx.db,
                record.id,
                "executed",
                result as unknown as Record<string, unknown>
              );
              return JSON.stringify(result);
            }

            // pause / resume
            if (!input.task_id) {
              const err = {
                ok: false,
                error:
                  "task_id es obligatorio para pause/resume. Llama primero con action=\"list\" y pide al usuario que elija una.",
              };
              await updateToolCallStatus(ctx.db, record.id, "failed", err);
              return JSON.stringify(err);
            }

            const newStatus = input.action === "pause" ? "paused" : "active";
            const updated = await setScheduledTaskStatus(ctx.db, {
              taskId: input.task_id,
              userId: ctx.userId,
              newStatus,
            });

            if (!updated) {
              const err = {
                ok: false,
                error:
                  "No se encontró una tarea con ese id que pertenezca a este usuario, o la actualización falló. Verifica el id llamando con action=\"list\".",
              };
              await updateToolCallStatus(ctx.db, record.id, "failed", err);
              return JSON.stringify(err);
            }

            const result = {
              ok: true,
              action: input.action,
              task_id: updated.id,
              status: updated.status,
              schedule_type: updated.schedule_type,
              next_run_at: updated.next_run_at,
              prompt: updated.prompt.length > 240
                ? updated.prompt.slice(0, 240) + "…"
                : updated.prompt,
            };
            await updateToolCallStatus(
              ctx.db,
              record.id,
              "executed",
              result as unknown as Record<string, unknown>
            );
            return JSON.stringify(result);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const errOut = { ok: false, error: msg };
            await updateToolCallStatus(ctx.db, record.id, "failed", errOut);
            return JSON.stringify(errOut);
          }
        },
        {
          name: "manage_scheduled_tasks",
          description:
            "Lists (action=\"list\") the caller's own scheduled tasks (active+paused) or changes state by id (action=\"pause\" or \"resume\"). Scoped to the authenticated user; cannot touch other users' tasks. Does NOT delete. Pause/resume is reversible so there is no confirmation card — the model MUST disambiguate in natural language before calling pause/resume (see system prompt rules).",
          schema: z.object({
            action: z.enum(["list", "pause", "resume"]),
            // Varios modelos (especialmente vía OpenRouter/responses API)
            // emiten campos opcionales como "" o null en vez de omitirlos.
            // Aceptamos ambas formas y normalizamos a undefined antes de
            // validar el UUID para que action="list" nunca falle el schema
            // cuando el LLM envía task_id="".
            task_id: z
              .union([z.string(), z.null()])
              .optional()
              .transform((v) => (v === "" || v == null ? undefined : v))
              .pipe(z.string().uuid().optional()),
          }),
        }
      )
    );
  }

  addCalendarTools(ctx, tools);

  return tools;
}
