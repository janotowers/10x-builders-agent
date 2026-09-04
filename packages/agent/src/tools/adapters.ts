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
import { TOOL_CATALOG, getToolRisk } from "./catalog";
import { githubApi } from "./github-api";
import { userWantsNewGithubRepository } from "./github-intent";
import { userMessageAnchorsCalendarPeriodOnly } from "./calendar-period-intent";
import { userMessageIsPresenceOrGreetingOnly } from "./chat-greeting-intent";
import { userMessageIsResponseFormatOrStyleOnly } from "./response-style-intent";
import { userMessageIsCalendarRelated } from "./calendar-intent";
import { userMessageIsLocalShellOrFilesystemIntent } from "./local-shell-intent";
import { userMessageIsFileToolsIntent } from "./file-tools-intent";
import {
  updateToolCallStatus,
  createScheduledTask,
  getScheduledTaskForUser,
  listScheduledTasks,
  setScheduledTaskStatus,
  listMemories,
  searchMemories,
  archiveMemory,
  deleteMemory,
  getMemoryById,
  logMemoryAction,
} from "@agents/db";
import type { MemoryType } from "@agents/db";
import { generateEmbedding } from "../embeddings";
import { addCalendarTools } from "./calendar-adapters";
import { addOperationalCaseTools } from "./operational-cases-adapters";
import {
  addRealEstateTools,
  type RealEstateToolDeps,
} from "./realestate-adapters";
import { executeBashCommand, getActiveShellName } from "./bashExec";
import {
  executeReadFile,
  executeWriteFile,
  executeEditFile,
} from "./fileTools";
import {
  executeBigQueryQuery,
  type BigQueryParamValue,
  type BigQueryRunArgs,
  type BigQueryRunResult,
} from "./bigquery-adapter";
import { readSkillReference } from "./skill-references";
import {
  LEGACY_GATEWAY_TOOL_IDS,
  buildLegacyGatewayTools,
  type LegacyGatewayDeps,
} from "./legacy-gateway-adapters";
import { defaultSkillsRoot } from "../skills/runtime";
import type { ToolContext } from "./tool-context";
import { createTrackedToolCall } from "./tool-call-audit";
import type {
  ToolApprovalMode,
  ToolApprovalPolicy,
  UserSkillSetting,
} from "@agents/types";
import {
  createSkillSelectorModel,
} from "../model";
import {
  getGlobalSkillRegistry,
} from "../skills/runtime";
import { selectSkillForTurn } from "../skills/select";
import { resolveSkill } from "../skills/resolve";
import type { ResolvedSkill } from "../skills/types";
import {
  listRuntimeAttachments,
  readRuntimeAttachment,
  RUNTIME_ATTACHMENT_TOOL_IDS,
  searchRuntimeAttachments,
} from "./runtime-attachments";

export type { ToolContext } from "./tool-context";
export { toolOwnsAuditTrail } from "./tool-audit-ownership";

type BigQueryToolInput = {
  sql: string;
  project_id?: string;
  location?: string;
  max_results?: number;
  params?: Record<string, BigQueryParamValue>;
};

const nullableOptional = <T extends z.ZodTypeAny>(schema: T) =>
  schema.nullish().transform((value) => value ?? undefined);

const emptyStringOptional = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess(
    (value) => (value === null || value === "" ? undefined : value),
    schema.optional()
  );

const optionalPositiveInt = (max: number) =>
  z.preprocess(
    (value) => (value === null || value === "" ? undefined : value),
    z.coerce.number().int().positive().max(max).optional()
  );

const optionalNonNegativeInt = () =>
  z.preprocess(
    (value) => (value === null || value === "" ? undefined : value),
    z.coerce.number().int().min(0).optional()
  );

/**
 * Normaliza un comando de shell para detectar duplicados "casi idénticos"
 * (mismas URLs y verbos, sólo cambian detalles cosméticos como `head -c <n>`,
 * presencia/ausencia de `echo` o whitespace).
 *
 * Estrategia: minúsculas, colapsa whitespace, normaliza `head -c <n>` y
 * palabras-ruido típicas. IMPORTANTE: no colapsamos `done.` y `done;` porque
 * el primero es un error de sintaxis y el segundo es la corrección — son
 * comandos semánticamente distintos.
 */
export function normalizeBashPromptForDedup(prompt: string): string {
  const lowered = prompt.toLowerCase();
  return lowered
    .replace(/\bhead\s+-c\s+\d+/g, "head -c N")
    .replace(/\btail\s+-c\s+\d+/g, "tail -c N")
    .replace(/\b(echo;?\s*)+/g, " ")
    .replace(/2>\s*\/dev\/null/g, "")
    .replace(/[\s]+/g, " ")
    .trim();
}

/**
 * Detecta errores de sintaxis obvios en un comando bash antes de ejecutarlo,
 * principalmente los que el LLM produce por copiar puntuación de un ejemplo
 * en español (p. ej. `... done.` con punto final), porque bash interpreta
 * `done.` como un comando llamado `done.` y nunca cierra el `for`/`while`,
 * resultando en "syntax error: unexpected end of file".
 *
 * Devuelve un mensaje en español apto para mostrar al modelo, o `null` si
 * no se detectó nada raro.
 */
export function detectObviousBashSyntaxIssue(prompt: string): string | null {
  const trimmed = prompt.trim();
  if (!trimmed) return null;
  // Trailing `done.` / `fi.` / `esac.` (Spanish-period leak from a sentence).
  if (/\b(done|fi|esac)\.\s*$/i.test(trimmed)) {
    return 'El comando termina en "done.", "fi." o "esac." con un punto. En bash el punto se interpreta como nombre de comando y deja el bloque sin cerrar (syntax error: unexpected end of file). Quita el punto final o sustitúyelo por ";".';
  }
  // Stand-alone `done.` / `fi.` / `esac.` mid-command (e.g. `done. echo ...`).
  if (/\b(done|fi|esac)\.[\s;]/i.test(trimmed)) {
    return 'Hay un "done.", "fi." o "esac." con punto en medio del comando. Bash trata el punto como parte del nombre y rompe la sintaxis. Quita el punto o reemplázalo por ";".';
  }
  // Unbalanced single quotes (rough check: odd count of "'" outside of "\"").
  const singleQuotes = (trimmed.match(/'/g) ?? []).length;
  if (singleQuotes % 2 === 1) {
    return "Hay un número impar de comillas simples (') en el comando. Verifica que cada comilla simple abierta esté cerrada.";
  }
  return null;
}

export function normalizeToolApprovalPolicy(
  value: unknown
): ToolApprovalPolicy | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const out: ToolApprovalPolicy = {};
  for (const [key, mode] of Object.entries(value)) {
    if (
      typeof key === "string" &&
      (mode === "auto_execute" ||
        mode === "request_approval" ||
        mode === "deny")
    ) {
      out[key] = mode;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function toolOperationPolicyKey(
  toolName: string,
  args: Record<string, unknown>
): string {
  if (toolName === "manage_scheduled_tasks") {
    const action = typeof args.action === "string" ? args.action.trim() : "";
    if (action) return `${toolName}:${action}`;
  }
  return toolName;
}

export function resolveToolApprovalMode(args: {
  toolName: string;
  toolArgs: Record<string, unknown>;
  requiresConfirmation: boolean;
  autoApproveTools?: boolean;
  policy?: ToolApprovalPolicy;
}): ToolApprovalMode {
  const operationKey = toolOperationPolicyKey(args.toolName, args.toolArgs);
  const explicit = args.policy?.[operationKey] ?? args.policy?.[args.toolName];
  if (explicit) return explicit;
  if (args.autoApproveTools && args.requiresConfirmation) return "auto_execute";
  return args.requiresConfirmation ? "request_approval" : "auto_execute";
}

function buildEnabledSkillCandidateSlugs(
  allSkillIds: readonly string[],
  settings?: readonly UserSkillSetting[]
): string[] {
  if (!settings || settings.length === 0) return [...allSkillIds];
  const enabledById = new Map(
    settings.map((setting) => [setting.skill_id, setting.enabled !== false])
  );
  return allSkillIds.filter((skillId) => enabledById.get(skillId) !== false);
}

function buildScheduledTaskToolPolicy(
  skill: ResolvedSkill | undefined
): ToolApprovalPolicy | undefined {
  if (!skill) return undefined;
  const allowed = new Set(skill.allowedTools);
  const policy: ToolApprovalPolicy = {};

  for (const toolDef of TOOL_CATALOG) {
    if (!allowed.has(toolDef.id)) {
      policy[toolDef.id] = "deny";
      continue;
    }
    if (toolDef.id === "manage_scheduled_tasks") {
      policy["manage_scheduled_tasks:list"] = "auto_execute";
      policy["manage_scheduled_tasks:pause"] = "request_approval";
      policy["manage_scheduled_tasks:resume"] = "request_approval";
      continue;
    }
    policy[toolDef.id] =
      getToolRisk(toolDef.id) === "low" ? "auto_execute" : "request_approval";
  }
  return policy;
}

async function inferScheduledTaskAutomationBinding(args: {
  prompt: string;
  enabledSkills?: readonly UserSkillSetting[];
}): Promise<{
  skillId: string | null;
  toolApprovalPolicy: ToolApprovalPolicy | null;
}> {
  try {
    const registry = await getGlobalSkillRegistry();
    const candidateSlugs = buildEnabledSkillCandidateSlugs(
      registry.list().map((skill) => skill.name),
      args.enabledSkills
    );
    const selection = await selectSkillForTurn({
      userMessage: args.prompt,
      registry,
      candidateSlugs,
      channel: "cron",
      model: createSkillSelectorModel(),
    });
    if (selection.kind !== "active") {
      return { skillId: null, toolApprovalPolicy: null };
    }
    const resolved = await resolveSkill(selection.skillId, registry);
    return {
      skillId: resolved.rootName,
      toolApprovalPolicy: buildScheduledTaskToolPolicy(resolved) ?? null,
    };
  } catch (err) {
    console.warn(
      "[scheduled-tasks] skill binding failed; task will run without forced skill:",
      err instanceof Error ? err.message : String(err)
    );
    return { skillId: null, toolApprovalPolicy: null };
  }
}

/**
 * Tenant hardening for `bigquery_run_query`.
 *
 * The company-data skill requires the tenant filter to be parameterized
 * (`u.organization_id = @organization_id` with `params.organization_id`).
 * LLMs sometimes inline the literal tenant id after reading the system
 * prompt. That is technically read-only, but it weakens auditability and
 * trains the wrong pattern. We reject that exact literal and let the model
 * retry with the parameterized form.
 *
 * If the model already used `@organization_id` but forgot `params`, we can
 * safely fill it from the trusted server-side Business Brain context.
 */
export function prepareBigQueryRunArgs(
  input: BigQueryToolInput,
  ctx: Pick<ToolContext, "tenantOrganizationId" | "lastUserMessage">
): BigQueryRunArgs | BigQueryRunResult {
  const tenantOrgId = ctx.tenantOrganizationId?.trim();
  if (!tenantOrgId) {
    return {
      sql: input.sql,
      projectId: input.project_id,
      location: input.location,
      maxResults: input.max_results,
      params: input.params,
    };
  }

  if (sqlContainsLiteral(input.sql, tenantOrgId)) {
    return {
      status: "validation_error",
      error:
        "tenant organization_id must be passed as a named parameter: use `u.organization_id = @organization_id` and `params: { organization_id: ... }` instead of inlining the literal value.",
    };
  }

  const params = { ...(input.params ?? {}) };
  if (sqlUsesNamedParam(input.sql, "organization_id") && params.organization_id == null) {
    params.organization_id = tenantOrgId;
  }

  const namedParams = listNamedParams(input.sql);
  if (namedParams.length > 0) {
    let missing = namedParams.filter((name) => params[name] == null);
    if (
      missing.length > 0 &&
      canAutofillMonthlyDateParams({
        missing,
        namedParams,
        lastUserMessage: ctx.lastUserMessage,
      })
    ) {
      const inferred = inferSingleSpanishMonthRange(ctx.lastUserMessage ?? "");
      if (inferred) {
        if (params.start_date == null) params.start_date = inferred.start_date;
        if (params.end_date == null) params.end_date = inferred.end_date;
        missing = namedParams.filter((name) => params[name] == null);
      }
    }
    if (missing.length > 0) {
      const monthlyHint =
        missing.includes("start_date") || missing.includes("end_date")
          ? " For month/range queries, pass both start_date and end_date (exclusive end) as ISO dates."
          : "";
      return {
        status: "validation_error",
        error:
          `missing named query parameter(s): ${missing
            .map((name) => `@${name}`)
            .join(", ")}. ` +
          "When SQL uses @params, include each one under `params` (without @), e.g. `params: { start_date: '2026-06-01', end_date: '2026-07-01' }`." +
          monthlyHint,
      };
    }
  }

  return {
    sql: input.sql,
    projectId: input.project_id,
    location: input.location,
    maxResults: input.max_results,
    params,
  };
}

type MissingMonthlyAutofillArgs = {
  missing: string[];
  namedParams: string[];
  lastUserMessage?: string;
};

function canAutofillMonthlyDateParams(args: MissingMonthlyAutofillArgs): boolean {
  if (!args.lastUserMessage?.trim()) return false;
  if (!args.namedParams.includes("start_date") || !args.namedParams.includes("end_date")) {
    return false;
  }
  if (args.missing.some((name) => name !== "start_date" && name !== "end_date")) {
    return false;
  }
  const text = args.lastUserMessage.toLowerCase();
  if (
    /\b(vs|versus|contra|compar|entre|del?\s+\d{1,2}|al?\s+\d{1,2}|desde|hasta|rango|trimestre|q[1-4])\b/i.test(
      text
    )
  ) {
    return false;
  }
  const months = uniqueSpanishMonthMentions(text);
  return months.size === 1;
}

const MONTH_ALIASES = new Map<string, number>([
  ["enero", 0],
  ["febrero", 1],
  ["marzo", 2],
  ["abril", 3],
  ["mayo", 4],
  ["junio", 5],
  ["julio", 6],
  ["agosto", 7],
  ["septiembre", 8],
  ["setiembre", 8],
  ["octubre", 9],
  ["noviembre", 10],
  ["diciembre", 11],
]);

function uniqueSpanishMonthMentions(text: string): Set<number> {
  const out = new Set<number>();
  const re =
    /\b(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\b/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const idx = MONTH_ALIASES.get(match[1].toLowerCase());
    if (idx != null) out.add(idx);
  }
  return out;
}

function inferSingleSpanishMonthRange(
  message: string,
  now = new Date()
): { start_date: string; end_date: string } | null {
  const text = message.toLowerCase();
  const months = uniqueSpanishMonthMentions(text);
  if (months.size !== 1) return null;
  const monthIndex = [...months][0];
  if (!Number.isInteger(monthIndex) || monthIndex < 0 || monthIndex > 11) {
    return null;
  }
  const yearMatches = text.match(/\b(20\d{2})\b/g) ?? [];
  const uniqueYears = [...new Set(yearMatches)];
  if (uniqueYears.length > 1) return null;
  const year =
    uniqueYears.length === 1
      ? Number.parseInt(uniqueYears[0], 10)
      : now.getUTCFullYear();
  if (!Number.isFinite(year) || year < 2000 || year > 2100) return null;
  const start = new Date(Date.UTC(year, monthIndex, 1));
  const end = new Date(Date.UTC(year, monthIndex + 1, 1));
  return {
    start_date: formatIsoDate(start),
    end_date: formatIsoDate(end),
  };
}

function formatIsoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function sqlUsesNamedParam(sql: string, name: string): boolean {
  return new RegExp(`@${name}(?![A-Za-z0-9_])`, "i").test(sql);
}

function listNamedParams(sql: string): string[] {
  const codeOnly = stripSqlCommentsAndLiterals(sql);
  const out = new Set<string>();
  const re = /@([A-Za-z_][A-Za-z0-9_]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(codeOnly)) !== null) {
    out.add(m[1]);
  }
  return [...out];
}

function stripSqlCommentsAndLiterals(sql: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i] ?? "";
    const next = sql[i + 1] ?? "";

    if (ch === "-" && next === "-") {
      out.push(" ", " ");
      i += 2;
      while (i < sql.length && sql[i] !== "\n") {
        out.push(" ");
        i += 1;
      }
      continue;
    }

    if (ch === "/" && next === "*") {
      out.push(" ", " ");
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) {
        out.push(sql[i] === "\n" ? "\n" : " ");
        i += 1;
      }
      if (i < sql.length) {
        out.push(" ", " ");
        i += 2;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      const quote = ch;
      const triple = sql.slice(i, i + 3) === quote.repeat(3);
      out.push(" ");
      i += 1;
      if (triple) {
        out.push(" ", " ");
        i += 2;
        while (i < sql.length && sql.slice(i, i + 3) !== quote.repeat(3)) {
          out.push(sql[i] === "\n" ? "\n" : " ");
          i += 1;
        }
        if (i < sql.length) {
          out.push(" ", " ", " ");
          i += 3;
        }
      } else {
        while (i < sql.length) {
          if (sql[i] === "\\" && i + 1 < sql.length) {
            out.push(" ", " ");
            i += 2;
            continue;
          }
          if (sql[i] === quote && sql[i + 1] === quote) {
            out.push(" ", " ");
            i += 2;
            continue;
          }
          if (sql[i] === quote) {
            out.push(" ");
            i += 1;
            break;
          }
          out.push(sql[i] === "\n" ? "\n" : " ");
          i += 1;
        }
      }
      continue;
    }

    out.push(ch);
    i += 1;
  }
  return out.join("");
}

function sqlContainsLiteral(sql: string, literal: string): boolean {
  const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(['"])${escaped}\\1`).test(sql);
}

const MEMORY_SEARCH_STOPWORDS = new Set([
  "que",
  "qué",
  "sabes",
  "saber",
  "sobre",
  "recuerdas",
  "recuerdo",
  "recuerdos",
  "memoria",
  "memorias",
  "de",
  "del",
  "la",
  "el",
  "los",
  "las",
  "mi",
  "mis",
  "me",
  "acerca",
]);

function normalizeMemorySearchText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function memorySearchTerms(query: string): string[] {
  const normalized = normalizeMemorySearchText(query);
  return normalized
    .split(" ")
    .filter((term) => term.length >= 3 && !MEMORY_SEARCH_STOPWORDS.has(term));
}

function looksLikeNamedEntityQuery(query: string, terms: string[]): boolean {
  if (terms.length === 0) return false;
  const rawTokens = query
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3);
  const capitalizedTokens = rawTokens.filter((token) =>
    /^\p{Lu}/u.test(token)
  );
  // One capitalized non-stopword ("Alebrixe") or a two-token proper name
  // ("Julieta Evelia") should not return generic semantic neighbors.
  return capitalizedTokens.length > 0 && capitalizedTokens.length >= Math.min(2, terms.length);
}

function memoryContentMatchesAllTerms(content: string, terms: string[]): boolean {
  const normalized = normalizeMemorySearchText(content);
  return terms.every((term) => normalized.includes(term));
}

const MEMORY_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function invalidMemoryIdResult(memoryId: string): string | null {
  if (MEMORY_ID_RE.test(memoryId)) return null;
  return JSON.stringify({
    status: "validation_error",
    message:
      "memory_id must be a full UUID returned by list_user_memories or search_user_memories. Do not invent ids or use shortened prefixes.",
    memory_id: memoryId,
  });
}

function isToolAvailable(toolId: string, ctx: ToolContext): boolean {
  const isRuntimeAttachmentTool = RUNTIME_ATTACHMENT_TOOL_IDS.has(toolId);
  const hasSkillScopedRuntimeAttachments =
    isRuntimeAttachmentTool &&
    Boolean(ctx.activeSkillName) &&
    (ctx.runtimeInput?.attachments.length ?? 0) > 0;
  const setting = ctx.enabledTools.find((t) => t.tool_id === toolId);
  if (!setting?.enabled && !hasSkillScopedRuntimeAttachments) return false;

  if (ctx.toolApprovalPolicy?.[toolId] === "deny") {
    return false;
  }

  // Skill-aware narrowing (V1-B): when the pre-graph selector picked a skill
  // for this turn, the tool list is intersected with that skill's
  // `allowed_tools`. When no skill is active, this check is a no-op and the
  // filtering below behaves exactly as it did before V1-B.
  if (
    Array.isArray(ctx.activeSkillAllowedTools) &&
    ctx.activeSkillAllowedTools.length > 0 &&
    !ctx.activeSkillAllowedTools.includes(toolId) &&
    !hasSkillScopedRuntimeAttachments
  ) {
    return false;
  }

  // Cron channel: a scheduled task should never schedule itself again or
  // mutate other scheduled tasks. Listing remains safe (read-only).
  if (
    ctx.channel === "cron" &&
    (toolId === "schedule_task")
  ) {
    return false;
  }

  // Heartbeat channel is proactive and must stay read-only in V1.
  // We fail closed with a strict allowlist instead of relying only on risk.
  if (ctx.channel === "heartbeat") {
    const HEARTBEAT_ALLOWED_TOOLS = new Set<string>([
      "get_user_preferences",
      "list_enabled_tools",
      "read_skill_reference",
      "list_user_memories",
      "search_user_memories",
      "github_list_repos",
      "github_list_issues",
      "calendar_list_calendars",
      "calendar_list_events",
      "calendar_list_tasks",
      "manage_scheduled_tasks",
      "read_file",
    ]);
    // BigQuery requires a domain skill and tenant-aware references. Heartbeat
    // can use it only after a heartbeat-safe tenant skill was injected.
    if (
      toolId === "bigquery_run_query" &&
      ctx.activeSkillAllowedTools?.includes("bigquery_run_query") &&
      ctx.tenantOrganizationId
    ) {
      return true;
    }
    if (!HEARTBEAT_ALLOWED_TOOLS.has(toolId)) return false;
  }

  if (toolId === "bash" && process.env.BASH_TOOL_ENABLED !== "true") {
    return false;
  }

  // R1 SL-1: the Traditional Gu read capabilities are inert unless the global
  // kill-switch is on. The gateway checks this again internally, per read; this
  // is the surface half, so a disabled gateway is not even offered to a model.
  if (
    LEGACY_GATEWAY_TOOL_IDS.includes(toolId as (typeof LEGACY_GATEWAY_TOOL_IDS)[number]) &&
    process.env.LEGACY_GATEWAY_ENABLED !== "true"
  ) {
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
          const record = await createTrackedToolCall(ctx, "read_skill_reference",
            input,
            false);
          const result = await readSkillReference({
            name: input.name,
            activeSkillName: ctx.activeSkillName,
            referenceSkillNames: ctx.activeSkillReferenceNames,
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
            "Reads ONE reference file from the currently-active skill or one of its included skills and returns its content. Use this when the active skill's body points you to a reference (e.g. 'see references/schema.md for the full table list'). Pass only the filename stem (without extension), e.g. `schema`, `joins`, `glossary`, `fewshots-leads`. Returns `status='no_active_skill'` if no skill is selected for this turn (do NOT call it then). Returns `status='not_found'` if the file does not exist in the active skill or included skills (do NOT retry; the SKILL.md body lists what is available).",
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
          const record = await createTrackedToolCall(ctx, "bigquery_run_query",
            input,
            false);
          const prepared = prepareBigQueryRunArgs(input, ctx);
          const result =
            "status" in prepared
              ? prepared
              : await executeBigQueryQuery(prepared);
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
            project_id: nullableOptional(z.string().min(1)),
            location: nullableOptional(z.string().min(1)),
            max_results: optionalPositiveInt(1000),
            params: nullableOptional(
              z.record(z.union([z.string(), z.number(), z.boolean()]))
            ),
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

  if (isToolAvailable("list_runtime_attachments", ctx)) {
    tools.push(
      tool(
        async () => {
          const record = await createTrackedToolCall(
            ctx,
            "list_runtime_attachments",
            {},
            false
          );
          const result = listRuntimeAttachments(ctx.runtimeInput);
          await updateToolCallStatus(ctx.db, record.id, "executed", result);
          return JSON.stringify(result);
        },
        {
          name: "list_runtime_attachments",
          description:
            "Lists metadata, attachment_id, hash, and provenance for files attached to this turn. It never returns storage coordinates.",
          schema: z.object({}),
        }
      )
    );
  }

  if (isToolAvailable("read_runtime_attachment", ctx)) {
    tools.push(
      tool(
        async (input: { attachment_id: string; max_chars?: number }) => {
          const record = await createTrackedToolCall(
            ctx,
            "read_runtime_attachment",
            input,
            false
          );
          const result = readRuntimeAttachment(ctx.runtimeInput, {
            attachmentId: input.attachment_id,
            maxChars: input.max_chars,
          });
          await updateToolCallStatus(
            ctx.db,
            record.id,
            result.status === "ok" ? "executed" : "failed",
            result as unknown as Record<string, unknown>
          );
          return JSON.stringify(result);
        },
        {
          name: "read_runtime_attachment",
          description:
            "Reads bounded extracted text for one attachment_id from this turn. Cannot access storage URLs, paths, other turns, or other users.",
          schema: z.object({
            attachment_id: z.string().min(1).max(128),
            max_chars: optionalPositiveInt(12_000),
          }),
        }
      )
    );
  }

  if (isToolAvailable("search_runtime_attachments", ctx)) {
    tools.push(
      tool(
        async (input: {
          query: string;
          attachment_id?: string;
          max_results?: number;
        }) => {
          const record = await createTrackedToolCall(
            ctx,
            "search_runtime_attachments",
            input,
            false
          );
          const result = searchRuntimeAttachments(ctx.runtimeInput, {
            query: input.query,
            attachmentId: input.attachment_id,
            maxResults: input.max_results,
          });
          await updateToolCallStatus(
            ctx.db,
            record.id,
            result.status === "ok" ? "executed" : "failed",
            result as unknown as Record<string, unknown>
          );
          return JSON.stringify(result);
        },
        {
          name: "search_runtime_attachments",
          description:
            "Literal bounded search over extracted text for files attached to this turn. Results include provenance and bounded snippets.",
          schema: z.object({
            query: z.string().min(1).max(500),
            attachment_id: emptyStringOptional(z.string().min(1).max(128)),
            max_results: optionalPositiveInt(20),
          }),
        }
      )
    );
  }

  // ── Long-term memory curation (skill `memory-curate`) ──────
  // Read tools (list/search) ejecutan directo. Write tools (archive/delete)
  // tienen risk medium/high → el grafo dispara HITL antes de invocarlas;
  // cuando el handler corre, ya hay aprobación del usuario.

  if (isToolAvailable("list_user_memories", ctx)) {
    tools.push(
      tool(
        async (input) => {
          const record = await createTrackedToolCall(ctx, "list_user_memories",
            input,
            false);
          try {
            const limit = Math.min(
              Math.max(1, Math.floor(input.limit ?? 25)),
              100
            );
            const result = await listMemories(ctx.db, {
              userId: ctx.userId,
              type: input.type,
              status: input.status ?? "active",
              q: input.q,
              limit,
              offset: input.offset ?? 0,
            });
            const payload = {
              status: "ok" as const,
              total: result.total,
              count: result.rows.length,
              rows: result.rows.map((r) => ({
                id: r.id,
                type: r.type,
                content: r.content,
                created_at: r.created_at,
                last_retrieved_at: r.last_retrieved_at,
                retrieval_count: r.retrieval_count,
                archived_at: r.archived_at,
              })),
            };
            await updateToolCallStatus(
              ctx.db,
              record.id,
              "executed",
              payload as unknown as Record<string, unknown>
            );
            return JSON.stringify(payload);
          } catch (err) {
            const error = {
              status: "error" as const,
              message: err instanceof Error ? err.message : String(err),
            };
            await updateToolCallStatus(ctx.db, record.id, "failed", error);
            return JSON.stringify(error);
          }
        },
        {
          name: "list_user_memories",
          description:
            "Lists the user's own long-term memories. Default status='active'. Use to triage what's saved before deciding what to forget. Read-only.",
          schema: z.object({
            type: emptyStringOptional(
              z.enum(["episodic", "semantic", "procedural"]) as z.ZodEnum<
                [MemoryType, ...MemoryType[]]
              >
            ),
            status: emptyStringOptional(z.enum(["active", "archived", "all"])),
            q: emptyStringOptional(z.string().min(1).max(200)),
            limit: optionalPositiveInt(100),
            offset: optionalNonNegativeInt(),
          }),
        }
      )
    );
  }

  if (isToolAvailable("search_user_memories", ctx)) {
    tools.push(
      tool(
        async (input) => {
          const record = await createTrackedToolCall(ctx, "search_user_memories",
            input,
            false);
          try {
            const limit = Math.min(
              Math.max(1, Math.floor(input.limit ?? 8)),
              20
            );
            const embedding = await generateEmbedding(input.query);
            const matches = await searchMemories(ctx.db, {
              userId: ctx.userId,
              embedding,
              limit,
              matchThreshold: 0.3,
            });
            const terms = memorySearchTerms(input.query);
            const requireLexicalMatch = looksLikeNamedEntityQuery(
              input.query,
              terms
            );
            const filteredMatches = requireLexicalMatch
              ? matches.filter((m) => memoryContentMatchesAllTerms(m.content, terms))
              : matches;
            const payload = {
              status: "ok" as const,
              count: filteredMatches.length,
              query: input.query,
              require_lexical_match: requireLexicalMatch,
              discarded_semantic_matches: matches.length - filteredMatches.length,
              matches: filteredMatches.map((m) => ({
                id: m.id,
                type: m.type,
                content: m.content,
                similarity: m.similarity,
                retrieval_count: m.retrieval_count,
              })),
            };
            await updateToolCallStatus(
              ctx.db,
              record.id,
              "executed",
              payload as unknown as Record<string, unknown>
            );
            return JSON.stringify(payload);
          } catch (err) {
            const error = {
              status: "error" as const,
              message: err instanceof Error ? err.message : String(err),
            };
            await updateToolCallStatus(ctx.db, record.id, "failed", error);
            return JSON.stringify(error);
          }
        },
        {
          name: "search_user_memories",
          description:
            "Semantic search over the user's own memories. Use with a free-text query when the user asks about a topic and you want to surface related saved facts. Returns ranked matches (higher similarity = closer). Read-only.",
          schema: z.object({
            query: z.string().min(1).max(500),
            limit: optionalPositiveInt(20),
          }),
        }
      )
    );
  }

  if (isToolAvailable("archive_user_memory", ctx)) {
    tools.push(
      tool(
        async (input) => {
          // Nota: el grafo ya pidió confirmación HITL antes de llegar acá
          // (risk='medium' → toolRequiresConfirmation=true).
          const invalidId = invalidMemoryIdResult(input.memory_id);
          if (invalidId) return invalidId;
          const snapshot = await getMemoryById(ctx.db, {
            userId: ctx.userId,
            memoryId: input.memory_id,
          });
          if (!snapshot) {
            return JSON.stringify({
              status: "not_found",
              message: "memory not found or not owned by user",
            });
          }
          if (snapshot.archived_at) {
            return JSON.stringify({
              status: "already_archived",
              memory: { id: snapshot.id, content: snapshot.content },
            });
          }
          const archived = await archiveMemory(ctx.db, {
            userId: ctx.userId,
            memoryId: input.memory_id,
          });
          await logMemoryAction(ctx.db, {
            userId: ctx.userId,
            memoryId: input.memory_id,
            action: "archive",
            details: {
              channel: "agent",
              snapshot: { type: snapshot.type, content: snapshot.content },
            },
          });
          return JSON.stringify({
            status: "ok",
            archived,
            memory: { id: snapshot.id, content: snapshot.content },
          });
        },
        {
          name: "archive_user_memory",
          description:
            "Archives ONE memory (soft-delete reversible). Reversible from /memory UI or restore_user_memory. Requires confirmation (handled by HITL).",
          schema: z.object({
            memory_id: z.string().min(1),
          }),
        }
      )
    );
  }

  if (isToolAvailable("delete_user_memory", ctx)) {
    tools.push(
      tool(
        async (input) => {
          const invalidId = invalidMemoryIdResult(input.memory_id);
          if (invalidId) return invalidId;
          const snapshot = await getMemoryById(ctx.db, {
            userId: ctx.userId,
            memoryId: input.memory_id,
          });
          if (!snapshot) {
            return JSON.stringify({
              status: "not_found",
              message: "memory not found or not owned by user",
            });
          }
          // Loguear ANTES del delete para preservar snapshot.
          await logMemoryAction(ctx.db, {
            userId: ctx.userId,
            memoryId: null,
            action: "delete",
            details: {
              channel: "agent",
              deletedId: snapshot.id,
              snapshot: { type: snapshot.type, content: snapshot.content },
            },
          });
          const deleted = await deleteMemory(ctx.db, {
            userId: ctx.userId,
            memoryId: input.memory_id,
          });
          return JSON.stringify({
            status: "ok",
            deleted,
            memory: { id: snapshot.id, content: snapshot.content },
          });
        },
        {
          name: "delete_user_memory",
          description:
            "PERMANENTLY DELETES one memory. NOT reversible. Prefer archive_user_memory unless the user explicitly asks for permanent deletion. Requires confirmation (handled by HITL).",
          schema: z.object({
            memory_id: z.string().min(1),
          }),
        }
      )
    );
  }

  // ── GitHub read tools ──────────────────────────────────────

  if (isToolAvailable("github_list_repos", ctx)) {
    tools.push(
      tool(
        async (input) => {
          const record = await createTrackedToolCall(ctx, "github_list_repos",
            input,
            false);

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
          const record = await createTrackedToolCall(ctx, "github_list_issues",
            input,
            false);

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
    // Per-turn de-duplication and adaptive rate-limit for bash calls.
    //
    // Why a wrapper? The cron channel runs without a human in the loop and
    // historically has fallen into either:
    //   (a) Retrying the same curl with tiny cosmetic variations even when
    //       the first call already returned enough stdout. (Cap-based fix.)
    //   (b) Failing genuinely (e.g. syntax errors copied from the prompt
    //       example) and needing a few real retries to land on a valid
    //       command. (We must NOT block these.)
    //
    // Adaptive policy:
    //   - At most one *successful* bash call per turn. Once we've seen a call
    //     with `exitCode === 0` AND stdout ≥ 200 bytes, every subsequent
    //     bash call is short-circuited to a synthetic result instructing the
    //     model to use the data it already has.
    //   - When all calls so far failed (exitCode != 0 or empty stdout), we
    //     allow up to MAX_FAILED_ATTEMPTS *substantively different* calls so
    //     the model can recover from prompt-syntax bugs and similar issues.
    //   - Cosmetic duplicates (after normalization) are always blocked,
    //     regardless of cap.
    //   - We also pre-flight obvious syntax errors (e.g. trailing `done.`)
    //     and surface them as a synthetic stderr so the model gets a clear
    //     hint *without* spawning the shell.
    const turnState = {
      successfulCalls: 0,
      failedAttempts: 0,
      seen: new Map<
        string,
        { exitCode: number; stdoutBytes: number; resultJson: string }
      >(),
    };
    const isCronChannel = ctx.channel === "cron";
    const MAX_FAILED_ATTEMPTS = isCronChannel ? 3 : 6;
    const SUCCESS_STDOUT_BYTES = 200;

    tools.push(
      tool(
        async (input: { terminal?: string; prompt: string }) => {
          const promptText = input.prompt ?? "";
          const terminal = input.terminal?.trim() || "default";
          const normalizedKey = normalizeBashPromptForDedup(promptText);
          const previous = turnState.seen.get(normalizedKey);

          // 1) Cosmetic duplicate: short-circuit with the previous result.
          if (previous) {
            const synthetic = {
              terminal,
              stdout: "",
              stderr: "",
              exitCode: previous.exitCode,
              shell: getActiveShellName(),
              error: `[bash-runtime] Misma instrucción ya ejecutada en este turno (exitCode=${previous.exitCode}, stdout=${previous.stdoutBytes} bytes). No se repite. Si la primera tuvo stdout suficiente, redacta la respuesta final con esos datos; si fue insuficiente, prueba una fuente o endpoint distintos en lugar de variar este mismo comando.`,
              previousResult: JSON.parse(previous.resultJson),
            };
            return JSON.stringify(synthetic);
          }

          // 2) Already had a successful call: stop further bash work.
          if (turnState.successfulCalls > 0) {
            const synthetic = {
              terminal,
              stdout: "",
              stderr: "",
              exitCode: -1,
              shell: getActiveShellName(),
              error: `[bash-runtime] Ya tienes una llamada bash exitosa en este turno con stdout útil. No se ejecutarán más comandos: redacta la respuesta final con esos datos.`,
            };
            return JSON.stringify(synthetic);
          }

          // 3) Cap on failed attempts (only when nothing has worked yet).
          if (turnState.failedAttempts >= MAX_FAILED_ATTEMPTS) {
            const synthetic = {
              terminal,
              stdout: "",
              stderr: "",
              exitCode: -1,
              shell: getActiveShellName(),
              error: `[bash-runtime] Se agotaron los ${MAX_FAILED_ATTEMPTS} intentos de bash sin obtener stdout útil. Responde explicando honestamente que no fue posible recuperar la información en este turno; no inventes contenido.`,
            };
            return JSON.stringify(synthetic);
          }

          // 4) Pre-flight syntax check for the most common LLM mistakes.
          //    Importante: NO guardamos esto en `seen` — el modelo debe poder
          //    reintentar con la corrección sin que el dedup lo bloquee.
          const syntaxIssue = detectObviousBashSyntaxIssue(promptText);
          if (syntaxIssue) {
            turnState.failedAttempts += 1;
            const synthetic = {
              terminal,
              stdout: "",
              stderr: `bash pre-flight: ${syntaxIssue}`,
              exitCode: 2,
              shell: getActiveShellName(),
              error: `[bash-runtime] No se ejecutó: ${syntaxIssue} Reescribe el comando sin esos errores y reintenta.`,
            };
            return JSON.stringify(synthetic);
          }

          const result = await executeBashCommand({
            terminal,
            prompt: promptText,
          });
          const resultJson = JSON.stringify(result);
          const stdoutBytes = (result.stdout ?? "").length;
          const isSuccess =
            result.exitCode === 0 && stdoutBytes >= SUCCESS_STDOUT_BYTES;
          if (isSuccess) {
            turnState.successfulCalls += 1;
          } else {
            turnState.failedAttempts += 1;
          }
          turnState.seen.set(normalizedKey, {
            exitCode: result.exitCode,
            stdoutBytes,
            resultJson,
          });
          return resultJson;
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
          const record = await createTrackedToolCall(ctx, "read_file",
            input,
            false);
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
            offset: optionalNonNegativeInt(),
            limit: optionalPositiveInt(5000),
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
          display_title?: string;
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

          const automationBinding = await inferScheduledTaskAutomationBinding({
            prompt: input.prompt,
            enabledSkills: ctx.enabledSkills,
          });

          // `ctx.lastUserMessage` queda vacío en el resume HITL (la ruta
          // `/api/chat/confirm` no recibe el mensaje original). Para no perder
          // el texto que originó la confirmación, lo recuperamos de
          // `agent_messages` por `turn_id`. Best-effort: si la query falla,
          // dejamos `null` y la fila queda como antes.
          let userRequest: string | null =
            ctx.lastUserMessage?.trim() || null;
          if (!userRequest && ctx.turnId) {
            try {
              const { data } = await ctx.db
                .from("agent_messages")
                .select("content")
                .eq("session_id", ctx.sessionId)
                .eq("turn_id", ctx.turnId)
                .eq("role", "user")
                .order("created_at", { ascending: false })
                .limit(1)
                .maybeSingle();
              const content = (data?.content as string | undefined)?.trim();
              if (content) userRequest = content;
            } catch (err) {
              console.warn(
                "[schedule_task] failed to recover user_request from agent_messages:",
                err instanceof Error ? err.message : String(err)
              );
            }
          }

          const task = await createScheduledTask(ctx.db, {
            userId: ctx.userId,
            prompt: input.prompt,
            userRequest,
            displayTitle: input.display_title?.trim() || null,
            skillId: automationBinding.skillId,
            toolApprovalPolicy: automationBinding.toolApprovalPolicy,
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
            user_request: task.user_request,
            display_title: task.display_title,
            skill_id: task.skill_id ?? null,
            tool_approval_policy: task.tool_approval_policy ?? null,
          });
        },
        {
          name: "schedule_task",
          description:
            "Programs a task (prompt) to run automatically at a future time (one_time) or on a recurring schedule. Result is sent to Telegram by default. Requires confirmation before scheduling.",
          schema: z.object({
            prompt: z.string().min(1),
            display_title: z
              .string()
              .min(1)
              .max(120)
              .optional()
              .describe(
                "Short human-friendly title for UI lists, e.g. 'Revisar leads los lunes'. Optional; do not include schedule mechanics unless useful."
              ),
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
          const record = await createTrackedToolCall(ctx, "manage_scheduled_tasks",
            input,
            false);

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
            if (ctx.channel === "heartbeat") {
              const err = {
                ok: false,
                error:
                  "Heartbeat solo puede listar tareas programadas; pause/resume requiere una acción manual o programada fuera del Heartbeat.",
              };
              await updateToolCallStatus(ctx.db, record.id, "failed", err);
              return JSON.stringify(err);
            }

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
            let nextRunAt: string | null | undefined;
            if (input.action === "resume") {
              const task = await getScheduledTaskForUser(
                ctx.db,
                input.task_id,
                ctx.userId
              );
              if (!task || task.status !== "paused") {
                const err = {
                  ok: false,
                  error:
                    "No se encontró una tarea pausada con ese id. Vuelve a listar las tareas antes de reanudar.",
                };
                await updateToolCallStatus(ctx.db, record.id, "failed", err);
                return JSON.stringify(err);
              }
              if (task.schedule_type === "one_time") {
                const scheduledAt = task.next_run_at ?? task.run_at;
                if (!scheduledAt || new Date(scheduledAt).getTime() <= Date.now()) {
                  const err = {
                    ok: false,
                    error:
                      "Esta tarea de una sola vez ya tiene fecha pasada. Pide al usuario programar una nueva tarea si quiere ejecutarla otra vez.",
                  };
                  await updateToolCallStatus(ctx.db, record.id, "failed", err);
                  return JSON.stringify(err);
                }
                nextRunAt = scheduledAt;
              } else {
                if (!task.cron_expr) {
                  const err = {
                    ok: false,
                    error: "La tarea recurrente no tiene cron_expr configurado.",
                  };
                  await updateToolCallStatus(ctx.db, record.id, "failed", err);
                  return JSON.stringify(err);
                }
                try {
                  const cron = new Cron(task.cron_expr, { timezone: task.timezone });
                  const next = cron.nextRun();
                  if (!next) throw new Error("sin próxima ejecución");
                  nextRunAt = next.toISOString();
                } catch {
                  const err = {
                    ok: false,
                    error:
                      "No se pudo calcular la próxima ejecución recurrente. Revisa el cron_expr de la tarea.",
                  };
                  await updateToolCallStatus(ctx.db, record.id, "failed", err);
                  return JSON.stringify(err);
                }
              }
            }
            const updated = await setScheduledTaskStatus(ctx.db, {
              taskId: input.task_id,
              userId: ctx.userId,
              newStatus,
              nextRunAt,
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

  // Operational cases tools (operational_case_update_state,
  // operational_case_add_event, notify_user). Visibles cuando la skill
  // activa las allowliste o cuando el caller las habilita por user_tool_settings.
  // Las deps las inyecta el wiring de runAgent (ver buildLangChainTools deps).
  if (toolWiringDeps) {
    addOperationalCaseTools(ctx, tools, {
      notifyUser: toolWiringDeps.notifyUser,
    });
    addRealEstateTools(ctx, tools, {
      sendTelegramMessage: toolWiringDeps.sendTelegramMessage,
      sendGmailMessage: toolWiringDeps.sendGmailMessage,
      notifyUser: toolWiringDeps.notifyUser,
    });
  }

  // ── Traditional Gu bounded reads (R1 SL-1 / TD-5) ──────────────────
  tools.push(
    ...buildLegacyGatewayTools(
      ctx,
      toolWiringDeps?.legacyGateway ?? null,
      (toolId) => isToolAvailable(toolId, ctx)
    )
  );

  return tools;
}

/**
 * Dependencias inyectables para tools que requieren funciones que viven en
 * `apps/web` (no podemos hacer import directo desde packages/agent porque
 * romperíamos la dirección de dependencias). El caller de buildLangChainTools
 * registra estas deps via setBuildLangChainToolsDeps() ANTES de la primera
 * invocación de runAgent.
 *
 * Si no se registran, las tools que las requieren responden
 * `{ status: "not_configured" }` con un hint en vez de fallar el turno.
 */
export interface BuildLangChainToolsDeps {
  notifyUser: import("./operational-cases-adapters").NotifyUserFn;
  sendTelegramMessage: NonNullable<RealEstateToolDeps["sendTelegramMessage"]>;
  sendGmailMessage: NonNullable<RealEstateToolDeps["sendGmailMessage"]>;
  /**
   * R1 SL-1 bounded legacy reads. Optional: an environment that has not wired
   * the gateway answers `not_configured` instead of failing a turn.
   */
  legacyGateway?: LegacyGatewayDeps;
}

let toolWiringDeps: BuildLangChainToolsDeps | null = null;

export function setBuildLangChainToolsDeps(
  deps: BuildLangChainToolsDeps | null
): void {
  toolWiringDeps = deps;
}

export function getBuildLangChainToolsDeps(): BuildLangChainToolsDeps | null {
  return toolWiringDeps;
}
