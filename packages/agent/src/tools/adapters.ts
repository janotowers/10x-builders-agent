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
import { TOOL_CATALOG } from "./catalog";
import { githubApi } from "./github-api";
import { userWantsNewGithubRepository } from "./github-intent";
import { userMessageAnchorsCalendarPeriodOnly } from "./calendar-period-intent";
import { userMessageIsPresenceOrGreetingOnly } from "./chat-greeting-intent";
import { createToolCall, updateToolCallStatus } from "@agents/db";
import { addCalendarTools } from "./calendar-adapters";
import type { ToolContext } from "./tool-context";

export type { ToolContext } from "./tool-context";

function isToolAvailable(toolId: string, ctx: ToolContext): boolean {
  const setting = ctx.enabledTools.find((t) => t.tool_id === toolId);
  if (!setting?.enabled) return false;

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
          });
        },
        {
          name: "get_user_preferences",
          description:
            "Returns the current user preferences and agent configuration.",
          schema: z.object({}),
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
          description: "Lists the user's GitHub repositories.",
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

  addCalendarTools(ctx, tools);

  return tools;
}
