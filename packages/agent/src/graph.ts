import {
  StateGraph,
  interrupt,
  Command,
  type StreamMode,
} from "@langchain/langgraph";
import { randomUUID } from "node:crypto";
import {
  HumanMessage,
  AIMessage,
  SystemMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { DbClient } from "@agents/db";
import {
  getSessionMessages,
  addMessage,
  createToolCall,
  findExistingPendingToolCall,
  updateToolCallStatus,
  getMemoryById,
  getOperationalCase,
  getOperationalCaseTypeById,
  getRecentOperationalCaseEvents,
} from "@agents/db";
import type {
  UserToolSetting,
  UserSkillSetting,
  UserIntegration,
  PendingConfirmation,
  BusinessBrain,
  AgentMessage,
  AppliedSkill,
  AppliedMemory,
  ToolApprovalPolicy,
  ToolCallSource,
} from "@agents/types";
import {
  generatedDocumentDedupKey,
  normalizeTelegramSendText,
} from "@agents/types";
import {
  CHAT_MODEL_ID,
  createChatModel,
  createCompactionModel,
  createSkillSelectorModel,
  DEFAULT_CRON_TEMPERATURE,
  DEFAULT_HEARTBEAT_TEMPERATURE,
  DEFAULT_INTERACTIVE_TEMPERATURE,
} from "./model";
import {
  buildLangChainTools,
  resolveToolApprovalMode,
  toolOwnsAuditTrail,
} from "./tools/adapters";
import { buildToolCallMetadata } from "./tools/tool-call-audit";
import {
  getGlobalSkillRegistry,
  getSkillRegistryForUser,
  buildPlaybookInjection,
  getCachedSkillsRegistryRoot,
} from "./skills/runtime";
import { selectSkillForTurn } from "./skills/select";
import {
  isShortMonthPeriodFollowUp,
  recentMessagesSuggestCompanyData,
} from "./skills/month-followup";
import { turnHasLeadIdentifier } from "./skills/lead-followup-intent";
import { isPropertyOptioningIntent } from "./skills/property-optioning-intent";
import {
  deriveSkillRoutingContext,
  shouldRouteFromContinuity,
} from "./skills/routing-context";
import { sanitizeCompanyDataHistory } from "./skills/sanitize-history";
import { resolveSkill } from "./skills/resolve";
import type { ResolvedSkill } from "./skills/types";
import { appendTenantContextBlock } from "./business-brain/tenant-context";
import { appendBusinessBrainContextBlock } from "./business-brain/compiler";
import { getBusinessBrainWarehouse } from "./business-brain/schema";
import { toolRequiresConfirmation } from "./tools/catalog";
import { userMessageIsScheduleIntent } from "./tools/schedule-intent";
import { getCheckpointer } from "./checkpointer";
import { GraphState, type GraphStateType } from "./state";
import { createCompactionNode } from "./nodes/compaction_node";
import { createMemoryInjectionNode } from "./nodes/memory_injection_node";
import {
  approxTokensFromChars,
  writeTurnSummary,
  type TurnSummaryInput,
} from "./turn_log";

export interface AgentInput {
  message?: string;
  /** Correlates all persisted messages/tool calls created during this user turn. */
  turnId?: string;
  userId: string;
  sessionId: string;
  systemPrompt: string;
  db: DbClient;
  enabledTools: UserToolSetting[];
  enabledSkills?: UserSkillSetting[];
  integrations: UserIntegration[];
  githubToken?: string;
  /** Profile timezone for interpreting/creating calendar events. */
  userTimezone?: string;
  /**
   * Profile display name (`profiles.name`). Canonical; when present, the
   * agent knows who the user is without asking or relying on long-term memory.
   */
  userName?: string | null;
  /**
   * Profile email (from `profiles.email`). Canonical; when present, the agent
   * knows it without asking the user. Not extracted to long-term memory.
   * Pass `null`/`undefined` if the profile has no email set.
   */
  userEmail?: string | null;
  /** Profile phone (from `profiles.phone`). Same policy as `userEmail`. */
  userPhone?: string | null;
  /**
   * Canal de origen del turno. Sólo informativo (para logs / dashboard
   * ejecutivo). No altera la lógica de runAgent. Si no se provee, se
   * infiere: `autoApproveTools=true` → "cron"; de lo contrario "web".
   */
  channel?: "web" | "telegram" | "cron" | "heartbeat" | "case_runner";
  googleCalendarAccessToken?: string;
  resumeDecision?: "approve" | "reject";
  /** Must match the thread_id used when the interrupt was created. */
  checkpointThreadId?: string;
  /**
   * When true, the agent skips HITL interrupts and executes risky tools directly.
   * Intended for the cron runner of `schedule_task` (the user already approved
   * the scheduling, so inner tools should not require a second confirmation).
   */
  autoApproveTools?: boolean;
  /**
   * Per-tool/per-operation policy for automated turns. When present it takes
   * precedence over the coarse `autoApproveTools` boolean.
   */
  toolApprovalPolicy?: ToolApprovalPolicy;
  /** Force a specific skill for this run (e.g. persisted scheduled task skill). */
  forcedSkillId?: string | null;
  /**
   * Operational case binding. Cuando se provee, runAgent:
   *   1. Lee operational_cases + últimos eventos y los inyecta en el system
   *      prompt como "[Caso operacional]".
   *   2. Hace BINDING DIRECTO al `default_skill_slug` del case_type (salta
   *      el selector libre). Si la skill no existe, hace fallback al
   *      selector normal con un warning.
   * Pensado para el cron `/api/cron/operational-cases` que invoca el agente
   * en canal `case_runner`.
   */
  caseId?: string | null;
  /** Stored on tool_calls.metadata_jsonb.source (defaults from channel). */
  toolCallSource?: ToolCallSource;
  /**
   * V1-C-α: Business Brain del perfil. Se materializa en el bloque
   * `[Contexto de tenant]` cuando la skill activa pide
   * `requires_tenant_context: true`. Si no se provee, se asume `{}` (modo
   * "no configurado" para usuarios regulares).
   */
  businessBrain?: BusinessBrain;
  /**
   * V1-C-α: TRUE para staff Ungga (cross-tenant). Cambia el modo del
   * bloque de contexto de OBLIGATORIO → ADMIN UNGGA.
   */
  isUnggaAdmin?: boolean;
  /** Emits curated operational events for product UI. Must not include chain-of-thought. */
  onEvent?: (event: AgentTurnEvent) => void;
}

export type AgentTurnEventType =
  | "turn_started"
  | "context_prepared"
  | "skill_selected"
  | "tools_bound"
  | "tool_started"
  | "tool_completed"
  | "confirmation_required"
  | "memory_applied"
  | "turn_completed"
  | "turn_failed";

export interface AgentTurnEvent {
  type: AgentTurnEventType;
  turnId?: string;
  at?: string;
  message: string;
  toolName?: string;
  skillId?: string;
  details?: Record<string, unknown>;
}

export interface AgentOutput {
  response: string;
  turnId: string;
  toolCalls: string[];
  appliedSkills: AppliedSkill[];
  memoryUsed: AppliedMemory[];
  pendingConfirmation: PendingConfirmation | null;
  /**
   * Señal de memoria larga producida por `memory_injection_node`: `true` si
   * detectó cambio de tema (topic shift) en este turno. El caller decide si
   * dispara `flushSessionMemory` (fire-and-forget) fuera de este runAgent.
   *
   * En turnos de cron (`autoApproveTools=true`) o de resume HITL el nodo
   * hace no-op y este campo siempre queda en `false`.
   */
  memoryFlushPending: boolean;
}

function buildMemoryExtractionPayload(
  activeSkill: ResolvedSkill | undefined
): Record<string, unknown> | undefined {
  if (!activeSkill) return undefined;
  const appliedSkills = buildAppliedSkills(activeSkill);
  return {
    activeSkill: activeSkill.rootName,
    memoryExtraction: activeSkill.memoryExtraction,
    appliedSkills,
  };
}

function buildAppliedSkills(
  activeSkill: ResolvedSkill | undefined
): AppliedSkill[] {
  if (!activeSkill) return [];
  return activeSkill.composedFrom.map((id) => ({
    id,
    role: id === activeSkill.rootName ? "primary" : "included",
  }));
}

/**
 * Build the "[Caso operacional]" block that gets concatenated to the system
 * prompt when runAgent is invoked with `caseId`. The format is intentionally
 * compact (frequently small JSON-ish blobs) so it does not push the model
 * out of the system-prompt budget.
 *
 * The block contains:
 *   - case_type, status, current_step, due_at, version
 *   - external_contact_jsonb (so the agent knows who to message)
 *   - context_jsonb summary
 *   - last 15 events with type/actor/created_at and a one-line payload
 *
 * Hard constraint: this block MUST give the agent enough info to act without
 * asking the user "what was this case about?". The cron is invoking the
 * agent without an explicit user message; the agent must read this block,
 * read the active skill (binding directo), decide next action, act.
 */
interface BuildOperationalCaseContextBlockArgs {
  caseRow: import("@agents/types").OperationalCase;
  caseTypeRow: import("@agents/types").OperationalCaseType | null;
  events: import("@agents/types").OperationalCaseEvent[];
}

function buildOperationalCaseContextBlock(
  args: BuildOperationalCaseContextBlockArgs
): string {
  const { caseRow, caseTypeRow, events } = args;
  const lines: string[] = [];
  lines.push("");
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## [Caso operacional activo]");
  lines.push("");
  lines.push(
    "Este turno fue invocado en el contexto de un caso operacional persistente. NO le preguntes al usuario qué hacer: lee este bloque, aplica la skill activa (binding directo), decide la siguiente acción y, si necesitas decisión humana, usa la tool `notify_user` o pide HITL en el tool call de riesgo. Cuando avances un paso, actualiza el caso usando la tool correspondiente."
  );
  lines.push("");
  lines.push("### Identidad del caso");
  lines.push(`- case_id: ${caseRow.id}`);
  lines.push(`- case_type: ${caseRow.case_type}`);
  if (caseTypeRow?.display_name) {
    lines.push(`- display_name: ${caseTypeRow.display_name}`);
  }
  lines.push(`- status: ${caseRow.status}`);
  lines.push(
    "- Este caso ya existe y está en contexto. No uses `operational_case_create` para continuarlo; usa únicamente las tools de actualización/listado/extracción correspondientes al paso actual."
  );
  if (caseRow.current_step) {
    lines.push(`- current_step: ${caseRow.current_step}`);
  }
  if (caseRow.current_step === "intake") {
    lines.push("");
    lines.push("### Regla estricta de intake");
    lines.push(
      "- Mientras `current_step=intake`, usa `operational_case_update_intake` para persistir datos recolectados y validar campos requeridos."
    );
    lines.push(
      "- No uses `operational_case_update_state` para completar intake ni para mover el caso al primer paso operativo; `operational_case_update_intake` hace ese avance de forma determinística cuando el intake queda completo."
    );
    lines.push(
      "- Si aún faltan campos requeridos, pregunta esos campos al usuario por el canal actual."
    );
    lines.push(
      "- Al completar el intake, confirma brevemente que la propiedad quedó registrada en el caso. No digas «opcional» ni «opcionada»; usa «registrada». No menciones documentos, adjuntos ni el siguiente paso operativo: el sistema o el tick del caso se encargan de eso."
    );
  }
  if (caseRow.due_at) {
    lines.push(`- due_at: ${caseRow.due_at}`);
  }
  if (caseRow.next_action_at) {
    lines.push(`- next_action_at: ${caseRow.next_action_at}`);
  }
  lines.push(`- version: ${caseRow.version}`);

  if (
    caseRow.external_contact_jsonb &&
    Object.keys(caseRow.external_contact_jsonb).length > 0
  ) {
    lines.push("");
    lines.push("### Contacto externo");
    lines.push(
      "```json\n" +
        JSON.stringify(caseRow.external_contact_jsonb, null, 2) +
        "\n```"
    );
  }

  if (
    caseRow.context_jsonb &&
    Object.keys(caseRow.context_jsonb).length > 0
  ) {
    lines.push("");
    lines.push("### Contexto del caso");
    lines.push(
      "```json\n" + JSON.stringify(caseRow.context_jsonb, null, 2) + "\n```"
    );
  }

  if (events.length > 0) {
    lines.push("");
    lines.push("### Últimos eventos (más reciente al final)");
    for (const ev of events) {
      const summary = summarizeEventPayload(ev.payload_jsonb);
      lines.push(
        `- ${ev.created_at} · ${ev.actor} · ${ev.event_type}${summary ? ` · ${summary}` : ""}`
      );
    }
  }

  if (caseTypeRow?.default_reminder_policy_jsonb) {
    const policy = caseTypeRow.default_reminder_policy_jsonb;
    if (
      (policy.remind_after_h && policy.remind_after_h.length > 0) ||
      typeof policy.escalate_after_h === "number"
    ) {
      lines.push("");
      lines.push("### Política de recordatorios (default del case_type)");
      if (policy.remind_after_h && policy.remind_after_h.length > 0) {
        lines.push(
          `- Recordatorios al externo a las horas: ${policy.remind_after_h.join(", ")}`
        );
      }
      if (typeof policy.escalate_after_h === "number") {
        lines.push(`- Escalar al humano interno tras: ${policy.escalate_after_h} h`);
      }
    }
  }
  return lines.join("\n");
}

function summarizeEventPayload(payload: Record<string, unknown>): string {
  if (!payload || Object.keys(payload).length === 0) return "";
  const keys = Object.keys(payload).slice(0, 4);
  const parts: string[] = [];
  for (const k of keys) {
    const v = payload[k];
    if (v === null || v === undefined) continue;
    if (typeof v === "string") {
      parts.push(`${k}=${v.length > 60 ? v.slice(0, 57) + "..." : v}`);
    } else if (typeof v === "number" || typeof v === "boolean") {
      parts.push(`${k}=${v}`);
    } else {
      parts.push(`${k}=<json>`);
    }
  }
  return parts.join(" ");
}

function buildAppliedMemory(args: {
  readonly memoryItemPreviews: readonly string[];
  readonly shortTermMessageCount: number;
  readonly shortTermPreviews: readonly AppliedMemoryShortTermPreview[];
  readonly includeShortTerm: boolean;
}): AppliedMemory[] {
  const memoryUsed: AppliedMemory[] = [];

  if (args.includeShortTerm && args.shortTermMessageCount > 0) {
    memoryUsed.push({
      source: "short_term",
      content: "Conversación reciente en contexto",
      count: args.shortTermMessageCount,
      previews: [...args.shortTermPreviews],
    });
  }

  for (const preview of args.memoryItemPreviews) {
    const match = preview.match(/^\((episodic|semantic|procedural)\)\s+(.+)$/);
    if (!match) continue;
    memoryUsed.push({
      source: "long_term",
      type: match[1] as AppliedMemory["type"],
      content: match[2].trim(),
    });
  }

  return memoryUsed;
}

type AppliedMemoryShortTermPreview = NonNullable<AppliedMemory["previews"]>[number];

function buildShortTermMemoryPreviews(
  messages: readonly AgentMessage[],
  limit = 12
): AppliedMemoryShortTermPreview[] {
  return messages.slice(-limit).map((message) => ({
    role: message.role,
    content:
      message.content.length > 180
        ? `${message.content.slice(0, 180).trim()}...`
        : message.content,
    created_at: message.created_at,
  }));
}

const MAX_TOOL_ITERATIONS = 10;
const MEMORY_CURATE_TOOL_NAMES = new Set([
  "list_user_memories",
  "search_user_memories",
  "archive_user_memory",
  "delete_user_memory",
]);
/** System prompt inyectado cuando forzamos una última respuesta de texto
 *  tras tocar el tope de iteraciones sin producir texto. */
const FORCED_TEXT_WRAPUP_INSTRUCTION =
  "Has alcanzado el límite de llamadas a herramientas en este turno. " +
  "NO puedes llamar más herramientas. " +
  "Produce AHORA un texto final en español resumiendo lo que aprendiste de los tool_results anteriores. " +
  "Si la información es parcial, dilo explícitamente y entrega lo que sí tengas. " +
  "Si ninguna llamada devolvió datos útiles, reporta los exitCode/stderr literales que viste y pide al usuario que simplifique su petición.";

function buildEnabledSkillCandidateSlugs(
  allSlugs: readonly string[],
  settings: readonly UserSkillSetting[] | undefined
): readonly string[] {
  if (!settings || settings.length === 0) return allSlugs;

  const bySkill = new Map(settings.map((s) => [s.skill_id, s.enabled]));
  return allSlugs.filter((slug) => bySkill.get(slug) !== false);
}

function skillCandidateIsEnabled(
  skillId: string,
  candidateSlugs: readonly string[]
): boolean {
  return candidateSlugs.includes(skillId);
}

/**
 * Clave de deduplicación para tool_calls de negocio idempotentes emitidas
 * en el MISMO mensaje del modelo. Devuelve `null` para tools que no se deben
 * colapsar (la mayoría: pueden repetirse legítimamente en un turno).
 *
 * Solo cubrimos acciones externas/costosas donde dos llamadas idénticas en un
 * único turno son siempre un error del modelo, no intención del usuario:
 *  - generate_document_from_template (render DOCX duplicado).
 *  - telegram_send_message_to_contact (mensaje externo duplicado).
 */
function idempotentSameMessageDedupKey(
  toolName: string,
  args: Record<string, unknown>,
  caseIdFallback?: string
): string | null {
  if (toolName === "generate_document_from_template") {
    return `gen_doc::${generatedDocumentDedupKey(args, { caseIdFallback })}`;
  }
  if (toolName === "telegram_send_message_to_contact") {
    return [
      "tg",
      String(args.chat_id ?? ""),
      String(args.case_id ?? caseIdFallback ?? ""),
      String(args.purpose ?? ""),
      normalizeTelegramSendText(args.text),
    ].join("::");
  }
  return null;
}

function shouldRequireCompanyDataQueryForTurn(args: {
  readonly activeSkill: ResolvedSkill | undefined;
  readonly message: string | undefined;
  readonly toolNamesAvailable: Set<string>;
  readonly toolCallNames: readonly string[];
}): boolean {
  if (args.activeSkill?.rootName !== "company-data") return false;
  if (!args.toolNamesAvailable.has("bigquery_run_query")) return false;
  if (args.toolCallNames.includes("bigquery_run_query")) return false;

  const text = (args.message ?? "").toLowerCase();
  if (!text.trim()) return false;

  const hasMetricHint =
    /\b(leads?|usuarios?|propiedades?|citas?|deals?|mensajes?|kpis?|total|cu[aá]nt[oa]s?|conteo|cantidad|promedio|conversi[oó]n|tasa|funnel)\b/i.test(
      text
    );
  const hasPeriodHint =
    /\b(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre|hoy|ayer|semana|mes|a[nñ]o|trimestre|q[1-4]|202[0-9])\b/i.test(
      text
    );
  const isShortFollowUp = /^\s*(y\s+)?(en\s+)?(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre|hoy|ayer|este\s+mes|mes\s+pasado)\??\s*$/i.test(
    text
  );

  return isShortFollowUp || hasMetricHint || hasPeriodHint;
}

function shouldRequireLeadContextLookupForTurn(args: {
  readonly activeSkill: ResolvedSkill | undefined;
  readonly message: string | undefined;
  readonly priorMessages: readonly AgentMessage[];
  readonly toolNamesAvailable: Set<string>;
  readonly toolCallNames: readonly string[];
}): boolean {
  if (args.activeSkill?.rootName !== "lead-follow-up-draft") return false;
  if (!args.toolNamesAvailable.has("bigquery_run_query")) return false;
  if (args.toolCallNames.includes("bigquery_run_query")) return false;
  return turnHasLeadIdentifier({
    message: args.message,
    priorMessages: args.priorMessages,
  });
}

function shouldRequireMemoryCurateToolForTurn(args: {
  readonly activeSkill: ResolvedSkill | undefined;
  readonly message: string | undefined;
  readonly toolNamesAvailable: Set<string>;
  readonly toolCallNames: readonly string[];
}): boolean {
  if (args.activeSkill?.rootName !== "memory-curate") return false;
  if (!args.message?.trim()) return false;
  const hasAnyMemoryTool = [...MEMORY_CURATE_TOOL_NAMES].some((name) =>
    args.toolNamesAvailable.has(name)
  );
  if (!hasAnyMemoryTool) return false;
  return !args.toolCallNames.some((name) => MEMORY_CURATE_TOOL_NAMES.has(name));
}

function isInternalCorrectionMessage(message: BaseMessage): boolean {
  if (!(message instanceof HumanMessage)) return false;
  const content = normalizeMessageContentToString(message.content);
  return (
    content.startsWith("[CORRECCIÓN INTERNA — COMPANY-DATA]") ||
    content.startsWith("[CORRECCIÓN INTERNA — LEAD-FOLLOW-UP-DRAFT]") ||
    content.startsWith("[CORRECCIÓN INTERNA — MEMORY-CURATE]")
  );
}

function shouldAskLeadIdentifierBeforeDraft(args: {
  readonly activeSkill: ResolvedSkill | undefined;
  readonly message: string | undefined;
  readonly priorMessages: readonly AgentMessage[];
}): boolean {
  if (args.activeSkill?.rootName !== "lead-follow-up-draft") return false;
  return !turnHasLeadIdentifier({
    message: args.message,
    priorMessages: args.priorMessages,
  });
}

function normalizeMessageContentToString(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    return raw
      .filter(
        (p): p is { type: string; text: string } =>
          typeof p === "object" && p !== null && "text" in p
      )
      .map((p) => p.text)
      .join("")
      .trim();
  }
  return raw ? String(raw) : "";
}

function trimTrailingUnansweredToolCall(messages: BaseMessage[]): BaseMessage[] {
  const trimmed = [...messages];
  while (trimmed.length > 0) {
    const last = trimmed[trimmed.length - 1];
    if (last instanceof AIMessage && last.tool_calls?.length) {
      trimmed.pop();
      continue;
    }
    break;
  }
  return trimmed;
}

/** Mismos defaults que `memory_injection_node` (solo para turn_summary / eco en log). */
const MEM_LOG_RETRIEVE_TOP_K_DEFAULT = 8;
const MEM_LOG_MATCH_THRESHOLD_DEFAULT = 0.5;

function resolveMemoryLogRetrieveTopK(): number {
  const raw = process.env.MEMORY_RETRIEVE_TOP_K?.trim();
  if (!raw) return MEM_LOG_RETRIEVE_TOP_K_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return MEM_LOG_RETRIEVE_TOP_K_DEFAULT;
  return Math.floor(n);
}

function resolveMemoryLogMatchThreshold(): number {
  const raw = process.env.MEMORY_MATCH_THRESHOLD?.trim();
  if (!raw) return MEM_LOG_MATCH_THRESHOLD_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return MEM_LOG_MATCH_THRESHOLD_DEFAULT;
  return n;
}

/**
 * Parsea el bloque `[MEMORIA DEL USUARIO…]` en el system prompt final para
 * contar ítems y armar previews (opción A hacia v2, sin leer memory.log).
 *
 * Importante: `memory_injection_node` **antepone** el bloque al system existente
 * con un separador fijo: `\n\n---\n\n` (ver `createMemoryInjectionNode`). Si
 * recontáramos hasta el final del string, incluiríamos el prompt base con
 * decenas de líneas `-` (reglas, contacto, listas) y el número "retrieved" sería
 * absurdo. Solo analizamos el tramo **hasta** ese separador.
 */
function extractMemoriaUserBlockStats(sysText: string): {
  injected: boolean;
  matchesCount: number;
  memoryBlockChars: number;
  memoryItemPreviews: string[];
} {
  const blockStart = sysText.indexOf("[MEMORIA DEL USUARIO");
  if (blockStart < 0) {
    return {
      injected: false,
      matchesCount: 0,
      memoryBlockChars: 0,
      memoryItemPreviews: [],
    };
  }
  const afterHeader = sysText.slice(blockStart);
  const sepIdx = afterHeader.indexOf("\n\n---\n\n");
  const memorySection =
    sepIdx >= 0 ? afterHeader.slice(0, sepIdx) : afterHeader;

  const memoryItemPreviews: string[] = [];
  for (const line of memorySection.split("\n")) {
    const m = line.match(
      /^\s*-\s+\((episodic|semantic|procedural)\)\s+(.+?)\s*$/
    );
    if (m) {
      const one = `(${m[1]}) ${m[2]}`.replace(/\s+/g, " ").trim();
      if (one.length > 0) {
        memoryItemPreviews.push(
          one.length > 120 ? `${one.slice(0, 120)}…` : one
        );
      }
    }
  }
  return {
    injected: memoryItemPreviews.length > 0,
    matchesCount: memoryItemPreviews.length,
    memoryBlockChars: memorySection.length,
    memoryItemPreviews,
  };
}

function buildPromptSnapshotFromMessages(
  messages: BaseMessage[] | undefined
): TurnSummaryInput["promptSnapshot"] | undefined {
  if (!messages || messages.length === 0) return undefined;
  const first = messages[0];
  if (!(first instanceof SystemMessage)) return undefined;
  const sysText = normalizeMessageContentToString(first.content);
  const mstats = extractMemoriaUserBlockStats(sysText);
  const sysLen = sysText.length;
  let nonSysChars = 0;
  for (let i = 1; i < messages.length; i++) {
    nonSysChars += normalizeMessageContentToString(messages[i].content).length;
  }
  const total = sysLen + nonSysChars;
  return {
    systemChars: sysLen,
    systemApproxTokens: approxTokensFromChars(sysLen),
    nonSystemMessageCount: Math.max(0, messages.length - 1),
    nonSystemChars: nonSysChars,
    nonSystemApproxTokens: approxTokensFromChars(nonSysChars),
    totalWindowChars: total,
    totalWindowApproxTokens: approxTokensFromChars(total),
    memoryBlockChars: mstats.memoryBlockChars,
    memoryItemPreviews: mstats.memoryItemPreviews,
  };
}

/**
 * Last AIMessage with non-empty text in the **current user turn** (after the latest HumanMessage).
 * Avoids returning an older assistant reply from chat history when the latest model output is empty.
 */
function getLastAssistantText(messages: BaseMessage[]): string {
  let lastHumanIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] instanceof HumanMessage) {
      lastHumanIdx = i;
      break;
    }
  }
  if (lastHumanIdx < 0) return "";

  for (let i = messages.length - 1; i > lastHumanIdx; i--) {
    const m = messages[i];
    if (m instanceof AIMessage) {
      const text = normalizeMessageContentToString(m.content);
      if (text.trim().length > 0) return text;
    }
  }
  return "";
}

/** Inyectado cuando hay tools de creación en GitHub: el modelo suele confundir repo nuevo vs issue. */
const GITHUB_CREATE_TOOLS_ADDENDUM = `

[Reglas GitHub — obligatorias]
- Si el usuario pide crear un NUEVO repositorio (crear repositorio, nuevo repo, crear repo, new repository, etc.), usa ÚNICAMENTE la herramienta github_create_repo. El parámetro "name" es solo el slug del repo (ej. mi-app), sin owner ni barra "/".
- Si el usuario NO dijo un nombre concreto para el repositorio, NO llames a github_create_repo. Responde en texto y pregunta cómo quiere llamarlo (un solo slug corto). No inventes ni reutilices nombres de ejemplos anteriores.
- github_create_issue sirve SOLO para abrir un ticket/issue dentro de un repositorio que YA EXISTE. No la uses para crear el repositorio en sí.
- Títulos como "Nuevo repositorio X" en un pedido de crear proyecto en GitHub indican github_create_repo con name="X", no create_issue.
- NUNCA uses github_create_repo en un turno de CALENDARIO. Si el usuario está creando/listando eventos, citas o agendas, NO llames a ninguna herramienta de GitHub aunque el mensaje contenga palabras que se parezcan a nombres de repos. Usa SOLO las herramientas calendar_*.`;

const GITHUB_SOCIAL_ADDENDUM = `

[Reglas GitHub — saludos y presencia]
- Si el usuario solo saluda o pregunta si sigues ahí ("hola", "¿sigues ahí?", "estás ahí", "ping", "gracias", "¿qué tal?"), responde en texto natural. NO uses NINGUNA herramienta de GitHub (ni list_repos, ni list_issues, ni create_repo, ni create_issue). Un saludo no es una petición de datos ni una acción en GitHub.

[Reglas GitHub — alcance estricto de las herramientas]
- github_list_repos lista SOLO los repos de la cuenta vinculada del usuario. NO es un buscador de GitHub ni de la web. NO la uses cuando el usuario pida información sobre marcas, empresas, productos, personas, conceptos, noticias o cualquier tema externo (p. ej. "busca info sobre X", "qué es X"). Aunque el mensaje contenga el verbo "buscar", si X no es claramente un repo GitHub del usuario, NO llames a github_list_repos.
- **Preferencias de CÓMO responder (sin pedir datos):** si el usuario solo indica formato, estilo, tono, longitud, viñetas/bullets, "más claro", "puntualiza con lista", o cómo estructurar la respuesta, responde en **texto** y no uses ninguna herramienta de GitHub. Eso no es un pedido de "listar repositorios" aunque diga "lista" o "items".
- Si el usuario pide información sobre algo externo y NO hay otra herramienta que cubra esa necesidad (calendario, archivos, etc.), o bien usa la herramienta bash con curl para consultar la web (ver reglas de bash), o, si no puedes/no sabes, di claramente "no tengo esa información" en vez de inventar contenido.`;

function appendGithubCreateToolRules(
  basePrompt: string,
  lcTools: Array<{ name?: string }>
): string {
  const names = new Set(
    lcTools.map((t) => t.name).filter((n): n is string => Boolean(n))
  );
  if (!names.has("github_create_issue") && !names.has("github_create_repo")) {
    return basePrompt;
  }
  return `${basePrompt.trimEnd()}${GITHUB_CREATE_TOOLS_ADDENDUM}`;
}

function appendGithubSocialRules(
  basePrompt: string,
  lcTools: Array<{ name?: string }>
): string {
  const names = new Set(
    lcTools.map((t) => t.name).filter((n): n is string => Boolean(n))
  );
  const hasAnyGithub =
    names.has("github_list_repos") ||
    names.has("github_list_issues") ||
    names.has("github_create_repo") ||
    names.has("github_create_issue");
  if (!hasAnyGithub) return basePrompt;
  return `${basePrompt.trimEnd()}${GITHUB_SOCIAL_ADDENDUM}`;
}

function buildBashAddendum(): string {
  let shellLine: string;
  try {
    const { getActiveShellName } = require("./tools/bashExec") as {
      getActiveShellName: () => string;
    };
    const shell = getActiveShellName();
    shellLine =
      shell === "powershell"
        ? "- IMPORTANTE: El servidor corre en **Windows con PowerShell** (no se encontró bash). Usa sintaxis de PowerShell: Get-ChildItem (no ls -la), Get-Content (no cat). Los flags Unix como -la NO funcionan."
        : `- El servidor usa **${shell}**. Usa sintaxis bash/Unix estándar (ls, cat, pwd, etc.).`;
  } catch {
    shellLine =
      "- Usa sintaxis bash estándar (ls, cat, pwd, etc.).";
  }
  return `

[Reglas herramienta bash — obligatorias]
- Si el usuario pide archivos o carpetas del SERVIDOR (donde corre la app), "carpeta actual", "directorio actual", "listar archivos aquí" → usa SOLO la herramienta bash con el comando adecuado. NO uses github_list_repos: esa herramienta lista repositorios remotos en GitHub, no archivos del disco del servidor.
- github_list_repos solo cuando pide explícitamente sus repositorios/proyectos en GitHub, "mis repos en GitHub", listado de repos remotos, etc.

[Reglas bash — información actual y web]
- Si el usuario pide información ACTUAL (noticias del día, eventos en curso, "qué pasa con X hoy", "últimas noticias sobre X", "qué es X" para algo que probablemente no estaba en tu corpus), NO digas "no tengo acceso a internet" ni "no tengo datos en tiempo real": usa la herramienta bash con curl para descargar una fuente relevante y resúmela.
- Patrón base para descargar una URL (silencia stderr para evitar ruido de SIGPIPE de head): \`curl -sS -L --max-time 20 -A 'Mozilla/5.0' '<URL>' 2>/dev/null | head -c 8000\`. Si el stdout viene vacío o muy corto, ESO es la señal de fallo, no el stderr.
- Fuentes recomendadas según el tipo de pregunta:
  · NOTICIAS / actualidad ("últimas noticias sobre X", "qué pasó hoy con X"): Google News RSS, devuelve XML con <item><title>...</title><link>...</link>: \`curl -sS -L --max-time 20 'https://news.google.com/rss/search?q=<consulta+codificada>&hl=es&gl=MX&ceid=MX:es' 2>/dev/null | head -c 12000\`. Extrae los primeros 5-10 <title> e indica fuente con <source> si aparece.
  · DEFINICIÓN / "qué es X": Wikipedia REST API (en español): \`curl -sS -L --max-time 15 'https://es.wikipedia.org/api/rest_v1/page/summary/<TermaCapitalizadoConGuionesBajos>' 2>/dev/null\`. Si trae \`"type":"disambiguation"\` o 404, prueba en inglés (\`en.wikipedia.org\`) o reintenta con otra capitalización. Si Wikipedia no la conoce, dilo: probablemente es una marca/empresa pequeña.
  · HACKER NEWS: API JSON oficial — \`https://hacker-news.firebaseio.com/v0/topstories.json\` (lista de IDs) y \`https://hacker-news.firebaseio.com/v0/item/<id>.json\` (cada historia).
  · NO uses la versión HTML de DuckDuckGo (\`duckduckgo.com/html\`): devuelve solo el cascarón sin resultados.
- IMPORTANTE — interpretación del resultado de bash:
  · \`exitCode: 0\` y stdout con contenido útil → procesa y responde.
  · stderr contiene \`curl: (23) Failure writing output to destination\` pero hay stdout → NO es un fallo real, es \`head -c\` cortando el pipe; usa el stdout que sí llegó.
  · stdout vacío y exitCode != 0 → reporta exitCode y stderr literales y prueba otra fuente o admite que no obtuviste resultados; NO inventes contenido.
  · No respondas frases tipo "no pude recuperar la información" si tienes stdout no vacío: si tienes texto, RESÚMELO aunque sea parcial.
${shellLine}`;
}

function appendBashRules(
  basePrompt: string,
  lcTools: Array<{ name?: string }>
): string {
  const names = new Set(
    lcTools.map((t) => t.name).filter((n): n is string => Boolean(n))
  );
  if (!names.has("bash")) return basePrompt;
  return `${basePrompt.trimEnd()}${buildBashAddendum()}`;
}

const FILE_TOOLS_ADDENDUM = `

[Reglas herramientas de archivos (read_file / write_file / edit_file) — obligatorias]
- Llama DIRECTAMENTE a la herramienta apropiada (read_file / write_file / edit_file). NO pidas confirmación en texto ("¿confirmas?", "¿procedo?"): write_file y edit_file ya muestran una tarjeta de confirmación automática al usuario antes de escribir en disco. Tu trabajo es generar el tool_call correcto con los parámetros, no pedir permiso verbal.
- Si el usuario pide el contenido de un archivo del proyecto o del workspace del servidor, usa read_file con el parámetro path RELATIVO a la raíz del workspace (FILE_TOOLS_ROOT), por ejemplo "docs/plan.md", ".cursor/rules/algo.md" o "packages/agent/package.json". Nunca pases rutas absolutas (C:\\\\..., /home/..., /etc/...): la herramienta las rechaza.
- Un **título** o nombre para humanos (p. ej. "1_Agente (Chat en Cursor) - Project Rules and Guidelines") **no es** una ruta de archivo. Si el usuario solo da un título sin ruta, no inventes el path: explica que necesitas la ruta relativa dentro del repo, o usa la herramienta bash (si está disponible) para buscar el archivo en el directorio de trabajo del servidor (p. ej. PowerShell: Get-ChildItem -Recurse -File | Where-Object { $_.Name -like '*fragmento*' }) y luego read_file con la ruta relativa encontrada respecto a FILE_TOOLS_ROOT.
- Para edit_file, old_string debe aparecer EXACTAMENTE UNA VEZ en el archivo; si puede haber varias coincidencias, incluye contexto literal alrededor (mismos espacios y saltos de línea) para hacerla única. Si falla con "multiple_matches" o "no_match", ajusta el fragmento y vuelve a intentar.
- Tras read_file, resume el contenido al usuario; si el JSON devuelve ok:false (p. ej. not_found, invalid_path), explica el error y sugiere comprobar la ruta o permisos.`;

function appendFileToolsRules(
  basePrompt: string,
  lcTools: Array<{ name?: string }>
): string {
  const names = new Set(
    lcTools.map((t) => t.name).filter((n): n is string => Boolean(n))
  );
  const hasFileTools =
    names.has("read_file") ||
    names.has("write_file") ||
    names.has("edit_file");
  if (!hasFileTools) return basePrompt;
  return `${basePrompt.trimEnd()}${FILE_TOOLS_ADDENDUM}`;
}

const SCHEDULE_TASK_ADDENDUM = `

[Reglas herramienta schedule_task — obligatorias]
- Usa schedule_task cuando el usuario quiera que el agente haga algo en un momento futuro. Reconoce estas formas:
  · Hora de hoy: "hoy a las 19:45", "a las 8 de la noche", "en 30 minutos", "dentro de una hora", "a las X de hoy".
  · Fecha futura: "el viernes a las 9", "mañana a las 10 am", "el 25 de abril a las 9".
  · Recurrente: "todos los lunes a las 9", "cada día a las 8 am", "cada semana".
  · Verbos guía: "recuérdame", "programa", "avísame", "consulta X a las Y", "mándame X cada Z".
- El campo 'prompt' es la instrucción que el agente ejecutará a esa hora (escríbela como si fuera un mensaje directo al agente). Sé MUY específico, incluyendo el comando exacto a ejecutar cuando aplique.
  · Ejemplo Hacker News (preferir API JSON, no scraping HTML). IMPORTANTE: el comando se delimita con comillas o backticks, y la puntuación de la oración ('.', '?') va FUERA del comando. NUNCA escribas \`done.\` o \`fi.\` dentro de un comando bash: ese punto se interpreta como nombre de comando y rompe el shell con "syntax error: unexpected end of file".
    Forma correcta: 'Usa bash para correr el siguiente comando: \`ids=$(curl -sS https://hacker-news.firebaseio.com/v0/topstories.json | head -c 300 | tr -d \"[]\" | tr "," "\n" | head -10); for id in $ids; do curl -sS https://hacker-news.firebaseio.com/v0/item/$id.json | head -c 600; echo; done\`. Devuélveme los títulos y URLs de las 5 historias más relevantes en español.'
  · Ejemplo URL genérica (mismo patrón: comando entre backticks, puntuación afuera):
    'Usa bash para correr: \`curl -sS -L -A "Mozilla/5.0" https://EJEMPLO.com/ | head -c 4000\`. Resume el contenido principal en español.'
- Siempre extrae o pregunta: qué debe hacer el agente (prompt), cuándo (fecha/hora o expresión recurrente), y timezone (usa la del perfil si no se especifica).
- Para one_time: calcula run_at como ISO 8601 con offset de zona (p.ej. 2026-04-18T19:45:00-06:00). Usa la fecha local actual del usuario como referencia. NUNCA uses fechas pasadas.
- Para recurring: usa expresiones cron de 5 campos estándar. Si el usuario dice "todos los lunes a las 9", usa "0 9 * * 1".
- El resultado de la tarea se enviará por Telegram al usuario. Si el usuario no tiene Telegram vinculado, la ejecución se registra pero no hay notificación en tiempo real.
- schedule_task es riesgo medio: la herramienta mostrará tarjeta de confirmación al usuario. NO pidas permiso en texto antes de llamarla.
- PROHIBIDO ANUNCIAR SIN ACTUAR: si vas a programar una tarea, **llama a schedule_task en el MISMO turno**, no escribas frases tipo "Voy a programar...", "Voy a proceder a programar...", "Programaré la siguiente tarea..." sin emitir el tool_call. El usuario solo ve "Acción programada" después de tu llamada al tool — si solo describes la intención y no llamas a la herramienta, la tarea NUNCA se programa y el usuario espera en vano.
- Si todavía te falta algún dato esencial (hora exacta o el qué), pregunta UNA cosa corta y NO escribas "Voy a programar"; si tienes todos los datos, llama directamente a schedule_task sin frases preparatorias.
- Si el prompt programado requiere acceder a una URL o ejecutar un comando (bash), inclúyelo literalmente en el campo prompt. El agente que se ejecute a esa hora decidirá qué herramientas usar.`;

function appendScheduleTaskRules(
  basePrompt: string,
  lcTools: Array<{ name?: string }>
): string {
  const names = new Set(
    lcTools.map((t) => t.name).filter((n): n is string => Boolean(n))
  );
  if (!names.has("schedule_task")) return basePrompt;
  return `${basePrompt.trimEnd()}${SCHEDULE_TASK_ADDENDUM}`;
}

const MANAGE_SCHEDULED_TASKS_ADDENDUM = `

[Reglas herramienta manage_scheduled_tasks — obligatorias]
- Úsala SOLO cuando el usuario pida ver, pausar o reanudar sus tareas programadas. Acciones disponibles: "list", "pause", "resume". No existe una acción de borrado aquí.
- action="list": llámala directamente cuando el usuario pida "mis tareas programadas", "qué tengo agendado", "lista de tareas", etc. Después, resume en texto los campos más útiles (id corto, status, schedule_type, cron_expr/run_at, next_run_local, y una vista corta del prompt). Si no hay tareas, dilo claramente.
- action="pause" | "resume": requieren task_id UUID. NUNCA lo adivines ni lo construyas a partir del texto del usuario.
- DESAMBIGUACIÓN OBLIGATORIA: si el usuario dice "pausa la tarea de Hacker News" o "reanuda la recurrente" sin darte un UUID:
  1) Llama primero a manage_scheduled_tasks con action="list".
  2) Si hay 0 tareas que encajen con la descripción → díselo y detente.
  3) Si hay UNA sola tarea claramente coincidente → haz UNA pregunta corta de confirmación ("¿Pauso esta tarea? …resumen breve…") y espera la respuesta del usuario antes de llamar pause/resume. NO pauses automáticamente solo porque haya una sola coincidencia: el usuario te lo debe confirmar.
  4) Si hay varias tareas que podrían encajar → ofrece las opciones numeradas con su id corto y pregunta cuál. Espera a que el usuario elija antes de llamar pause/resume.
- Tras una acción pause/resume, responde con una confirmación breve que incluya: acción aplicada, id (primeros 8 chars), nuevo status y next_run_at en hora local. Si la DB respondió ok:false (p. ej. task_id no encontrado), explícalo y sugiere volver a listar.
- Esta herramienta NO muestra tarjeta HITL (los cambios son reversibles y están limitados a tareas del mismo usuario). Por eso la regla 3 es crítica: sin confirmación en texto del usuario, no ejecutes pause/resume.`;

function appendManageScheduledTasksRules(
  basePrompt: string,
  lcTools: Array<{ name?: string }>
): string {
  const names = new Set(
    lcTools.map((t) => t.name).filter((n): n is string => Boolean(n))
  );
  if (!names.has("manage_scheduled_tasks")) return basePrompt;
  return `${basePrompt.trimEnd()}${MANAGE_SCHEDULED_TASKS_ADDENDUM}`;
}

/** Injected when the cron runner executes a stored prompt (autoApproveTools). */
const CRON_SCHEDULED_EXECUTION_ADDENDUM = `

══════════════════════════════════════════════════════
[ATAJO CRON — ESTE TURNO ES EL ÚLTIMO MENSAJE QUE VE EL USUARIO]
══════════════════════════════════════════════════════
- Tu respuesta de texto en este turno se envía DIRECTAMENTE por Telegram al usuario, SIN siguiente turno. No hay forma de "continuar después", no hay forma de "reintentar más tarde": si prometes algo, debes hacerlo AHORA en este mismo turno antes de cerrar.
- ESTÁ PROHIBIDO cerrar el turno con cualquiera de estas frases (o variantes): "Un momento, por favor", "Intentaré un enfoque diferente", "Intentaré de nuevo", "Lo intento más tarde", "Voy a probar otra cosa", "Permíteme reintentarlo". Si escribes algo así sin un nuevo tool_call inmediatamente después, el usuario solo ve la promesa y nunca el resultado.
- Si tienes algo de stdout aunque sea parcial, RESÚMELO en vez de decir "no se pudo": titulares incompletos > mensaje vacío.

[Reintentos de bash — reglas estrictas]
- REGLA DE ÉXITO: si una llamada a bash devolvió \`exitCode: 0\` y \`stdout\` con ≥ 200 bytes de contenido útil (texto, JSON, HTML), NO la repitas con variaciones menores (quitar \`head -c\`, agregar/quitar \`echo\`, cambiar separadores, ajustar el length de \`head -c\`, mover \`;\` al final). Considera el resultado SUFICIENTE y pasa a redactar la respuesta final con el stdout que ya tienes, aunque esté truncado.
- REGLA DE FALLO: solo se permite un reintento real si la llamada anterior devolvió \`exitCode != 0\` Y \`stdout\` vacío, o si literalmente no se descargó nada. En ese caso emite UN solo reintento con un cambio sustantivo (otra URL, otra fuente, otro endpoint), no un retoque cosmético al mismo comando.
- DETECCIÓN DE VARIACIONES MENORES: si tu nuevo prompt difiere del anterior solo por presencia/ausencia de \`echo\`, \`done.\` vs \`done;\`, distintos límites de \`head -c\`, o presencia/ausencia de \`| head -c <n>\` en el cuerpo del loop, se considera la MISMA llamada y NO debes emitirla.
- LÍMITE DURO: máximo 2 llamadas a \`bash\` por turno (la primera + un reintento sustantivo solo si la primera realmente falló). Más de 2 se interpreta como bucle improductivo.
- Cuando ya tengas stdout con contenido, escribe la respuesta final inmediatamente; no anuncies "voy a intentar otra vez con un comando ligeramente distinto".

[Ejecución automática (tarea programada) — reglas]
- Esta petición es la ejecución de una tarea que el usuario YA aprobó al programarla. No digas que no puedes programar acciones futuras ni que no puedes acceder a sitios web: ejecuta lo pedido ahora.
- Si el mensaje pide datos de una URL o ejecutar un comando en terminal, usa SIEMPRE la herramienta bash (está habilitada en el servidor) y devuelve un resumen útil en texto.
- Si la primera llamada a bash devuelve stdout vacío y exitCode != 0, prueba UN reintento sustantivo (otra fuente o endpoint), nunca el mismo comando con flags ajustados; lee también la sección "Reintentos de bash — reglas estrictas".
- El stderr \`curl: (23) Failure writing output\` NO es un error real, es SIGPIPE de \`head -c\`; si tienes stdout, úsalo y no reintentes.
- Para Hacker News, prefiere la API JSON: https://hacker-news.firebaseio.com/v0/topstories.json y https://hacker-news.firebaseio.com/v0/item/<id>.json. Si una llamada a /item/<id>.json falla, ignora ese item y sigue con los demás; no abandones todo por uno.
- No vuelvas a llamar a schedule_task para lo mismo salvo que el mensaje lo pida explícitamente.`;

const CALENDAR_TOOLS_ADDENDUM = `

[Reglas Google Calendar — obligatorias]
- Si el usuario pide eventos, citas, agenda o calendario, usa las herramientas calendar_* (p. ej. calendar_list_events con calendar_id "primary"). No uses herramientas GitHub para esas peticiones.
- Al CREAR un evento (calendar_create_event), usa SIEMPRE calendar_id="primary" salvo que el usuario diga explícitamente en QUÉ calendario quiere crearlo ("en el calendario Lab10", "en mi calendario de trabajo"). El nombre del evento NO es el nombre del calendario — no confundas "curso Lab10" (título del evento) con el calendario llamado "Lab10".
- github_create_repo / github_create_issue son solo para repositorios e issues en GitHub, nunca para citas o calendario.
- Si NO dijo período ("mis eventos", "qué tengo", "mi calendario"): llama calendar_list_events SIN time_min ni time_max → recibirás needs_period; haz UNA pregunta corta (hoy / esta semana / desde-hasta / etc.). No adivines fechas ni listes eventos hasta tener rango.
- Cuando tengas el período (explícito o acordado), convierte a time_min y time_max en ISO 8601 usando get_user_preferences.timezone (p. ej. America/Mexico_City). Pasa SIEMPRE ambos campos en la siguiente llamada.
- Interpretación de períodos naturales (usar semana lunes–domingo):
  · "hoy" → desde inicio del día actual (00:00) hasta fin (23:59:59) en la zona del perfil.
  · "mañana" → inicio y fin del día siguiente.
  · "esta semana" / "this week" → desde el lunes 00:00 de la semana en curso hasta el domingo 23:59:59 en la zona del perfil. NO es "desde ahora + 7 días".
  · "la próxima semana" / "next week" → lunes 00:00 al domingo 23:59:59 de la semana siguiente.
  · "este mes" → desde el día 1 00:00 hasta el último día 23:59:59 del mes en curso.
  · Si la fecha de hoy es jueves 9 de abril 2026, "esta semana" = lun 6 abr 00:00 → dom 12 abr 23:59:59.
- Al responder, usa los campos start_display y end_display de cada evento (hora local del perfil). No digas "UTC" salvo que el usuario lo pida.
- Respuestas cortas de período ("de esta semana", "hoy", "este mes") tras preguntar por el calendario → calendar_list_events con ISO en su timezone, NUNCA github_list_repos (eso son repositorios, no citas).
- historical=true solo si pidió historial o fechas pasadas claras. Si el JSON trae range_coerced o assistant_hint, explícalo y no mezcles años que no vengan del JSON.`;

function appendCalendarToolRules(
  basePrompt: string,
  lcTools: Array<{ name?: string }>
): string {
  const names = lcTools
    .map((t) => t.name)
    .filter((n): n is string => Boolean(n));
  const hasCalendar = names.some((n) => n.startsWith("calendar_"));
  if (!hasCalendar) return basePrompt;
  return `${basePrompt.trimEnd()}${CALENDAR_TOOLS_ADDENDUM}`;
}

function resolveToolCallSource(input: AgentInput): ToolCallSource {
  if (input.toolCallSource) return input.toolCallSource;
  const channel = input.channel ?? (input.autoApproveTools ? "cron" : "web");
  switch (channel) {
    case "telegram":
      return "telegram";
    case "cron":
      return "cron";
    case "heartbeat":
      return "heartbeat";
    case "case_runner":
      return "case_runner";
    default:
      return "chat";
  }
}

export async function runAgent(input: AgentInput): Promise<AgentOutput> {
  const turnStartedAt = new Date();
  const {
    message,
    turnId: inputTurnId,
    userId,
    sessionId,
    systemPrompt,
    db,
    enabledTools,
    integrations,
    githubToken,
    userTimezone,
    userName,
    userEmail,
    userPhone,
    channel,
    googleCalendarAccessToken,
    resumeDecision,
    checkpointThreadId,
  } = input;
  const turnId = inputTurnId ?? randomUUID();
  const emitEvent = (event: AgentTurnEvent): void => {
    try {
      input.onEvent?.({
        ...event,
        turnId: event.turnId ?? turnId,
        at: event.at ?? new Date().toISOString(),
      });
    } catch (err) {
      console.warn(
        "[agent-events] subscriber failed:",
        err instanceof Error ? err.message : String(err)
      );
    }
  };
  emitEvent({
    type: "turn_started",
    message: resumeDecision
      ? "Reanudando turno con confirmación humana."
      : "Turno iniciado.",
    details: { channel: channel ?? (input.autoApproveTools ? "cron" : "web") },
  });

  const resolvedChannelForRuntime:
    | "web"
    | "telegram"
    | "cron"
    | "heartbeat"
    | "case_runner" = channel ? channel : input.autoApproveTools ? "cron" : "web";
  // Temperatura/modelo por canal:
  // - web/telegram: conversacional (~0.3)
  // - cron/heartbeat: determinista (~0.1)
  const modelTemperature =
    resolvedChannelForRuntime === "cron"
      ? DEFAULT_CRON_TEMPERATURE
      : resolvedChannelForRuntime === "heartbeat"
      ? DEFAULT_HEARTBEAT_TEMPERATURE
      : DEFAULT_INTERACTIVE_TEMPERATURE;
  const heartbeatModelName = process.env.HEARTBEAT_MODEL_ID?.trim() || undefined;
  const heartbeatMaxTokensRaw = process.env.HEARTBEAT_MAX_TOKENS?.trim();
  const heartbeatMaxTokens =
    heartbeatMaxTokensRaw && Number.isFinite(Number(heartbeatMaxTokensRaw))
      ? Math.max(128, Math.floor(Number(heartbeatMaxTokensRaw)))
      : undefined;
  const model = createChatModel({
    temperature: modelTemperature,
    modelName:
      resolvedChannelForRuntime === "heartbeat" ? heartbeatModelName : undefined,
    maxTokens: resolvedChannelForRuntime === "heartbeat" ? heartbeatMaxTokens : undefined,
  });

  const shouldLoadShortTerm =
    !input.autoApproveTools && resolvedChannelForRuntime !== "heartbeat";
  const priorRaw = shouldLoadShortTerm
    ? await getSessionMessages(db, sessionId, 12)
    : [];
  const routingContext = deriveSkillRoutingContext(
    priorRaw,
    message,
    input.businessBrain
  );

  // ── Operational case binding ────────────────────────────────────────
  // Si el caller pasó `caseId`, cargamos el caso + eventos recientes y
  // forzamos la skill del case_type (binding directo, salta el selector).
  // El bloque de contexto "[Caso operacional]" se construye aquí y se
  // concatena al system prompt más abajo.
  let operationalCaseContextBlock = "";
  let resolvedForcedSkillId = input.forcedSkillId ?? null;
  let boundOperationalStepKey: string | null = null;
  const resolvedToolCallSource = resolveToolCallSource(input);
  if (input.caseId) {
    try {
      const opCase = await getOperationalCase(db, input.caseId);
      if (!opCase) {
        console.warn(
          `[ops-case] caseId=${input.caseId} not found; ignoring binding`
        );
      } else if (opCase.user_id !== input.userId) {
        console.warn(
          `[ops-case] caseId=${input.caseId} belongs to ${opCase.user_id}, not turn user ${input.userId}; ignoring binding`
        );
      } else {
        boundOperationalStepKey = opCase.current_step ?? null;
        const caseType = await getOperationalCaseTypeById(
          db,
          opCase.case_type_id
        );
        const recentEvents = await getRecentOperationalCaseEvents(
          db,
          opCase.id,
          15
        );
        operationalCaseContextBlock = buildOperationalCaseContextBlock({
          caseRow: opCase,
          caseTypeRow: caseType,
          events: recentEvents,
        });
        if (caseType?.default_skill_slug) {
          if (!resolvedForcedSkillId) {
            resolvedForcedSkillId = caseType.default_skill_slug;
          }
          console.log(
            `[ops-case] caseId=${opCase.id} type=${opCase.case_type} step=${opCase.current_step ?? "(none)"} → forcing skill=${resolvedForcedSkillId}`
          );
        }
      }
    } catch (err) {
      console.error(
        `[ops-case] failed to load case ${input.caseId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // ── V1-B pre-graph: skill selection ────────────────────────────────
  // Run BEFORE buildLangChainTools so that `isToolAvailable()` can
  // intersect the tool list with the active skill's `allowed_tools`.
  // Skipped on resume (the user is approving an in-flight tool call;
  // narrowing the tool set mid-flight would be confusing) and when the
  // turn has no user message.
  let activeSkill: ResolvedSkill | undefined;
  // Snapshot of the selector outcome for the executive turn log. Stays
  // `undefined` when the selector did not run (resume HITL / empty turn).
  let skillSelectionSnapshot: TurnSummaryInput["skillSelection"];
  if (resolvedForcedSkillId && !resumeDecision) {
    try {
      const registry = await getSkillRegistryForUser(input.db, input.userId);
      const registrySize = registry.list().length;
      const registryRoot = getCachedSkillsRegistryRoot() ?? undefined;
      activeSkill = await resolveSkill(resolvedForcedSkillId, registry);
      console.log(
        `[skills] active=${activeSkill.rootName} reason=${input.caseId ? "case_binding" : "forced"} session=${sessionId} channel=${channel ?? "web"}`
      );
      skillSelectionSnapshot = {
        active: activeSkill.rootName,
        reason: "forced",
        allowedTools: activeSkill.allowedTools,
        requiresTenantContext: activeSkill.requiresTenantContext,
        registryRoot,
        registrySize,
      };
    } catch (err) {
      console.warn(
        `[skills] forced skill failed; continuing without a skill: ${err instanceof Error ? err.message : String(err)}`
      );
      skillSelectionSnapshot = {
        active: "none",
        reason: "forced_skill_failed",
      };
    }
  } else if (
    resolvedChannelForRuntime !== "heartbeat" &&
    !resumeDecision &&
    message &&
    message.trim() !== ""
  ) {
    try {
      const registry = await getSkillRegistryForUser(input.db, input.userId);
      const registryList = registry.list();
      const registrySize = registryList.length;
      const registryRoot = getCachedSkillsRegistryRoot() ?? undefined;
      if (registrySize > 0) {
        const candidateSlugs = buildEnabledSkillCandidateSlugs(
          registryList.map((s) => s.name),
          input.enabledSkills
        );
        if (
          isPropertyOptioningIntent(message) &&
          skillCandidateIsEnabled("property-optioning-coach", candidateSlugs)
        ) {
          activeSkill = await resolveSkill("property-optioning-coach", registry);
          console.log(
            `[skills] active=property-optioning-coach reason=deterministic_property_optioning session=${sessionId} channel=${channel ?? "web"}`
          );
          skillSelectionSnapshot = {
            active: "property-optioning-coach",
            reason: "deterministic_property_optioning",
            allowedTools: activeSkill.allowedTools,
            requiresTenantContext: activeSkill.requiresTenantContext,
            registryRoot,
            registrySize,
          };
        } else {
        const selectorModel = createSkillSelectorModel();
        const selection = await selectSkillForTurn({
          userMessage: message,
          registry,
          candidateSlugs,
          model: selectorModel,
          channel,
          routingContext,
        });
        if (
          selection.kind === "active" &&
          !input.autoApproveTools &&
          shouldRouteFromContinuity(routingContext) &&
          routingContext.lastActiveSkill === "lead-follow-up-draft" &&
          selection.skillId !== routingContext.lastActiveSkill &&
          skillCandidateIsEnabled(routingContext.lastActiveSkill, candidateSlugs)
        ) {
          activeSkill = await resolveSkill(routingContext.lastActiveSkill, registry);
          console.log(
            `[skills] active=${routingContext.lastActiveSkill} reason=routing_context_override selected=${selection.skillId} session=${sessionId} channel=${channel ?? "web"}`
          );
          skillSelectionSnapshot = {
            active: routingContext.lastActiveSkill,
            reason: "routing_context_override",
            allowedTools: activeSkill.allowedTools,
            requiresTenantContext: activeSkill.requiresTenantContext,
            registryRoot,
            registrySize,
          };
        } else if (selection.kind === "active") {
          activeSkill = selection.resolved;
          console.log(
            `[skills] active=${selection.skillId} session=${sessionId} channel=${channel ?? "web"}`
          );
          skillSelectionSnapshot = {
            active: selection.skillId,
            allowedTools: selection.resolved.allowedTools,
            requiresTenantContext: selection.resolved.requiresTenantContext,
            registryRoot,
            registrySize,
          };
        } else if (
          !input.autoApproveTools &&
          shouldRouteFromContinuity(routingContext)
        ) {
          const skillId = routingContext.lastActiveSkill ?? "company-data";
          if (!skillCandidateIsEnabled(skillId, candidateSlugs)) {
            console.log(
              `[skills] active=none reason=skill_disabled skill=${skillId} session=${sessionId} channel=${channel ?? "web"}`
            );
            skillSelectionSnapshot = {
              active: "none",
              reason: "skill_disabled",
              registryRoot,
              registrySize,
            };
          } else {
            activeSkill = await resolveSkill(skillId, registry);
            console.log(
              `[skills] active=${skillId} reason=routing_context session=${sessionId} channel=${channel ?? "web"}`
            );
            skillSelectionSnapshot = {
              active: skillId,
              reason: "routing_context",
              allowedTools: activeSkill.allowedTools,
              requiresTenantContext: activeSkill.requiresTenantContext,
              registryRoot,
              registrySize,
            };
          }
        } else if (
          !input.autoApproveTools &&
          isShortMonthPeriodFollowUp(message) &&
          recentMessagesSuggestCompanyData(priorRaw)
        ) {
          if (!skillCandidateIsEnabled("company-data", candidateSlugs)) {
            console.log(
              `[skills] active=none reason=skill_disabled skill=company-data session=${sessionId} channel=${channel ?? "web"}`
            );
            skillSelectionSnapshot = {
              active: "none",
              reason: "skill_disabled",
              registryRoot,
              registrySize,
            };
          } else {
            activeSkill = await resolveSkill("company-data", registry);
            console.log(
              `[skills] active=company-data reason=follow_up_month session=${sessionId} channel=${channel ?? "web"}`
            );
            skillSelectionSnapshot = {
              active: "company-data",
              reason: "follow_up_month",
              allowedTools: activeSkill.allowedTools,
              requiresTenantContext: activeSkill.requiresTenantContext,
              registryRoot,
              registrySize,
            };
          }
        } else {
          console.log(
            `[skills] active=none reason=${selection.reason} session=${sessionId} channel=${channel ?? "web"}`
          );
          skillSelectionSnapshot = {
            active: "none",
            reason: selection.reason,
            registryRoot,
            registrySize,
          };
        }
        }
      } else {
        console.log(
          `[skills] active=none reason=empty_registry session=${sessionId} root=${registryRoot ?? "(unresolved)"}`
        );
        skillSelectionSnapshot = {
          active: "none",
          reason: "empty_registry",
          registryRoot,
          registrySize,
        };
      }
    } catch (err) {
      // Skill selection is best-effort: a failure here must NOT take down
      // the turn. The agent simply runs without a skill.
      console.warn(
        `[skills] selection failed; continuing without a skill: ${err instanceof Error ? err.message : String(err)}`
      );
      skillSelectionSnapshot = {
        active: "none",
        reason: "selection_threw",
      };
    }
  }
  emitEvent({
    type: "skill_selected",
    message: activeSkill
      ? `Habilidad seleccionada: ${activeSkill.rootName}.`
      : "Sin habilidad especializada para este turno.",
    skillId: activeSkill?.rootName,
    details: {
      active: activeSkill?.rootName ?? "none",
      reason:
        skillSelectionSnapshot && "reason" in skillSelectionSnapshot
          ? skillSelectionSnapshot.reason
          : undefined,
      composedFrom: activeSkill?.composedFrom,
    },
  });

  const businessBrainWarehouse = getBusinessBrainWarehouse(input.businessBrain);
  const skillNeedsTenantContext = Boolean(
    activeSkill?.requiresTenantContext ||
      activeSkill?.allowedTools.includes("bigquery_lookup_local_comparables") ||
      activeSkill?.allowedTools.includes("bigquery_run_query")
  );
  const lcTools = buildLangChainTools({
    db,
    userId,
    sessionId,
    turnId,
    enabledTools,
    integrations,
    githubToken,
    userTimezone,
    googleCalendarAccessToken,
    lastUserMessage: message ?? "",
    activeSkillAllowedTools: activeSkill?.allowedTools,
    activeSkillName: activeSkill?.rootName,
    activeSkillReferenceNames: activeSkill?.composedFrom,
    channel: resolvedChannelForRuntime,
    enabledSkills: input.enabledSkills,
    tenantOrganizationId:
      skillNeedsTenantContext
        ? businessBrainWarehouse?.organization_id?.trim() || undefined
        : undefined,
    bigQueryProjectId: businessBrainWarehouse?.project_id?.trim() || undefined,
    bigQueryLocation: businessBrainWarehouse?.location?.trim() || undefined,
    caseId: input.caseId ?? null,
    operationalStepKey: boundOperationalStepKey,
    toolCallSource: resolvedToolCallSource,
    toolApprovalPolicy: input.toolApprovalPolicy,
  });
  emitEvent({
    type: "tools_bound",
    message:
      lcTools.length > 0
        ? `${lcTools.length} herramientas disponibles para el turno.`
        : "Sin herramientas enlazadas para este turno.",
    details: {
      count: lcTools.length,
      tools: lcTools
        .map((tool) => tool.name)
        .filter((name): name is string => Boolean(name)),
      narrowedBySkill: Boolean(activeSkill?.allowedTools?.length),
    },
  });

  const modelWithTools = lcTools.length > 0 ? model.bindTools(lcTools) : model;

  const now = new Date();
  const dateContext = `\n\n[Contexto temporal — generado automáticamente]\nFecha y hora actual del servidor: ${now.toISOString()}\nZona del usuario: ${userTimezone ?? "UTC"}\nFecha local del usuario: ${now.toLocaleDateString("es-MX", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: userTimezone ?? "UTC" })}\nHora local: ${now.toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", timeZone: userTimezone ?? "UTC" })}\nCuando el usuario dice "mañana", "hoy", "la próxima semana", etc., calcula las fechas ISO a partir de ESTA fecha. NUNCA uses fechas de 2023, 2024 ni 2025 salvo que el usuario las indique explícitamente.`;

  // Bloque de datos canónicos del perfil del usuario (email/phone).
  // Solo se incluye cuando hay al menos un dato; si los campos están vacíos
  // el agente pedirá al usuario en el momento o no los conocerá.
  const userProfileLines: string[] = [];
  if (userName && userName.trim()) {
    userProfileLines.push(`- Nombre del usuario: ${userName.trim()}`);
  }
  if (userEmail && userEmail.trim()) {
    userProfileLines.push(`- Email del usuario: ${userEmail.trim()}`);
  }
  if (userPhone && userPhone.trim()) {
    userProfileLines.push(`- Teléfono del usuario: ${userPhone.trim()}`);
  }
  const orgName = businessBrainWarehouse?.org_name?.trim();
  const orgId = businessBrainWarehouse?.organization_id?.trim();
  if (orgName) {
    userProfileLines.push(`- Inmobiliaria del usuario: ${orgName}`);
  }
  if (orgId) {
    userProfileLines.push(`- organization_id de la inmobiliaria: ${orgId}`);
  }
  const userProfileBlock =
    userProfileLines.length > 0
      ? `\n\n[Datos de contacto del usuario — NO los pidas, ya los conoces]\n${userProfileLines.join("\n")}\n- Estos datos son canónicos (vienen del perfil). Úsalos directamente cuando el usuario pida "pásale mi email a X" o equivalente. No los confundas con emails/teléfonos de terceros que el usuario pueda haber mencionado.`
      : "";

  const ambiguityAddendum = `\n\n[Reglas de desambiguación — obligatorias]\n- Respuestas cortas del usuario como "sí", "ok", "dale", "va", "hazlo", "procede", "no", "cancela": interprétalas SIEMPRE en el contexto del ÚLTIMO turno TUYO inmediatamente anterior. Si tu último turno prometió una acción concreta en un dominio (archivos, calendario, github, bash) pero NO llamaste a la herramienta, ahora debes llamar a la herramienta DIRECTAMENTE con los parámetros ya acordados. No elijas otra acción de otro dominio sólo porque aparezca en el historial lejano.\n- Si no tienes una acción claramente pendiente en tu turno anterior, responde pidiendo clarificación al usuario (una sola pregunta corta) en vez de asumir. Nunca "adivines" creando eventos, archivos o repos para reusar datos de turnos viejos.\n- Nunca pidas confirmación en TEXTO para acciones que tienen herramienta con riesgo medio/alto: la herramienta ya disparará su propia tarjeta de confirmación. Genera el tool_call y deja que el sistema pida la aprobación.`;

  // V1-B: when a skill is active, prepend the playbook BEFORE the
  // tool-specific addendum chain. The chain layers tool guidance on top of
  // domain context — that ordering matters because tool rules sometimes
  // *override* generic phrasing the skill might use.
  const baseSystemPrompt =
    systemPrompt + userProfileBlock + dateContext + ambiguityAddendum;
  const baseWithBrain = appendBusinessBrainContextBlock(
    baseSystemPrompt,
    input.businessBrain ?? {},
    { agentName: systemPrompt ? undefined : input.businessBrain?.agent_identity?.name }
  );
  const baseWithSkill = activeSkill
    ? baseWithBrain + buildPlaybookInjection(activeSkill)
    : baseWithBrain;
  const baseWithCase = operationalCaseContextBlock
    ? baseWithSkill + operationalCaseContextBlock
    : baseWithSkill;

  // V1-C-α: tenant context block. Solo se inyecta si la skill activa pide
  // `requires_tenant_context: true` Y hay business brain o admin flag —
  // así, conversaciones sin skill o con skills que no tocan datos
  // multi-tenant no pagan el costo del bloque.
  const envBigqueryProject =
    process.env.BIGQUERY_PROJECT_ID?.trim() || undefined;
  const envBigqueryLocation =
    process.env.BIGQUERY_LOCATION?.trim() || undefined;
  const tenantContextWired = appendTenantContextBlock(baseWithCase, {
    requiresTenantContext: activeSkill?.requiresTenantContext ?? false,
    businessBrain: input.businessBrain ?? {},
    isUnggaAdmin: input.isUnggaAdmin ?? false,
    userMessage: message,
    defaultProjectId: envBigqueryProject,
    defaultLocation: envBigqueryLocation,
  });
  const baseWithTenant = tenantContextWired.prompt;
  // Snapshot of the tenant context for the executive turn log. Captures
  // both the "did not run" path (skill didn't request it) and the actual
  // values that ended up in the system prompt.
  const tenantContextSnapshot: TurnSummaryInput["tenantContext"] =
    tenantContextWired.result
      ? {
          applied: true,
          mode: tenantContextWired.result.mode,
          organizationId: tenantContextWired.result.organizationId,
          mentionedOrgName: tenantContextWired.result.mentionedOrgName,
          bigqueryProject:
            businessBrainWarehouse?.project_id ?? envBigqueryProject,
          bigqueryLocation:
            businessBrainWarehouse?.location ?? envBigqueryLocation,
        }
      : {
          applied: false,
          reason:
            activeSkill === undefined
              ? "no active skill"
              : activeSkill.requiresTenantContext
                ? "skill requested it but block returned empty"
                : "skill does not require tenant context",
        };
  if (tenantContextWired.result) {
    console.log(
      `[tenant-context] mode=${tenantContextWired.result.mode}` +
        (tenantContextWired.result.organizationId
          ? ` org_id=${tenantContextWired.result.organizationId}`
          : "") +
        (tenantContextWired.result.mentionedOrgName
          ? ` mentioned="${tenantContextWired.result.mentionedOrgName}"`
          : "") +
        ` skill=${activeSkill?.rootName ?? "none"} session=${sessionId}`
    );
  }

  let effectiveSystemPrompt = appendManageScheduledTasksRules(
    appendScheduleTaskRules(
      appendFileToolsRules(
        appendCalendarToolRules(
          appendGithubSocialRules(
            appendBashRules(
              appendGithubCreateToolRules(
                baseWithTenant,
                lcTools as Array<{ name?: string }>
              ),
              lcTools as Array<{ name?: string }>
            ),
            lcTools as Array<{ name?: string }>
          ),
          lcTools as Array<{ name?: string }>
        ),
        lcTools as Array<{ name?: string }>
      ),
      lcTools as Array<{ name?: string }>
    ),
    lcTools as Array<{ name?: string }>
  );
  if (input.autoApproveTools) {
    effectiveSystemPrompt =
      effectiveSystemPrompt.trimEnd() + CRON_SCHEDULED_EXECUTION_ADDENDUM;
  }
  emitEvent({
    type: "context_prepared",
    message: "Contexto base, memoria corta y reglas operativas preparadas.",
    details: {
      priorMessages: priorRaw.length,
      hasBusinessBrain: Boolean(input.businessBrain),
      hasActiveSkill: Boolean(activeSkill),
    },
  });

  // Override agresivo cuando se detecta intención clara de programar y la
  // herramienta schedule_task está disponible: el modelo tiende a anunciar
  // "Voy a programar..." sin emitir el tool_call. Esta nota va al final del
  // system prompt para que pese más que las reglas generales.
  const toolNamesAvailable = new Set(
    (lcTools as Array<{ name?: string }>)
      .map((t) => t.name)
      .filter((n): n is string => Boolean(n))
  );
  const companyDataQueryCorrection = `[CORRECCIÓN INTERNA — COMPANY-DATA]\nLa skill company-data está activa y este turno pide una métrica o período de datos de negocio. Tu respuesta anterior intentó cerrar sin llamar a bigquery_run_query. Eso no está permitido aunque el historial contenga un número previo.\n\nAhora emite exactamente el/los tool_call(s) bigquery_run_query necesarios para el MENSAJE ACTUAL del usuario: "${(message ?? "").replace(/\n/g, " ").slice(0, 200)}". Si el mensaje actual nombra un solo período, consulta SOLO ese período. No respondas texto final hasta recibir el resultado de BigQuery.`;
  const memoryCurateCorrection = `[CORRECCIÓN INTERNA — MEMORY-CURATE]\nLa skill memory-curate está activa para el mensaje actual del usuario: "${(message ?? "").replace(/\n/g, " ").slice(0, 200)}". Tu respuesta anterior intentó contestar o confirmar cambios usando historial conversacional. Eso no está permitido para recuerdos de largo plazo porque el estado activo puede haber cambiado.\n\nDebes emitir ahora un tool_call apropiado antes de responder:\n- Si el usuario pregunta qué recuerdas sobre un tema/persona, usa search_user_memories con ese tema.\n- Si pide listar recuerdos o qué recuerdas de él/ella en general, usa list_user_memories con status="active".\n- Si está confirmando archivar/borrar recuerdos mostrados inmediatamente antes, emite archive_user_memory/delete_user_memory usando los UUID completos previamente mostrados o vuelve a buscar/listar si no estás seguro.\nNo vuelvas a listar recuerdos desde historial ni memoria inyectada.`;
  if (
    !input.autoApproveTools &&
    !resumeDecision &&
    message &&
    toolNamesAvailable.has("schedule_task") &&
    userMessageIsScheduleIntent(message)
  ) {
    effectiveSystemPrompt =
      effectiveSystemPrompt.trimEnd() +
      `

[ATAJO — ESTE TURNO]
- El último mensaje del usuario es claramente una petición para PROGRAMAR una tarea ("${message.replace(/\n/g, " ").slice(0, 200)}").
- DEBES emitir un tool_call a schedule_task en este MISMO turno con los datos disponibles. PROHIBIDO escribir texto del tipo "Voy a programar...", "Voy a proceder...", "Programaré...". Si lo haces sin emitir el tool_call, el sistema no programa nada y el usuario no recibe nada.
- Si te falta UN dato esencial (hora exacta o cuál es el qué), haz UNA sola pregunta corta y NADA más; no anuncies que vas a programar.
- "cada N minutos/horas/días" → schedule_type="recurring" con cron_expr (p.ej. "*/5 * * * *" para cada 5 min).
- "en N minutos" o "hoy a las HH:MM" → schedule_type="one_time" con run_at en ISO 8601 con offset de la zona del usuario.`;
  }

  if (
    !input.autoApproveTools &&
    !resumeDecision &&
    activeSkill?.rootName === "company-data" &&
    message &&
    toolNamesAvailable.has("bigquery_run_query")
  ) {
    effectiveSystemPrompt =
      effectiveSystemPrompt.trimEnd() +
      `

[ATAJO — COMPANY-DATA ESTE TURNO]
- REGLA #1 — UN SOLO PERÍODO POR TURNO. El mensaje actual del usuario es: "${message.replace(/\n/g, " ").slice(0, 200)}". Cuenta los meses/períodos nombrados explícitamente en ESE texto. Si nombra UN solo mes, debes emitir EXACTAMENTE UN tool_call de \`bigquery_run_query\` y devolver UN solo número en la respuesta final. NO emitas tool_calls paralelos para meses adicionales aunque el historial muestre que en turnos pasados hayas devuelto varios meses. Está prohibido contestar con bloques tipo "Total de leads en X" + "Total de leads en Y" cuando el usuario sólo preguntó por X.
- REGLA #2 — Antes de emitir tool_calls, escribe mentalmente la lista de períodos del MENSAJE ACTUAL. Si la lista tiene 1 elemento, sólo 1 tool_call. Si la lista tiene 2+ elementos (p. ej. "compárame abril vs marzo"), entonces 2 tool_calls está permitido.
- REGLA #3 — IGNORA respuestas previas del asistente que mezclaron meses extra a los preguntados: son bugs antiguos. No copies su formato. Cualquier mensaje anterior marcado como "[respuesta histórica descartada — …]" debe tratarse como inexistente.
- El selector activó la skill \`company-data\`. Debes resolver este turno con al menos un tool_call a \`bigquery_run_query\` antes de responder. No contestes métricas usando respuestas previas del historial ni memoria.
- Si el usuario usa una continuación breve ("y en marzo", "y en abril", "¿y ese mes?"), interpreta el dominio y métrica desde el turno anterior inmediato, pero calcula el nuevo período desde el texto actual y consulta SOLO ese período.
- Si el texto actual menciona explícitamente un mes/período, ese período gana sobre cualquier período anterior.`;
  }

  if (
    !input.autoApproveTools &&
    !resumeDecision &&
    activeSkill?.rootName === "lead-follow-up-draft" &&
    message &&
    toolNamesAvailable.has("bigquery_run_query")
  ) {
    effectiveSystemPrompt =
      effectiveSystemPrompt.trimEnd() +
      `

[ATAJO — LEAD-FOLLOW-UP-DRAFT ESTE TURNO]
- El mensaje actual del usuario es: "${message.replace(/\n/g, " ").slice(0, 200)}".
- REGLA #1 — IDENTIFICADOR EN SCOPE. Antes de redactar nada, decide si el usuario te dio un identificador del lead EN ESTE turno (nombre, teléfono, email o lead_id explícito), o si está respondiendo a una pregunta tuya inmediatamente anterior que pedía ese dato. Un nombre que viene de turnos viejos del historial NO está en scope; está prohibido reusar nombres del historial sin que el usuario lo haya re-confirmado en este turno.
- REGLA #2 — SIN IDENTIFICADOR. Si no hay identificador en scope, NO redactes ningún mensaje, NO uses corchetes/placeholders y NO copies un texto previo del asistente. Pide al usuario UN dato concreto (nombre, teléfono o email) en una sola pregunta corta y termina el turno.
- REGLA #3 — CON IDENTIFICADOR. Si hay identificador en scope, DEBES llamar primero a \`read_skill_reference\` con \`name="lead-context"\` y luego emitir UN tool_call a \`bigquery_run_query\` usando el SQL de esa referencia (con \`@organization_id\` del [Contexto de tenant] y el identificador del usuario). Está prohibido redactar antes de recibir el resultado.
- REGLA #4 — DESAMBIGUACIÓN. Después de la query: 0 filas → di que no encontraste al lead y pide teléfono o email; 1 fila → redacta con esos datos (propiedad/desarrollo, última interacción, últimos mensajes); 2+ filas → pide al usuario que elija mostrando disambiguadores cortos (portal, last_interaction, propiedad). No redactes hasta que se resuelva.
- REGLA #5 — Tu respuesta anterior pudo haber redactado un mensaje genérico desde el historial. Eso fue un error y no debe repetirse en este turno.`;
  }

  // DEBUG: descomentar las siguientes 2 líneas para ver el system prompt completo en la terminal del servidor
  // console.log("=== SYSTEM PROMPT ===\n", effectiveSystemPrompt, "\n=== END ===");
  // console.log("=== TOOLS REGISTERED ===", lcTools.map((t) => t.name).join(", "), "=== END ===");

  // Limitamos el contexto histórico para reducir contaminación entre turnos
  // (p. ej. un "sí" aislado que el modelo asocie a una acción vieja de otro dominio).
  // EN MODO CRON (autoApproveTools=true) NO cargamos historia: la sesión "cron"
  // se reutiliza para todas las ejecuciones del usuario, así que tras 3-4 runs
  // la historia está llena de prompts/respuestas repetidas (incluyendo posibles
  // "Un momento, por favor" antiguos) que confunden al modelo y lo hacen
  // imitar el patrón fallido. Cada ejecución cron debe arrancar limpia.
  //
  // Cuando la skill activa es company-data, además sanitizamos en la VISTA del
  // modelo (no en DB) las respuestas de assistant que mezclaron varios meses
  // cuando el usuario sólo preguntó por uno. Sin esto el modelo imita el
  // patrón "respondí dos meses la última vez" y vuelve a hacer múltiples
  // tool_calls de bigquery_run_query en este turno aunque el [ATAJO] lo
  // prohíba expresamente. Ver `skills/sanitize-history.ts`.
  const priorRawForModel =
    activeSkill?.rootName === "company-data"
      ? sanitizeCompanyDataHistory(priorRaw)
      : priorRaw;
  const priorMessages: BaseMessage[] = priorRawForModel.map((m) => {
    if (m.role === "user") return new HumanMessage(m.content);
    if (m.role === "assistant") return new AIMessage(m.content);
    return new HumanMessage(m.content);
  });
  // Breakdown por rol para el dashboard (v1 Lite).
  const priorUserCount = priorRaw.filter((m) => m.role === "user").length;
  const priorAssistantCount = priorRaw.filter((m) => m.role === "assistant").length;
  const priorToolCount = priorRaw.filter((m) => m.role === "tool").length;

  if (!resumeDecision) {
    if (!message) {
      throw new Error("message is required for non-resume agent calls");
    }
    const memoryExtractionPayload = buildMemoryExtractionPayload(activeSkill);
    await addMessage(
      db,
      sessionId,
      "user",
      message,
      memoryExtractionPayload
        ? { structured_payload: memoryExtractionPayload, turn_id: turnId }
        : { turn_id: turnId }
    );
  }

  const toolCallNames: string[] = [];
  const appliedSkills = buildAppliedSkills(activeSkill);
  let bigQueryExecutionErrorCount = 0;
  let companyDataQueryCorrectionCount = 0;
  let leadContextQueryCorrectionCount = 0;
  let memoryCurateCorrectionCount = 0;

  const leadIdentifierRequest =
    "Claro. Para redactarlo con contexto real, compárteme el nombre, teléfono o correo del lead.";
  const leadContextCorrection = `[CORRECCIÓN INTERNA — LEAD-FOLLOW-UP-DRAFT]\nLa skill lead-follow-up-draft está activa y este turno trae un identificador del lead ("${(message ?? "").replace(/\n/g, " ").slice(0, 200)}"). Tu respuesta anterior intentó cerrar sin llamar a bigquery_run_query. Está prohibido redactar mensajes basándote en nombres del historial sin consultar la base.\n\nEmite ahora dos tool_calls en orden: 1) read_skill_reference con name="lead-context"; 2) bigquery_run_query usando el SQL de esa referencia, con @organization_id del [Contexto de tenant] y el identificador del usuario en @lead_name / @lead_phone / @lead_email según corresponda. NO simplifiques el SELECT final: debe incluir propiedad/desarrollo y recent_messages. Si la query encuentra solo nombre/lead_id pero no devuelve propiedad, recent_messages, last_message, last_interaction ni dialog_state, NO redactes un mensaje genérico; di que encontraste el lead pero falta contexto para personalizar y pide propiedad o última interacción.`;

  async function agentNode(
    state: GraphStateType
  ): Promise<Partial<GraphStateType>> {
    if (
      !input.autoApproveTools &&
      !resumeDecision &&
      shouldAskLeadIdentifierBeforeDraft({
        activeSkill,
        message,
        priorMessages: priorRaw,
      })
    ) {
      return { messages: [new AIMessage(leadIdentifierRequest)] };
    }

    const response = await modelWithTools.invoke(state.messages);
    // Incrementamos iterationCount SÓLO cuando el modelo pidió herramientas.
    // El reducer aditivo hace el resto. Necesario para que shouldContinue
    // respete MAX_TOOL_ITERATIONS aunque el compaction_node haya borrado
    // AIMessages viejos con tool_calls.
    const asAI = response as AIMessage;
    const hasToolCalls = Boolean(asAI.tool_calls?.length);
    if (
      !hasToolCalls &&
      companyDataQueryCorrectionCount < 1 &&
      shouldRequireCompanyDataQueryForTurn({
        activeSkill,
        message,
        toolNamesAvailable,
        toolCallNames,
      })
    ) {
      companyDataQueryCorrectionCount += 1;
      return {
        messages: [response, new HumanMessage(companyDataQueryCorrection)],
      };
    }
    if (
      !hasToolCalls &&
      leadContextQueryCorrectionCount < 1 &&
      shouldRequireLeadContextLookupForTurn({
        activeSkill,
        message,
        priorMessages: priorRaw,
        toolNamesAvailable,
        toolCallNames,
      })
    ) {
      leadContextQueryCorrectionCount += 1;
      return {
        messages: [response, new HumanMessage(leadContextCorrection)],
      };
    }
    if (
      !hasToolCalls &&
      memoryCurateCorrectionCount < 1 &&
      shouldRequireMemoryCurateToolForTurn({
        activeSkill,
        message,
        toolNamesAvailable,
        toolCallNames,
      })
    ) {
      memoryCurateCorrectionCount += 1;
      return {
        messages: [response, new HumanMessage(memoryCurateCorrection)],
      };
    }
    return hasToolCalls
      ? { messages: [response], iterationCount: 1 }
      : { messages: [response] };
  }

  function graphToolCallMetadata(
    overrides?: Partial<import("@agents/types").ToolCallMetadata>
  ) {
    return buildToolCallMetadata(
      {
        caseId: input.caseId,
        operationalStepKey: boundOperationalStepKey,
        activeSkillName: activeSkill?.rootName,
        channel: resolvedChannelForRuntime,
        toolCallSource: resolvedToolCallSource,
      },
      overrides
    );
  }

  async function toolExecutorNode(
    state: GraphStateType
  ): Promise<Partial<GraphStateType>> {
    const lastMsg = state.messages[state.messages.length - 1];
    if (!(lastMsg instanceof AIMessage) || !lastMsg.tool_calls?.length) {
      return {};
    }

    const { ToolMessage } = await import("@langchain/core/messages");
    const results: BaseMessage[] = [];

    function confirmationMessage(
      toolName: string,
      args: Record<string, unknown>,
      extras: { memoryContent?: string | null; memoryAlreadyArchived?: boolean } = {}
    ): string {
      const short = (s: string, max = 140) =>
        s.length > max ? `${s.slice(0, max).trim()}…` : s;
      const recurringScheduleLabel = (
        cronExpr: unknown,
        timezone: unknown
      ): string => {
        const cron = String(cronExpr ?? "").trim();
        const tz = String(timezone ?? userTimezone ?? "UTC");
        const everyMinutes = cron.match(/^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/);
        if (everyMinutes) return `cada ${everyMinutes[1]} minutos`;
        const hourly = cron.match(/^(\d+)\s+\*\s+\*\s+\*\s+\*$/);
        if (hourly) return `cada hora, al minuto ${hourly[1]}`;
        return `${cron || "frecuencia recurrente"} (${tz})`;
      };
      if (toolName === "archive_user_memory") {
        const id = String(args.memory_id ?? "");
        const content = extras.memoryContent?.trim();
        const alreadyNote = extras.memoryAlreadyArchived
          ? "\n(Este recuerdo ya estaba archivado; aprobar no cambia nada.)"
          : "";
        if (content) {
          return `Confirma archivar este recuerdo (reversible):\n\n«${content}»\n\nID: ${id}${alreadyNote}`;
        }
        return `Confirma archivar este recuerdo (reversible):\nID: ${id}${alreadyNote}`;
      }
      if (toolName === "delete_user_memory") {
        const id = String(args.memory_id ?? "");
        const content = extras.memoryContent?.trim();
        if (content) {
          return `Confirma borrar definitivamente este recuerdo (irreversible):\n\n«${content}»\n\nID: ${id}`;
        }
        return `Confirma borrar definitivamente este recuerdo (irreversible):\nID: ${id}`;
      }
      if (toolName === "github_create_repo") {
        return `Se necesita tu confirmación para crear el repositorio "${String(args.name ?? "")}"${args.private ? " (privado)" : ""}.`;
      }
      if (toolName === "github_create_issue") {
        return `Se necesita tu confirmación para crear el issue "${String(args.title ?? "")}" en ${String(args.owner ?? "")}/${String(args.repo ?? "")}.`;
      }
      if (toolName === "calendar_create_event") {
        const fmt = (iso: unknown): string => {
          try {
            const d = new Date(String(iso));
            if (isNaN(d.getTime())) return String(iso);
            return d.toLocaleString("es-MX", {
              weekday: "long",
              year: "numeric",
              month: "long",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
              timeZone: userTimezone ?? "America/Mexico_City",
            });
          } catch {
            return String(iso);
          }
        };
        return `Confirma crear el evento "${String(args.summary ?? "")}" de ${fmt(args.start_datetime)} a ${fmt(args.end_datetime)}.`;
      }
      if (toolName === "calendar_update_event") {
        return `Confirma actualizar el evento ${String(args.event_id ?? "")}.`;
      }
      if (toolName === "calendar_delete_event") {
        return `Confirma eliminar el evento ${String(args.event_id ?? "")}.`;
      }
      if (toolName === "bash") {
        const term = String(args.terminal ?? "default");
        const p = String(args.prompt ?? "");
        const preview = p.length > 200 ? `${p.slice(0, 200)}…` : p;
        return `Confirma ejecutar en el servidor (etiqueta: "${term}") el comando:\n${preview}`;
      }
      if (toolName === "write_file") {
        const p = String(args.path ?? "");
        const c = String(args.content ?? "");
        const bytes = Buffer.byteLength(c, "utf8");
        return `Confirma escribir (crear o sobrescribir) el archivo \`${p}\` en el workspace del servidor (${bytes} bytes).`;
      }
      if (toolName === "edit_file") {
        const p = String(args.path ?? "");
        const oldS = String(args.old_string ?? "");
        const newS = String(args.new_string ?? "");
        return `Confirma editar el archivo \`${p}\`: reemplazar\n«${short(oldS)}»\npor\n«${short(newS)}».`;
      }
      if (toolName === "schedule_task") {
        const prompt = String(args.prompt ?? "");
        const type = String(args.schedule_type ?? "");
        const title = String(args.display_title ?? "").trim();
        const taskLine = title || short(prompt);
        if (type === "one_time") {
          const when = args.run_at
            ? (() => {
                try {
                  return new Date(String(args.run_at)).toLocaleString("es-MX", {
                    weekday: "long",
                    year: "numeric",
                    month: "long",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                    timeZone: userTimezone ?? "UTC",
                  });
                } catch {
                  return String(args.run_at);
                }
              })()
            : "hora no especificada";
          return `Programar tarea para ${when}.\n\nTarea: «${taskLine}»`;
        }
        return `Programar tarea recurrente ${recurringScheduleLabel(args.cron_expr, args.timezone)}.\n\nTarea: «${taskLine}»`;
      }
      return `Confirma ejecutar la herramienta ${toolName}.`;
    }

    function invalidMemoryMutationArgs(
      toolName: string,
      args: Record<string, unknown>
    ): { status: "validation_error"; error: string } | null {
      if (
        toolName !== "archive_user_memory" &&
        toolName !== "delete_user_memory"
      ) {
        return null;
      }
      const memoryId = String(args.memory_id ?? "");
      const uuidRe =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      if (uuidRe.test(memoryId)) return null;
      return {
        status: "validation_error",
        error:
          "memory_id must be a full UUID returned by list_user_memories or search_user_memories. Do not invent ids or use shortened prefixes; list/search memories again and ask the user to choose from the real ids.",
      };
    }

    async function existingScheduleTaskResult(
      args: Record<string, unknown>
    ): Promise<Record<string, unknown> | null> {
      const prompt = typeof args.prompt === "string" ? args.prompt : "";
      const scheduleType =
        args.schedule_type === "one_time" || args.schedule_type === "recurring"
          ? args.schedule_type
          : null;
      if (!prompt || !scheduleType) return null;

      let query = db
        .from("scheduled_tasks")
        .select(
          "id, prompt, display_title, skill_id, schedule_type, run_at, cron_expr, timezone, next_run_at, status"
        )
        .eq("user_id", userId)
        .eq("prompt", prompt)
        .eq("schedule_type", scheduleType)
        .in("status", ["active", "paused"])
        .order("created_at", { ascending: false })
        .limit(1);

      if (scheduleType === "recurring") {
        const cronExpr =
          typeof args.cron_expr === "string" ? args.cron_expr.trim() : "";
        const timezone =
          (typeof args.timezone === "string" && args.timezone.trim()) ||
          userTimezone ||
          "UTC";
        if (!cronExpr) return null;
        query = query.eq("cron_expr", cronExpr).eq("timezone", timezone);
      } else {
        const runAt = typeof args.run_at === "string" ? args.run_at : "";
        const runAtTime = new Date(runAt).getTime();
        if (!Number.isFinite(runAtTime)) return null;
        query = query.eq("run_at", new Date(runAtTime).toISOString());
      }

      const { data, error } = await query.maybeSingle();
      if (error || !data) return null;
      const row = data as Record<string, unknown>;
      return {
        ok: true,
        already_scheduled: true,
        task_id: row.id,
        schedule_type: row.schedule_type,
        next_run_at: row.next_run_at,
        timezone: row.timezone,
        prompt: row.prompt,
        display_title: row.display_title ?? null,
        skill_id: row.skill_id ?? null,
      };
    }

    // ── Dedup de tool_calls IDÉNTICAS dentro del MISMO mensaje del modelo ──
    // Causa raíz observada: modelos pequeños (p. ej. gpt-4o-mini) a veces
    // emiten la misma acción de negocio idempotente dos veces en el array
    // `tool_calls` de un solo turno (DOCX duplicado, Telegram duplicado).
    // Aquí colapsamos esos duplicados ANTES de ejecutar: la primera llamada
    // corre normal; las repetidas reciben un ToolMessage que reutiliza el
    // resultado de la canónica, sin segundo render/envío ni fila de auditoría.
    const sameMessageSeenKeyToId = new Map<string, string>();
    const sameMessageDuplicates: Array<{
      tc: (typeof lastMsg.tool_calls)[number];
      canonicalId: string;
    }> = [];
    const callsToExecute: typeof lastMsg.tool_calls = [];
    for (const tc of lastMsg.tool_calls) {
      const key = idempotentSameMessageDedupKey(
        tc.name,
        (tc.args as Record<string, unknown>) ?? {},
        input.caseId ?? undefined
      );
      if (key) {
        const canonicalId = sameMessageSeenKeyToId.get(key);
        if (canonicalId && tc.id) {
          sameMessageDuplicates.push({ tc, canonicalId });
          continue;
        }
        if (tc.id) sameMessageSeenKeyToId.set(key, tc.id);
      }
      callsToExecute.push(tc);
    }

    for (const tc of callsToExecute) {
      const matchingTool = lcTools.find((t) => t.name === tc.name);
      toolCallNames.push(tc.name);
      if (matchingTool) {
        const invalidMemoryArgs = invalidMemoryMutationArgs(
          tc.name,
          (tc.args as Record<string, unknown>) ?? {}
        );
        if (invalidMemoryArgs) {
          results.push(
            new ToolMessage({
              content: JSON.stringify(invalidMemoryArgs),
              tool_call_id: tc.id!,
            })
          );
          continue;
        }

        const needsConfirmation = toolRequiresConfirmation(tc.name);
        const toolArgs = (tc.args as Record<string, unknown>) ?? {};
        const approvalMode = resolveToolApprovalMode({
          toolName: tc.name,
          toolArgs,
          requiresConfirmation: needsConfirmation,
          autoApproveTools: state.autoApproveTools,
          policy: input.toolApprovalPolicy,
        });
        let trackedToolCallId: string | null = null;

        if (
          resumeDecision === "approve" &&
          tc.name === "schedule_task" &&
          (needsConfirmation || approvalMode === "request_approval")
        ) {
          const existingSchedule = await existingScheduleTaskResult(toolArgs);
          if (existingSchedule) {
            results.push(
              new ToolMessage({
                content: JSON.stringify(existingSchedule),
                tool_call_id: tc.id!,
              })
            );
            continue;
          }
        }

        if (approvalMode === "deny") {
          const deniedPayload = {
            status: "denied",
            error: `La herramienta ${tc.name} no está permitida por la política de esta automatización.`,
            tool: tc.name,
          };
          try {
            const record = await createToolCall(
              db,
              state.sessionId,
              tc.name,
              toolArgs,
              false,
              turnId,
              { metadata: graphToolCallMetadata() }
            );
            await updateToolCallStatus(db, record.id, "failed", deniedPayload);
          } catch (auditErr) {
            console.error("[agent] failed to audit denied tool:", auditErr);
          }
          results.push(
            new ToolMessage({
              content: JSON.stringify(deniedPayload),
              tool_call_id: tc.id!,
            })
          );
          continue;
        }

        if (needsConfirmation || approvalMode === "request_approval") {
          // Auto-approve mode: cron runner of a scheduled task.
          // The user already approved the schedule_task itself; bothering them
          // again at execution time defeats the purpose of "scheduled".
          if (approvalMode === "auto_execute") {
            // Tools de negocio (generate_document, notify_user, etc.) ya
            // crean su fila en tool_calls dentro del handler; una fila previa
            // aquí duplicaba la auditoría sin ejecutar la tool dos veces.
            if (!toolOwnsAuditTrail(tc.name)) {
              const toolCallRecord = await createToolCall(
                db,
                state.sessionId,
                tc.name,
                toolArgs,
                false,
                turnId,
                { metadata: graphToolCallMetadata() }
              );
              trackedToolCallId = toolCallRecord.id;
              await updateToolCallStatus(db, toolCallRecord.id, "approved");
            }
          } else {
            const existing = await findExistingPendingToolCall(
              db,
              state.sessionId,
              tc.name,
              toolArgs,
              turnId
            );
            const toolCallRecord =
              existing ??
              (await createToolCall(
                db,
                state.sessionId,
                tc.name,
                toolArgs,
                true,
                turnId,
                { metadata: graphToolCallMetadata() }
              ));
            trackedToolCallId = toolCallRecord.id;
            let memoryContent: string | null = null;
            let memoryAlreadyArchived = false;
            if (
              tc.name === "archive_user_memory" ||
              tc.name === "delete_user_memory"
            ) {
              const rawId = (tc.args as Record<string, unknown>)?.memory_id;
              if (typeof rawId === "string" && rawId.length > 0) {
                try {
                  const snapshot = await getMemoryById(db, {
                    userId,
                    memoryId: rawId,
                  });
                  if (snapshot) {
                    memoryContent = snapshot.content ?? null;
                    memoryAlreadyArchived = Boolean(snapshot.archived_at);
                  }
                } catch (e) {
                  console.warn(
                    "[agent] confirmation pre-fetch getMemoryById failed:",
                    e
                  );
                }
              }
            }
            emitEvent({
              type: "confirmation_required",
              message: `Gu necesita aprobación para ejecutar ${tc.name}.`,
              toolName: tc.name,
              details: { toolCallId: toolCallRecord.id },
            });
            const decision = interrupt({
              tool_call_id: toolCallRecord.id,
              tool_name: tc.name,
              message: confirmationMessage(tc.name, tc.args, {
                memoryContent,
                memoryAlreadyArchived,
              }),
              args: toolArgs,
            }) as "approve" | "reject";
            if (decision !== "approve") {
              await updateToolCallStatus(db, toolCallRecord.id, "rejected");
              results.push(
                new ToolMessage({
                  content: JSON.stringify({
                    message: "Acción cancelada por el usuario.",
                  }),
                  tool_call_id: tc.id!,
                })
              );
              continue;
            }
            await updateToolCallStatus(db, toolCallRecord.id, "approved");
          }
        }

        if (
          activeSkill?.rootName === "company-data" &&
          tc.name === "bigquery_run_query" &&
          bigQueryExecutionErrorCount >= 2
        ) {
          const retryLimitPayload = {
            status: "validation_error",
            error:
              "BigQuery retry limit reached for this turn after repeated execution_error results. Stop retrying tools, explain the SQL problem briefly, and ask the user to let the developer inspect the generated query/reference pattern.",
          };
          try {
            const record = await createToolCall(
              db,
              state.sessionId,
              tc.name,
              (tc.args as Record<string, unknown>) ?? {},
              false,
              turnId,
              { metadata: graphToolCallMetadata() }
            );
            await updateToolCallStatus(
              db,
              record.id,
              "failed",
              retryLimitPayload
            );
          } catch (e) {
            console.error("[agent] bigquery retry-limit audit row failed:", e);
          }
          results.push(
            new ToolMessage({
              content: JSON.stringify(retryLimitPayload),
              tool_call_id: tc.id!,
            })
          );
          continue;
        }

        emitEvent({
          type: "tool_started",
          message: `Ejecutando herramienta: ${tc.name}.`,
          toolName: tc.name,
        });
        let result: unknown;
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          result = await (matchingTool as any).invoke(tc.args);
        } catch (err) {
          const rawMessage = err instanceof Error ? err.message : String(err);
          const serialized =
            rawMessage === "[object Object]"
              ? (() => {
                  try {
                    return JSON.stringify(err);
                  } catch {
                    return rawMessage;
                  }
                })()
              : rawMessage;
          const message = serialized && serialized !== "{}" ? serialized : rawMessage;
          const payload = {
            status: "validation_error",
            error: message,
            tool: tc.name,
            hint:
              "Tool input did not match the expected schema. Retry with only documented fields and omit unknown or null values.",
          };
          console.warn(
            `[agent] tool invocation failed name=${tc.name} error=${message}`
          );
          try {
            const record = await createToolCall(
              db,
              state.sessionId,
              tc.name,
              (tc.args as Record<string, unknown>) ?? {},
              false,
              turnId,
              { metadata: graphToolCallMetadata() }
            );
            await updateToolCallStatus(db, record.id, "failed", payload);
          } catch (auditErr) {
            console.error("[agent] failed to audit tool validation error:", auditErr);
          }
          results.push(
            new ToolMessage({
              content: JSON.stringify(payload),
              tool_call_id: tc.id!,
            })
          );
          continue;
        }
        const resultStr = String(result);
        results.push(
          new ToolMessage({ content: resultStr, tool_call_id: tc.id! })
        );

        if (
          activeSkill?.rootName === "company-data" &&
          tc.name === "bigquery_run_query"
        ) {
          try {
            const parsed = JSON.parse(resultStr) as Record<string, unknown>;
            if (parsed.status === "execution_error") {
              bigQueryExecutionErrorCount += 1;
            }
          } catch {
            // Non-JSON tool output is handled by the normal audit path below.
          }
        }

        if (trackedToolCallId) {
          try {
            const parsed = JSON.parse(resultStr) as Record<string, unknown>;
            const hasError =
              typeof parsed === "object" &&
              parsed !== null &&
              typeof parsed.error === "string";
            if (hasError) {
              await updateToolCallStatus(
                db,
                trackedToolCallId,
                "failed",
                parsed
              );
              emitEvent({
                type: "tool_completed",
                message: `La herramienta ${tc.name} falló.`,
                toolName: tc.name,
                details: { status: "failed", toolCallId: trackedToolCallId },
              });
            } else {
              await updateToolCallStatus(
                db,
                trackedToolCallId,
                "executed",
                parsed
              );
              emitEvent({
                type: "tool_completed",
                message: `La herramienta ${tc.name} terminó.`,
                toolName: tc.name,
                details: { status: "executed", toolCallId: trackedToolCallId },
              });
            }
          } catch {
            await updateToolCallStatus(db, trackedToolCallId, "executed", {
              raw: resultStr,
            });
            emitEvent({
              type: "tool_completed",
              message: `La herramienta ${tc.name} terminó.`,
              toolName: tc.name,
              details: { status: "executed", toolCallId: trackedToolCallId },
            });
          }
        } else {
          emitEvent({
            type: "tool_completed",
            message: `La herramienta ${tc.name} terminó.`,
            toolName: tc.name,
            details: { status: "executed" },
          });
        }
      } else {
        const unavailablePayload: Record<string, unknown> = {
          error: "tool_not_available",
          tool_name: tc.name,
          message:
            "Esta herramienta no está disponible (integración inactiva, herramienta deshabilitada o no cargada en el servidor). Di al usuario qué falta sin inventar datos — p. ej. conectar Google Calendar en Ajustes si pidió calendarios.",
        };
        try {
          const record = await createToolCall(
            db,
            state.sessionId,
            tc.name,
            (tc.args as Record<string, unknown>) ?? {},
            false,
            turnId,
            { metadata: graphToolCallMetadata() }
          );
          await updateToolCallStatus(db, record.id, "failed", unavailablePayload);
        } catch (e) {
          console.error("[agent] tool_not_available audit row failed:", e);
        }
        emitEvent({
          type: "tool_completed",
          message: `La herramienta ${tc.name} no está disponible.`,
          toolName: tc.name,
          details: { status: "failed", reason: "tool_not_available" },
        });
        results.push(
          new ToolMessage({
            content: JSON.stringify(unavailablePayload),
            tool_call_id: tc.id!,
          })
        );
      }
    }

    // Resuelve los duplicados del mismo mensaje reutilizando el resultado de
    // su llamada canónica (ya ejecutada arriba), sin re-ejecutar la tool.
    for (const { tc, canonicalId } of sameMessageDuplicates) {
      if (!tc.id) continue;
      const canonical = results.find(
        (msg) =>
          msg instanceof ToolMessage &&
          (msg as InstanceType<typeof ToolMessage>).tool_call_id === canonicalId
      ) as InstanceType<typeof ToolMessage> | undefined;
      const baseContent =
        canonical && typeof canonical.content === "string"
          ? canonical.content
          : "";
      let content: string;
      try {
        const parsed = baseContent ? JSON.parse(baseContent) : {};
        content = JSON.stringify({
          ...(parsed && typeof parsed === "object" ? parsed : {}),
          status: "deduplicated_same_turn",
          deduped_same_message: true,
          original_tool_call_id: canonicalId,
          ...(tc.name === "generate_document_from_template"
            ? { skipped_render: true }
            : {}),
          ...(tc.name === "telegram_send_message_to_contact"
            ? { skipped_send: true }
            : {}),
          hint: "El modelo emitió esta tool dos veces en el mismo mensaje; se reutilizó el resultado de la primera llamada sin re-ejecutarla.",
        });
      } catch {
        content =
          baseContent ||
          JSON.stringify({
            status: "deduplicated_same_turn",
            deduped_same_message: true,
            original_tool_call_id: canonicalId,
          });
      }
      results.push(new ToolMessage({ content, tool_call_id: tc.id }));
    }

    return { messages: results };
  }

  function shouldContinue(state: GraphStateType): string {
    const lastMsg = state.messages[state.messages.length - 1];
    if (lastMsg instanceof AIMessage && lastMsg.tool_calls?.length) {
      // Usamos el contador propio del estado (reducer aditivo en agentNode)
      // en lugar de derivar de messages: así el guard sigue aplicando aunque
      // compaction_node haya limpiado AIMessages con tool_calls viejos.
      if ((state.iterationCount ?? 0) >= MAX_TOOL_ITERATIONS) return "end";
      return "tools";
    }
    if (isInternalCorrectionMessage(lastMsg)) {
      return "agent";
    }
    return "end";
  }

  const compactionModel = createCompactionModel();
  const compactionNode = createCompactionNode({ compactionModel });
  // Long-term memory: nodo al inicio del grafo. En resume HITL y en cron
  // (autoApproveTools=true) se comporta como no-op — no toca SystemMessage
  // ni llama a OpenRouter. Ver `memory_injection_node.ts`.
  const memoryInjectionNode = createMemoryInjectionNode({
    db,
    userId,
    isResume: Boolean(resumeDecision),
  });

  const graph = new StateGraph(GraphState)
    .addNode("memory_injection", memoryInjectionNode)
    .addNode("compaction", compactionNode)
    .addNode("agent", agentNode)
    .addNode("tools", toolExecutorNode)
    .addEdge("__start__", "memory_injection")
    .addEdge("memory_injection", "compaction")
    .addEdge("compaction", "agent")
    .addConditionalEdges("agent", shouldContinue, {
      agent: "agent",
      tools: "tools",
      end: "__end__",
    })
    .addEdge("tools", "compaction");

  const checkpointer = await getCheckpointer();
  const app = graph.compile({ checkpointer });

  // Each new (non-resume) call gets a fresh thread_id so the checkpoint's
  // appending message reducer doesn't accumulate stale context across turns.
  // Resume calls MUST reuse the thread_id from the interrupted run.
  const threadId = resumeDecision
    ? checkpointThreadId ?? sessionId
    : `${sessionId}-${Date.now()}`;

  const config = {
    configurable: { thread_id: threadId },
    streamMode: ["values", "updates"] as StreamMode[],
  };

  const graphInput = resumeDecision
    ? new Command({ resume: resumeDecision })
    : {
        messages: [
          new SystemMessage(effectiveSystemPrompt),
          ...priorMessages,
          new HumanMessage(message!),
        ],
        sessionId,
        userId,
        systemPrompt,
        pendingConfirmation: null,
        autoApproveTools: input.autoApproveTools ?? false,
        channel: resolvedChannelForRuntime,
        compactionCount: 0,
        iterationCount: 0,
        memoryFlushPending: false,
      };

  /** Populated from stream "updates" chunks when interrupt() fires (not present on state schema). */
  let interruptsFromStream: Array<{ value?: unknown }> | undefined;

  function normalizeStreamChunk(raw: unknown): { mode: string; payload: unknown } | null {
    if (!Array.isArray(raw) || raw.length < 2) return null;
    if (raw.length === 2) {
      return { mode: String(raw[0]), payload: raw[1] };
    }
    // Subgraphs / some builds yield [namespace, mode, payload]
    return { mode: String(raw[1]), payload: raw[2] };
  }

  function extractInterruptsFromUpdatesPayload(
    payload: unknown
  ): Array<{ value?: unknown }> | undefined {
    if (!payload || typeof payload !== "object") return undefined;
    const p = payload as Record<string, unknown>;
    const top = p.__interrupt__;
    if (Array.isArray(top) && top.length > 0) {
      return top as Array<{ value?: unknown }>;
    }
    for (const v of Object.values(p)) {
      if (v && typeof v === "object" && "__interrupt__" in (v as object)) {
        const ir = (v as Record<string, unknown>).__interrupt__;
        if (Array.isArray(ir) && ir.length > 0) {
          return ir as Array<{ value?: unknown }>;
        }
      }
    }
    return undefined;
  }

  const stream = await app.stream(graphInput, config);
  for await (const raw of stream) {
    const parsed = normalizeStreamChunk(raw);
    if (!parsed) continue;
    if (parsed.mode === "updates") {
      const ir = extractInterruptsFromUpdatesPayload(parsed.payload);
      if (ir?.length) interruptsFromStream = ir;
    }
  }

  const snapshot = await app.getState({ configurable: { thread_id: threadId } });
  const finalState = snapshot.values as GraphStateType;
  if (!finalState) {
    throw new Error("LangGraph checkpoint has no state values");
  }

  // Memoria inyectada + snapshot del prompt (opción A hacia v2): derivado
  // del SystemMessage y ventana de mensajes final, sin leer archivos de log.
  const firstMsg = finalState.messages?.[0];
  const memFromSystem =
    firstMsg instanceof SystemMessage
      ? extractMemoriaUserBlockStats(
          normalizeMessageContentToString(firstMsg.content)
        )
      : {
          injected: false,
          matchesCount: 0,
          memoryBlockChars: 0,
          memoryItemPreviews: [] as string[],
        };
  const memoryUsed = buildAppliedMemory({
    memoryItemPreviews: memFromSystem.memoryItemPreviews,
    shortTermMessageCount: priorRawForModel.length,
    shortTermPreviews: buildShortTermMemoryPreviews(priorRawForModel),
    includeShortTerm: shouldLoadShortTerm,
  });
  emitEvent({
    type: "memory_applied",
    message:
      memoryUsed.length > 0
        ? `${memoryUsed.length} bloques de memoria disponibles para este turno.`
        : "Sin memoria específica registrada para este turno.",
    details: {
      count: memoryUsed.length,
      shortTermCount: memoryUsed.filter((memory) => memory.source === "short_term")
        .length,
      longTermCount: memoryUsed.filter((memory) => memory.source === "long_term")
        .length,
    },
  });

  let pending: PendingConfirmation | null = null;
  const interrupts =
    interruptsFromStream ??
    (finalState as { __interrupt__?: Array<{ value?: unknown }> }).__interrupt__;
  if (interrupts?.length) {
    const payload = interrupts[0]?.value as
      | {
          tool_call_id?: string;
          tool_name?: string;
          message?: string;
          args?: Record<string, unknown>;
        }
      | undefined;
    if (
      payload?.tool_call_id &&
      payload.tool_name &&
      payload.message &&
      payload.args
    ) {
      pending = {
        toolCallId: payload.tool_call_id,
        toolName: payload.tool_name,
        message: payload.message,
        args: payload.args,
        turnId,
        appliedSkills,
        memoryUsed,
        checkpointThreadId: threadId,
      };
      await addMessage(db, sessionId, "assistant", payload.message, {
        tool_call_id: payload.tool_call_id,
        turn_id: turnId,
        structured_payload: {
          type: "pending_confirmation",
          ...(buildMemoryExtractionPayload(activeSkill) ?? {}),
          memoryUsed,
          pendingConfirmation: pending,
        },
      });
    }
  }

  let responseText = "";
  if (!pending) {
    responseText = getLastAssistantText(finalState.messages);

    if (!responseText && resumeDecision === "reject") {
      responseText = "Acción cancelada por el usuario.";
    }

    // Si el grafo terminó sin texto pero SÍ hubo llamadas a herramientas,
    // probablemente tocamos MAX_TOOL_ITERATIONS con un tool_call pendiente.
    // En ese caso forzamos una última invocación del modelo SIN herramientas
    // para que produzca un resumen final con lo que ya aprendió. Esto evita
    // el fallback genérico "No pude generar una respuesta" cuando el agente
    // sí trabajó, solo que se quedó sin iteraciones para cerrar.
    if (!responseText.trim() && toolCallNames.length > 0) {
      try {
        const wrapupResponse = await model.invoke([
          new SystemMessage(FORCED_TEXT_WRAPUP_INSTRUCTION),
          ...trimTrailingUnansweredToolCall(finalState.messages),
        ]);
        const wrapupText = normalizeMessageContentToString(
          (wrapupResponse as AIMessage).content
        );
        if (wrapupText.trim().length > 0) {
          responseText = wrapupText;
        }
      } catch (err) {
        console.error("[agent] forced wrap-up invocation failed:", err);
      }
    }

    if (!responseText.trim()) {
      responseText =
        "No pude generar una respuesta en este turno. Revisa integraciones y herramientas en Ajustes e inténtalo de nuevo.";
    }

    if (responseText.trim().length > 0) {
      const memoryExtractionPayload = buildMemoryExtractionPayload(activeSkill);
      const structuredPayload =
        memoryExtractionPayload || memoryUsed.length > 0
          ? { ...(memoryExtractionPayload ?? {}), memoryUsed }
          : undefined;
      await addMessage(
        db,
        sessionId,
        "assistant",
        responseText,
        structuredPayload
          ? { structured_payload: structuredPayload, turn_id: turnId }
          : { turn_id: turnId }
      );
    }
  }

  // ───────────────────────────────────────────────────────────
  // Dashboard ejecutivo (turn_summary.log) — v1 Lite.
  // Emite UN bloque consolidado por turno. Campos finos (sim score
  // por memoria, etapas de compaction) quedan en `memory.log` y
  // `compaction.log` respectivamente; aquí pintamos `n/a` y referenciamos.
  // Fire-and-forget: no bloquea la respuesta al usuario.
  // ───────────────────────────────────────────────────────────
  const resolvedChannel: TurnSummaryInput["channel"] =
    resolvedChannelForRuntime;

  const memTopK = resolveMemoryLogRetrieveTopK();
  const memThresh = resolveMemoryLogMatchThreshold();

  let retrieval: TurnSummaryInput["longTermRetrieval"];
  if (input.autoApproveTools) {
    retrieval = { skipped: true, reason: "cron (autoApproveTools=true)" };
  } else if (resumeDecision) {
    retrieval = { skipped: true, reason: `resume HITL (${resumeDecision})` };
  } else {
    retrieval = {
      skipped: false,
      injected: memFromSystem.injected,
      matchesCount: memFromSystem.matchesCount,
    };
  }

  const agentStatus: "completed" | "pending_hitl" | "error" = pending
    ? "pending_hitl"
    : "completed";

  const turnSummary: TurnSummaryInput = {
    startedAt: turnStartedAt,
    elapsedMs: Date.now() - turnStartedAt.getTime(),
    userId,
    userEmail: userEmail ?? null,
    sessionId,
    channel: resolvedChannel,
    turnId,
    threadId,
    userInput: message ?? null,
    profile: {
      timezone: userTimezone ?? null,
      email: userEmail ?? null,
      phone: userPhone ?? null,
    },
    shortTerm: !shouldLoadShortTerm
      ? { loadedCount: 0 }
      : {
          loadedCount: priorMessages.length,
          userCount: priorUserCount,
          assistantCount: priorAssistantCount,
          toolCount: priorToolCount,
        },
    integrationsActive: (integrations ?? [])
      .filter((i) => i.status === "active")
      .map((i) => i.provider),
    toolsEnabled: {
      enabled: (enabledTools ?? [])
        .filter((t) => t.enabled)
        .map((t) => t.tool_id),
    },
    longTermRetrieval: retrieval,
    memorySearchEnv: { topK: memTopK, matchThreshold: memThresh },
    routingContext,
    skillSelection: skillSelectionSnapshot,
    tenantContext: tenantContextSnapshot,
    promptSnapshot: buildPromptSnapshotFromMessages(finalState.messages),
    agentDecision: {
      model: CHAT_MODEL_ID,
      toolsCalled: toolCallNames,
      status: agentStatus,
    },
    // flushEval queda undefined: el bloque PRE/POST vive en memory.log como
    // evento TRIGGER — cruzable por timestamp con este turno.
  };
  // Fire-and-forget (no await): no bloqueamos el response.
  void writeTurnSummary(turnSummary);
  emitEvent({
    type: "turn_completed",
    message: pending
      ? "Turno pausado esperando confirmación humana."
      : "Turno completado.",
    details: {
      status: agentStatus,
      elapsedMs: turnSummary.elapsedMs,
      toolsCalled: toolCallNames,
    },
  });

  return {
    response: responseText,
    turnId,
    toolCalls: toolCallNames,
    appliedSkills,
    memoryUsed,
    pendingConfirmation: pending,
    memoryFlushPending: Boolean(finalState.memoryFlushPending),
  };
}
