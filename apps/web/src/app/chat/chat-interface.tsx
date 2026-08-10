"use client";

import {
  memo,
  useCallback,
  useState,
  useRef,
  useLayoutEffect,
  useEffect,
  useMemo,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import ReactMarkdown from "react-markdown";
import {
  formatSkillForUserPanel,
  formatSkillRole,
  type AppliedSkillDisplay,
} from "@/lib/skill-display";
import { formatToolForUserPanel } from "@/lib/tool-display";
import { CHAT_ATTACHMENT_ACCEPT } from "@/lib/chat/extract-attachment-text";
import { resolveUserMessageDisplay } from "@/lib/chat/attachment-message-display";
import {
  caseCoverPhotoApiPath,
  extractEasybrokerUrlFromSummaryText,
} from "@/lib/operational-cases/case-cover-photo";
import {
  buildWebHitlSubmitRequest,
  type WebHitlActionDef,
  WEB_HITL_MIRROR_KINDS,
} from "@/lib/operational-cases/web-hitl-client";

interface ChatAttachmentMeta {
  fileName: string;
  truncated?: boolean;
  sizeBytes?: number;
  downloadUrl?: string;
  contentType?: string;
  /** Click-through for image previews (e.g. EasyBroker listing). */
  href?: string;
  label?: string;
}

interface PendingAttachment {
  version?: 1;
  fileId?: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  text: string;
  truncated: boolean;
  storageBucket: string;
  storagePath: string;
  sha256: string;
  suggestedKind: string;
}

interface Message {
  id?: string;
  role: string;
  content: string;
  created_at?: string;
  turn_id?: string | null;
  structured_payload?: Record<string, unknown> | null;
}

interface PendingConfirmation {
  toolCallId: string;
  toolName: string;
  message: string;
  args: Record<string, unknown>;
  turnId?: string | null;
  appliedSkills?: AppliedSkillDisplay[];
  memoryUsed?: AppliedMemoryDisplay[];
}

interface AppliedMemoryDisplay {
  source: "short_term" | "long_term";
  type?: "episodic" | "semantic" | "procedural";
  content: string;
  count?: number;
  previews?: ShortTermMemoryPreview[];
}

interface ShortTermMemoryPreview {
  role: string;
  content: string;
  created_at?: string;
}

interface RecentToolCall {
  id: string;
  turn_id?: string | null;
  tool_name: string;
  arguments_json?: Record<string, unknown> | null;
  result_json?: Record<string, unknown> | null;
  status: string;
  requires_confirmation: boolean;
  created_at: string;
  finished_at?: string | null;
  /**
   * `agent` (default) — the LLM issued this call during a turn.
   * `deterministic` — the system issued the read (e.g. a Heartbeat
   *   prefetcher) before the LLM and persisted it under the same turn_id.
   * Drives the `IA` / `Determinístico` badge in the tools panel.
   */
  executor_kind?: "agent" | "deterministic" | null;
}

interface RecentLearning {
  id: string;
  type: "episodic" | "semantic" | "procedural";
  content: string;
  created_at: string;
}

interface AvailableSkill {
  id: string;
  scope: "business" | "personal" | "shared";
}

interface AvailableTool {
  id: string;
  requiresIntegration?: string | null;
}

interface HeartbeatStatus {
  enabled: boolean;
  intervalMinutes: number;
  runs?: Array<{
    status: "running" | "completed" | "error";
    startedAt: string;
    finishedAt?: string | null;
    summary: string;
    details?: Record<string, unknown>;
  }>;
  lastRun?: {
    status: "running" | "completed" | "error";
    startedAt: string;
    finishedAt?: string | null;
    summary: string;
    details?: Record<string, unknown>;
  } | null;
}

type ScheduledTaskDisplayStatus =
  | "active"
  | "paused"
  | "completed"
  | "failed"
  | "running";

interface ScheduledTaskSummary {
  activeCount: number;
  pausedCount: number;
  runningCount?: number;
  tasks?: Array<{
    id: string;
    prompt: string;
    userRequest?: string | null;
    displayTitle?: string | null;
    skillId?: string | null;
    scheduleType: "one_time" | "recurring";
    nextRunAt: string | null;
    status: ScheduledTaskDisplayStatus;
  }>;
  nextTask?: {
    id: string;
    prompt: string;
    userRequest?: string | null;
    displayTitle?: string | null;
    skillId?: string | null;
    scheduleType: "one_time" | "recurring";
    nextRunAt: string | null;
    status: ScheduledTaskDisplayStatus;
  } | null;
  lastFailure?: string | null;
}

interface BaseContext {
  identity: {
    name?: string;
    role?: string;
    shortDescription?: string;
  };
  soul: {
    voice?: string;
    tone?: string;
    style?: string;
    brevity?: string;
  };
  businessContext: {
    kind?: string;
    markets?: string[];
    notes?: string;
  };
  operatingPreferences?: string;
}

type OperationalEventType =
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

interface OperationalEvent {
  type: OperationalEventType;
  turnId?: string;
  at?: string;
  message: string;
  toolName?: string;
  skillId?: string;
  details?: Record<string, unknown>;
}

interface Props {
  agentName: string;
  agentAvatarUrl?: string;
  agentEmoji?: string;
  userAvatarUrl?: string;
  userName?: string;
  baseContext?: BaseContext;
  availableSkills?: AvailableSkill[];
  availableTools?: AvailableTool[];
  initialMessages: Message[];
  initialToolCalls?: RecentToolCall[];
  initialPendingConfirmation?: PendingConfirmation | null;
  initialRecentLearnings?: RecentLearning[];
  heartbeatStatus?: HeartbeatStatus;
  scheduledTaskSummary?: ScheduledTaskSummary;
  pendingInboxCount?: number;
}

function ChatAvatar({
  imageUrl,
  fallback,
  label,
  tone,
}: {
  imageUrl?: string;
  fallback: string;
  label: string;
  tone: "agent" | "user";
}) {
  return (
    <div
      className={`mt-1 flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full text-xs font-bold ${
        tone === "agent"
          ? "bg-violet-700 text-white shadow-sm shadow-violet-900/20"
          : "bg-white/80 text-neutral-700 ring-1 ring-neutral-200 dark:bg-white/10 dark:text-neutral-100 dark:ring-white/10"
      }`}
      title={label}
    >
      {imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={imageUrl} alt={label} className="h-full w-full object-cover" />
      ) : (
        fallback
      )}
    </div>
  );
}

function formatConfirmFailureMessage(result: Record<string, unknown> | undefined): string {
  if (!result) return "Error desconocido";
  const base = typeof result.error === "string" ? result.error : "Error";
  const details = result.details;
  if (details && typeof details === "object") {
    const d = details as Record<string, unknown>;
    if (typeof d.message === "string") {
      return `${base}: ${d.message}`;
    }
  }
  if (typeof result.status === "number") {
    return `${base} (HTTP ${result.status})`;
  }
  return base;
}

function formatToolStatus(status: string): string {
  const labels: Record<string, string> = {
    pending_confirmation: "requiere aprobación",
    approved: "aprobada",
    rejected: "rechazada",
    executed: "ejecutada",
    failed: "falló",
  };
  return labels[status] ?? status;
}

function formatToolExecutor(
  kind?: "agent" | "deterministic" | null
): { label: string; tone: "agent" | "deterministic" } {
  if (kind === "deterministic") {
    return { label: "Determinístico", tone: "deterministic" };
  }
  return { label: "IA", tone: "agent" };
}

function toolExecutorBadgeClass(tone: "agent" | "deterministic"): string {
  return tone === "deterministic"
    ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-200"
    : "bg-violet-100 text-violet-700 dark:bg-violet-400/10 dark:text-violet-200";
}

const REDACTED_TECHNICAL_KEY_RE =
  /(token|secret|password|authorization|api[_-]?key|cookie)/i;

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function redactTechnicalPayload(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[truncated]";
  if (Array.isArray(value)) {
    return value.map((item) => redactTechnicalPayload(item, depth + 1));
  }
  if (isRecordLike(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (REDACTED_TECHNICAL_KEY_RE.test(key)) {
        out[key] = "[REDACTED]";
      } else {
        out[key] = redactTechnicalPayload(item, depth + 1);
      }
    }
    return out;
  }
  if (typeof value === "string" && value.length > 4000) {
    return `${value.slice(0, 4000)}…[truncated]`;
  }
  return value;
}

function formatTechnicalJson(value: unknown): string {
  try {
    return JSON.stringify(redactTechnicalPayload(value), null, 2) ?? "null";
  } catch {
    return "\"[unserializable]\"";
  }
}

function hasTechnicalToolDetail(tool: RecentToolCall): boolean {
  return Boolean(tool.arguments_json || tool.result_json);
}

function renderToolTechnicalDetail(tool: RecentToolCall): ReactNode {
  const args = tool.arguments_json ?? null;
  const result = tool.result_json ?? null;
  if (tool.tool_name === "bigquery_run_query") {
    const argsRecord = isRecordLike(args) ? args : {};
    const sql = typeof argsRecord.sql === "string" ? argsRecord.sql : "";
    const params =
      argsRecord.params !== undefined ? argsRecord.params : null;
    return (
      <div className="mt-2 space-y-2 rounded-xl border border-slate-200 bg-slate-50/70 p-3 dark:border-white/10 dark:bg-white/5">
        <div className="space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-600 dark:text-white/70">
            Consulta
          </p>
          <pre className="max-h-56 overflow-auto rounded border border-slate-200 bg-white p-2 font-mono text-[10px] text-slate-700 dark:border-white/10 dark:bg-neutral-950 dark:text-white/80">
            {sql || "-- SQL no disponible --"}
          </pre>
        </div>
        <div className="space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-600 dark:text-white/70">
            Params
          </p>
          <pre className="max-h-40 overflow-auto rounded border border-slate-200 bg-white p-2 font-mono text-[10px] text-slate-700 dark:border-white/10 dark:bg-neutral-950 dark:text-white/80">
            {formatTechnicalJson(params)}
          </pre>
        </div>
        <div className="space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-600 dark:text-white/70">
            Resultado
          </p>
          <pre className="max-h-56 overflow-auto rounded border border-slate-200 bg-white p-2 font-mono text-[10px] text-slate-700 dark:border-white/10 dark:bg-neutral-950 dark:text-white/80">
            {formatTechnicalJson(result)}
          </pre>
        </div>
      </div>
    );
  }
  return (
    <div className="mt-2 space-y-2 rounded-xl border border-slate-200 bg-slate-50/70 p-3 dark:border-white/10 dark:bg-white/5">
      <div className="space-y-1">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-600 dark:text-white/70">
          Arguments
        </p>
        <pre className="max-h-48 overflow-auto rounded border border-slate-200 bg-white p-2 font-mono text-[10px] text-slate-700 dark:border-white/10 dark:bg-neutral-950 dark:text-white/80">
          {formatTechnicalJson(args)}
        </pre>
      </div>
      <div className="space-y-1">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-600 dark:text-white/70">
          Result
        </p>
        <pre className="max-h-48 overflow-auto rounded border border-slate-200 bg-white p-2 font-mono text-[10px] text-slate-700 dark:border-white/10 dark:bg-neutral-950 dark:text-white/80">
          {formatTechnicalJson(result)}
        </pre>
      </div>
    </div>
  );
}

function toolDetailText(tool: RecentToolCall): string {
  const args = tool.arguments_json;
  if (!args) return "";
  if (tool.tool_name === "bigquery_run_query") return "";
  if (tool.tool_name === "read_skill_reference") return "";
  if (tool.tool_name === "bash") {
    const terminal =
      typeof args.terminal === "string" && args.terminal.trim()
        ? args.terminal.trim()
        : "";
    const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
    const prefix = terminal ? `terminal: ${terminal} · ` : "";
    return prompt ? `${prefix}${prompt}` : "";
  }
  const entries = Object.entries(args)
    .filter(([, value]) => typeof value === "string" || typeof value === "number")
    .slice(0, 3)
    .map(([key, value]) => `${key}: ${String(value)}`);
  return entries.join(" · ");
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function utf8ByteLength(value: string): number {
  if (!value) return 0;
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(value).length;
  }
  return value.length;
}

function toolResultSummary(tool: RecentToolCall): string {
  const result = tool.result_json;
  if (!result) return "";
  if (tool.tool_name === "bash") {
    const exitCode =
      typeof result.exitCode === "number" ? result.exitCode : null;
    const stdout = typeof result.stdout === "string" ? result.stdout : "";
    const stderr = typeof result.stderr === "string" ? result.stderr : "";
    const errorMsg = typeof result.error === "string" ? result.error : "";
    const stdoutBytes = utf8ByteLength(stdout);
    const parts: string[] = [];
    if (exitCode !== null) parts.push(`exitCode ${exitCode}`);
    if (stdoutBytes > 0) parts.push(`stdout ${formatBytes(stdoutBytes)}`);
    else parts.push("stdout vacío");
    if (errorMsg) parts.push(`error: ${errorMsg.slice(0, 120)}`);
    else if (stderr.trim() && exitCode !== 0)
      parts.push(`stderr: ${stderr.trim().slice(0, 120)}`);
    return parts.join(" · ");
  }
  if (tool.tool_name === "bigquery_run_query") {
    const status = typeof result.status === "string" ? result.status : "";
    if (status === "ok") return "";
    const error = typeof result.error === "string" ? result.error : "";
    if (error) return `error: ${error.slice(0, 120)}`;
    if (status) return `status ${status}`;
  }
  if (tool.tool_name === "read_skill_reference") {
    const status = typeof result.status === "string" ? result.status : "";
    if (status === "ok") return "";
    const message = typeof result.message === "string" ? result.message : "";
    if (message) return message.slice(0, 120);
    if (status) return `status ${status}`;
  }
  if (tool.tool_name === "calendar_list_events") {
    const events = Array.isArray(result.events) ? result.events : [];
    return `${events.length} evento${events.length === 1 ? "" : "s"}`;
  }
  if (tool.tool_name === "calendar_list_tasks") {
    const tasks = Array.isArray(result.tasks) ? result.tasks : [];
    return `${tasks.length} tarea${tasks.length === 1 ? "" : "s"}`;
  }
  const status = typeof result.status === "string" ? result.status : "";
  const ok = result.ok;
  if (status) return `status ${status}`;
  if (typeof ok === "boolean") return ok ? "ok" : "ok:false";
  return "";
}

function toolStatusClass(status: string): string {
  if (status === "executed") return "bg-emerald-500";
  if (status === "failed" || status === "rejected") return "bg-red-500";
  if (status === "pending_confirmation") return "bg-amber-500";
  return "bg-violet-500";
}

function scheduleConfirmationMatchesTask(
  confirmation: PendingConfirmation | null,
  tasks: ScheduledTaskSummary["tasks"]
): boolean {
  if (!confirmation || confirmation.toolName !== "schedule_task") return false;
  const prompt =
    typeof confirmation.args.prompt === "string" ? confirmation.args.prompt : "";
  const scheduleType = confirmation.args.schedule_type;
  if (
    !prompt ||
    (scheduleType !== "one_time" && scheduleType !== "recurring")
  ) {
    return false;
  }
  return (tasks ?? []).some(
    (task) =>
      task.prompt === prompt &&
      task.scheduleType === scheduleType &&
      (task.status === "active" ||
        task.status === "running" ||
        task.status === "paused")
  );
}

function formatToolTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("es-MX", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatBubbleTime(value: string | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("es-MX", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function dayKeyFromIso(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function isSameCalendarDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

function formatDaySeparator(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);

  let label: string;
  if (isSameCalendarDay(date, now)) {
    label = "Hoy";
  } else if (isSameCalendarDay(date, yesterday)) {
    label = "Ayer";
  } else if (date.getFullYear() === now.getFullYear()) {
    label = date.toLocaleDateString("es-MX", {
      weekday: "long",
      day: "numeric",
      month: "long",
    });
  } else {
    label = date.toLocaleDateString("es-MX", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  }
  return label.charAt(0).toUpperCase() + label.slice(1);
}

type ChatTimelineItem =
  | { type: "date"; key: string; label: string }
  | { type: "message"; key: string; message: Message; index: number };

function isPendingConfirmationMessage(message: Message): boolean {
  return message.structured_payload?.type === "pending_confirmation";
}

function buildChatTimeline(messages: Message[]): ChatTimelineItem[] {
  const items: ChatTimelineItem[] = [];
  let lastDayKey = "";
  messages.forEach((message, index) => {
    // El texto de HITL se muestra en la tarjeta Aprobar/Cancelar; el mensaje
    // persistido (y el sync) no debe duplicarlo como burbuja del chat.
    if (isPendingConfirmationMessage(message)) return;
    if (message.created_at) {
      const dayKey = dayKeyFromIso(message.created_at);
      if (dayKey && dayKey !== lastDayKey) {
        items.push({
          type: "date",
          key: `date-${dayKey}-${index}`,
          label: formatDaySeparator(message.created_at),
        });
        lastDayKey = dayKey;
      }
    }
    items.push({
      type: "message",
      key: message.id ?? `message-${index}`,
      message,
      index,
    });
  });
  return items;
}

function messageAttachmentMeta(message: Message): ChatAttachmentMeta[] {
  if (message.role === "user") {
    return resolveUserMessageDisplay({
      content: message.content,
      structuredPayload: message.structured_payload,
    }).attachments;
  }
  // Adjuntos del asistente (p. ej. DOCX de contract_review) viven en payload;
  // si falta el payload (mensajes viejos), inferimos el chip desde la URL
  // canónica del borrador embebida en el texto.
  const raw = message.structured_payload?.attachments;
  if (Array.isArray(raw) && raw.length > 0) {
    return raw.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const record = item as Record<string, unknown>;
      if (typeof record.fileName !== "string" || !record.fileName.trim()) {
        return [];
      }
      return [
        {
          fileName: record.fileName,
          ...(typeof record.downloadUrl === "string"
            ? { downloadUrl: record.downloadUrl }
            : {}),
          ...(typeof record.contentType === "string"
            ? { contentType: record.contentType }
            : {}),
          ...(typeof record.sizeBytes === "number"
            ? { sizeBytes: record.sizeBytes }
            : {}),
          ...(typeof record.href === "string" ? { href: record.href } : {}),
          ...(typeof record.label === "string" ? { label: record.label } : {}),
        },
      ];
    });
  }
  const draftUrlMatch = message.content.match(
    /https?:\/\/[^\s)\]>"']+\/api\/operational-cases\/[^/\s]+\/documents\/contract_draft\/download/i
  );
  if (!draftUrlMatch?.[0]) return [];
  return [
    {
      fileName: "contrato_comision.docx",
      downloadUrl: draftUrlMatch[0],
      contentType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    },
  ];
}

function messageDisplayText(message: Message): string {
  if (message.role !== "user") return message.content;
  return resolveUserMessageDisplay({
    content: message.content,
    structuredPayload: message.structured_payload,
  }).userText;
}

function isImageAttachment(attachment: ChatAttachmentMeta): boolean {
  return Boolean(
    attachment.contentType?.startsWith("image/") && attachment.downloadUrl
  );
}

/**
 * Preview visual del resumen final (paridad con link preview de Telegram).
 * Usa adjunto si existe; si no (mensajes ya espejados), infiere case_id + EB URL.
 */
function listingPublishedSummaryPreview(message: Message): {
  coverUrl: string;
  href: string | null;
  label: string;
} | null {
  if (message.role !== "assistant") return null;
  const payload = message.structured_payload;
  const kind = typeof payload?.kind === "string" ? payload.kind : "";
  const looksLikeSummary =
    kind === "listing_published_summary" ||
    /^\*\*Resumen final de publicación\*\*/i.test(message.content.trim()) ||
    /^Resumen final de publicación/i.test(message.content.trim());
  if (!looksLikeSummary) return null;

  const attachments = messageAttachmentMeta(message);
  const imageAttachment = attachments.find(isImageAttachment);
  if (imageAttachment?.downloadUrl) {
    return {
      coverUrl: imageAttachment.downloadUrl,
      href: imageAttachment.href?.trim() ||
        extractEasybrokerUrlFromSummaryText(message.content),
      label: imageAttachment.label?.trim() || "Ver en EasyBroker",
    };
  }

  const caseId =
    typeof payload?.case_id === "string" && payload.case_id.trim()
      ? payload.case_id.trim()
      : null;
  if (!caseId) return null;
  return {
    coverUrl: caseCoverPhotoApiPath(caseId),
    href: extractEasybrokerUrlFromSummaryText(message.content),
    label: "Ver en EasyBroker",
  };
}

function buildAgentMessageText(
  userText: string,
  attachments: PendingAttachment[]
): string {
  if (attachments.length === 0) return userText.trim();
  const blocks = attachments.map(
    (attachment) =>
      `### Archivo adjunto: ${attachment.fileName}\n${attachment.text}`
  );
  const trimmed = userText.trim();
  if (trimmed) {
    return `${trimmed}\n\n---\n${blocks.join("\n\n---\n")}`;
  }
  return blocks.join("\n\n---\n");
}

function formatOperationalEventTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("es-MX", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatMemorySource(memory: AppliedMemoryDisplay): string {
  if (memory.source === "short_term") {
    return typeof memory.count === "number"
      ? `Corto plazo · ${memory.count} mensajes previos`
      : "Corto plazo";
  }
  const labels: Record<NonNullable<AppliedMemoryDisplay["type"]>, string> = {
    episodic: "Episódica",
    semantic: "Semántica",
    procedural: "Procedimiento",
  };
  return memory.type ? `Largo plazo · ${labels[memory.type]}` : "Largo plazo";
}

function formatMemoryType(type: RecentLearning["type"]): string {
  const labels: Record<RecentLearning["type"], string> = {
    episodic: "Episódica",
    semantic: "Semántica",
    procedural: "Procedimiento",
  };
  return labels[type];
}

function formatLearningTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("es-MX", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatOperationalEventType(type: OperationalEventType): string {
  const labels: Record<OperationalEventType, string> = {
    turn_started: "Inicio",
    context_prepared: "Contexto",
    skill_selected: "Habilidad",
    tools_bound: "Herramientas",
    tool_started: "Ejecutando",
    tool_completed: "Herramienta",
    confirmation_required: "Confirmación",
    memory_applied: "Memoria",
    turn_completed: "Cierre",
    turn_failed: "Error",
  };
  return labels[type];
}

function operationalEventDotClass(type: OperationalEventType): string {
  if (type === "turn_failed") return "bg-red-500";
  if (type === "confirmation_required") return "bg-amber-500";
  if (type === "turn_started") return "bg-violet-500";
  if (type === "context_prepared") return "bg-emerald-500";
  if (type === "skill_selected") return "bg-fuchsia-500";
  if (type === "tools_bound") return "bg-indigo-500";
  if (type === "tool_started") return "bg-violet-500";
  if (type === "tool_completed" || type === "turn_completed") return "bg-emerald-500";
  if (type === "memory_applied") return "bg-sky-400";
  return "bg-slate-400 dark:bg-white/30";
}

function formatShortTermRole(role: string): string {
  const labels: Record<string, string> = {
    user: "Tú",
    assistant: "Gu",
    tool: "Herramienta",
    system: "Sistema",
  };
  return labels[role] ?? role;
}

function formatShortTermPreviewTime(value: string | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("es-MX", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function compactText(value: string | undefined, fallback = "No configurado"): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

function truncatePanelText(value: string, max = 150): string {
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max).trim()}…` : trimmed;
}

function displayScheduledTaskText(task: {
  prompt: string;
  userRequest?: string | null;
  displayTitle?: string | null;
}): string {
  return task.displayTitle?.trim() || task.userRequest?.trim() || task.prompt;
}

function formatScheduledTaskSkillLabel(skillId?: string | null): string {
  if (!skillId) return "";
  return `Habilidad: ${formatSkillForUserPanel(skillId)}`;
}

function formatScheduledTaskFailureForUser(error: string): string {
  const normalized = error.trim();
  const lower = normalized.toLowerCase();
  if (
    lower.includes("connection error") ||
    lower.includes("not queryable") ||
    lower.includes("fetch failed") ||
    lower.includes("econnreset") ||
    lower.includes("etimedout")
  ) {
    return "Fallo técnico transitorio de conexión. La tarea sigue activa y se reintentará automáticamente.";
  }
  return truncatePanelText(normalized, 120);
}

function formatScheduledTaskRunLabel(task: {
  nextRunAt: string | null;
  status: ScheduledTaskDisplayStatus;
}): string {
  if (task.status === "running") return "Ejecutándose ahora";
  if (task.status === "completed") return "Completada";
  if (task.status === "failed") return "Con error";
  if (task.nextRunAt) {
    const next = new Date(task.nextRunAt);
    const isPast = !Number.isNaN(next.getTime()) && next.getTime() <= Date.now();
    const label = isPast
      ? task.status === "active"
        ? "Pendiente desde"
        : "Fecha pasada"
      : "Próxima";
    return `${label}: ${formatLearningTime(task.nextRunAt)}`;
  }
  return task.status === "paused"
    ? "Pausada sin próxima ejecución."
    : "Sin próxima ejecución definida.";
}

function formatHeartbeatStatus(status: "running" | "completed" | "error"): string {
  const labels = {
    running: "En curso",
    completed: "Completado",
    error: "Con error",
  } as const;
  return labels[status] ?? String(status);
}

function formatScheduledTaskStatus(
  status: ScheduledTaskDisplayStatus
): string {
  const labels: Record<ScheduledTaskDisplayStatus, string> = {
    active: "Activa",
    paused: "Pausada",
    completed: "Completada",
    failed: "Con error",
    running: "Ejecutándose",
  };
  return labels[status] ?? String(status);
}

function formatScheduledTaskScheduleType(
  scheduleType: "one_time" | "recurring"
): string {
  return scheduleType === "one_time" ? "Única vez" : "Recurrente";
}

function scheduledTaskScheduleTypeClass(
  scheduleType: "one_time" | "recurring"
): string {
  return scheduleType === "one_time"
    ? "bg-slate-100 text-slate-700 dark:bg-white/10 dark:text-white/80"
    : "bg-sky-100 text-sky-800 dark:bg-sky-400/15 dark:text-sky-100";
}

function scheduledTaskStatusClass(
  status: ScheduledTaskDisplayStatus
): string {
  const classes: Record<ScheduledTaskDisplayStatus, string> = {
    active:
      "bg-violet-100 text-violet-800 dark:bg-white/10 dark:text-violet-100",
    paused:
      "bg-amber-100 text-amber-800 dark:bg-amber-400/10 dark:text-amber-100",
    completed:
      "bg-emerald-100 text-emerald-800 dark:bg-emerald-400/10 dark:text-emerald-100",
    failed:
      "bg-red-100 text-red-800 dark:bg-red-400/10 dark:text-red-100",
    running:
      "bg-sky-100 text-sky-800 dark:bg-sky-400/15 dark:text-sky-100",
  };
  return classes[status];
}

function stripMarkdown(value: string): string {
  return value
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Main H1-equivalent titles we hide from the bullet strip so the panel does not repeat the digest name. */
const HEARTBEAT_DIGEST_TITLE_LINE =
  /^(Operational Digest|Operational summary|Operative summary|Resumen operativo|Digest operativo|Pulso|Pulse|Operational pulse|Pulso operativo|Pulso del día|Resumen del día)$/i;

function heartbeatDigestItems(
  summary: string,
  options?: { limit?: number }
): string[] {
  const clean = stripMarkdown(summary);
  if (!clean) return [];
  const lines = clean
    .split(/\n+/)
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .filter((line) => line.length > 0)
    .filter((line) => !HEARTBEAT_DIGEST_TITLE_LINE.test(line));
  const limit = options?.limit;
  if (typeof limit === "number") {
    return lines.slice(0, limit);
  }
  return lines;
}

function HeartbeatDigestBulletList({
  items,
  lineClamp,
}: {
  items: string[];
  lineClamp?: number;
}) {
  if (items.length === 0) {
    return <p className="opacity-80">Sin resumen guardado.</p>;
  }
  return (
    <ul className="space-y-1 opacity-85">
      {items.map((item, index) => (
        <li key={index} className="flex gap-2">
          <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500/70" />
          <span className="min-w-0 break-words">
            {typeof lineClamp === "number"
              ? truncatePanelText(item, lineClamp)
              : item}
          </span>
        </li>
      ))}
    </ul>
  );
}

function heartbeatAppliedSkillsFromDetails(
  details?: Record<string, unknown>
): string[] {
  const skills = details?.appliedHeartbeatSkills;
  return Array.isArray(skills)
    ? skills.filter((item): item is string => typeof item === "string")
    : [];
}

function heartbeatAppliedSkillDisplaysFromDetails(
  details?: Record<string, unknown>
): AppliedSkillDisplay[] {
  const explicit = parseAppliedSkills(details?.appliedSkills);
  if (explicit.length > 0) return explicit;
  return heartbeatAppliedSkillsFromDetails(details).map((id) => ({
    id,
    role: "primary",
  }));
}

function heartbeatRunForMessage(
  message: Message | undefined,
  heartbeatStatus?: HeartbeatStatus
): HeartbeatStatus["lastRun"] | null {
  if (!message || messageSource(message) !== "heartbeat") return null;
  const runs = heartbeatStatus?.runs ?? [];
  const messageTime = message.created_at
    ? new Date(message.created_at).getTime()
    : Number.NaN;
  const bySummary = runs.find(
    (run) => run.summary.trim() === message.content.trim()
  );
  if (bySummary) return bySummary;
  if (Number.isNaN(messageTime)) return null;
  return (
    runs.find((run) => {
      const started = new Date(run.startedAt).getTime();
      if (Number.isNaN(started)) return false;
      return Math.abs(messageTime - started) < 2 * 60 * 1000;
    }) ?? null
  );
}

function heartbeatItemCountFromDetails(
  details?: Record<string, unknown>
): number {
  const selections = details?.heartbeatSkillSelection;
  return Array.isArray(selections) ? selections.length : 0;
}

function FieldRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="font-semibold text-slate-800 dark:text-white">{label}</p>
      <p>{value}</p>
    </div>
  );
}

function parseAppliedSkills(value: unknown): AppliedSkillDisplay[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const row = item as Record<string, unknown>;
      if (typeof row.id !== "string" || row.id.length === 0) return null;
      return {
        id: row.id,
        role: row.role === "included" ? "included" : "primary",
      } satisfies AppliedSkillDisplay;
    })
    .filter((item): item is AppliedSkillDisplay => Boolean(item));
}

function parseAppliedMemory(value: unknown): AppliedMemoryDisplay[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): AppliedMemoryDisplay | null => {
      if (!item || typeof item !== "object") return null;
      const row = item as Record<string, unknown>;
      if (row.source !== "short_term" && row.source !== "long_term") return null;
      if (typeof row.content !== "string" || row.content.length === 0) return null;
      const type =
        row.type === "episodic" ||
        row.type === "semantic" ||
        row.type === "procedural"
          ? row.type
          : undefined;
      const memory: AppliedMemoryDisplay = {
        source: row.source,
        content: row.content,
      };
      if (type) memory.type = type;
      if (typeof row.count === "number") memory.count = row.count;
      if (Array.isArray(row.previews)) {
        const previews = row.previews
          .map((preview): ShortTermMemoryPreview | null => {
            if (!preview || typeof preview !== "object") return null;
            const p = preview as Record<string, unknown>;
            if (typeof p.role !== "string") return null;
            if (typeof p.content !== "string" || p.content.length === 0) return null;
            return {
              role: p.role,
              content: p.content,
              created_at:
                typeof p.created_at === "string" ? p.created_at : undefined,
            };
          })
          .filter((preview): preview is ShortTermMemoryPreview =>
            Boolean(preview)
          );
        if (previews.length > 0) memory.previews = previews;
      }
      return memory;
    })
    .filter((item): item is AppliedMemoryDisplay => Boolean(item));
}

function appliedSkillsFromMessage(message: Message | undefined): AppliedSkillDisplay[] {
  const payload = message?.structured_payload;
  if (!payload) return [];
  const explicit = parseAppliedSkills(payload.appliedSkills);
  if (explicit.length > 0) return explicit;
  return typeof payload.activeSkill === "string"
    ? [{ id: payload.activeSkill, role: "primary" }]
    : [];
}

function memoryFromMessage(message: Message | undefined): AppliedMemoryDisplay[] {
  return parseAppliedMemory(message?.structured_payload?.memoryUsed);
}

function messageSource(message: Message | undefined): "scheduled_task" | "heartbeat" | null {
  const source = message?.structured_payload?.source;
  if (source === "scheduled_task" || source === "heartbeat") return source;
  return null;
}

function messageSourceLabel(message: Message | undefined): string | null {
  const source = messageSource(message);
  if (source === "scheduled_task") return "Tarea programada";
  if (source === "heartbeat") return "Pulso operativo";
  return null;
}

function defaultSelectedTurnId(messages: Message[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const turnId = messages[i]?.turn_id;
    if (turnId) return turnId;
  }
  return null;
}

function skillsForLastCompletedTurn(
  msgs: Message[],
  preferredTurnId?: string | null,
  preferredSkills?: AppliedSkillDisplay[]
): AppliedSkillDisplay[] {
  if (preferredSkills && preferredSkills.length > 0) return preferredSkills;
  if (preferredTurnId) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]?.turn_id !== preferredTurnId) continue;
      return appliedSkillsFromMessage(msgs[i]);
    }
  }

  for (let i = msgs.length - 1; i >= 0; i--) {
    const role = msgs[i]?.role;
    if (role !== "assistant" && role !== "user") continue;
    return appliedSkillsFromMessage(msgs[i]);
  }
  return [];
}

function memoryForLastCompletedTurn(
  msgs: Message[],
  preferredTurnId?: string | null,
  preferredMemory?: AppliedMemoryDisplay[]
): AppliedMemoryDisplay[] {
  if (preferredMemory && preferredMemory.length > 0) return preferredMemory;
  if (preferredTurnId) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]?.turn_id !== preferredTurnId) continue;
      return memoryFromMessage(msgs[i]);
    }
  }

  for (let i = msgs.length - 1; i >= 0; i--) {
    const role = msgs[i]?.role;
    if (role !== "assistant" && role !== "user") continue;
    return memoryFromMessage(msgs[i]);
  }
  return [];
}

/** Prefer persisted turn correlation; timestamp matching only supports old rows.
 */
function toolsForLastCompletedTurn(
  msgs: Message[],
  calls: RecentToolCall[],
  preferredTurnId?: string | null
): RecentToolCall[] {
  const sortByCreatedAt = (rows: RecentToolCall[]): RecentToolCall[] =>
    [...rows].sort((a, b) => {
      const ta = new Date(a.created_at).getTime();
      const tb = new Date(b.created_at).getTime();
      return ta - tb;
    });

  if (preferredTurnId) {
    return sortByCreatedAt(calls.filter((c) => c.turn_id === preferredTurnId));
  }

  // Anchor to the most recent user message: that is the turn currently in
  // focus. If it carries `turn_id`, filter strictly by it; this also lets
  // us return [] (i.e. clear the panel) the moment a new user message is
  // sent before any tools have been recorded for it.
  let lastUserIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]?.role === "user") {
      lastUserIdx = i;
      break;
    }
  }

  const lastUserTurnId = lastUserIdx >= 0 ? msgs[lastUserIdx]?.turn_id : null;
  if (lastUserTurnId) {
    return sortByCreatedAt(calls.filter((c) => c.turn_id === lastUserTurnId));
  }

  let lastAssistantIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]?.role === "assistant") {
      lastAssistantIdx = i;
      break;
    }
  }
  if (lastUserIdx < 0 || lastAssistantIdx < 0 || calls.length === 0) return [];

  const turnId = msgs[lastAssistantIdx]?.turn_id;
  if (turnId) {
    return sortByCreatedAt(calls.filter((c) => c.turn_id === turnId));
  }

  const userTs = msgs[lastUserIdx]?.created_at;
  const assistantTs = msgs[lastAssistantIdx]?.created_at;
  if (!userTs || !assistantTs) return [];

  const userMs = new Date(userTs).getTime();
  const assistantMs = new Date(assistantTs).getTime();
  if (Number.isNaN(userMs) || Number.isNaN(assistantMs)) return [];

  const skewMs = 5 * 60 * 1000;
  const windowStartMs = userMs - skewMs;
  const windowEndMs = Math.max(userMs, assistantMs) + skewMs;

  const matches = calls.filter((c) => {
    const t = new Date(c.created_at).getTime();
    if (Number.isNaN(t)) return false;
    return t >= windowStartMs && t <= windowEndMs;
  });

  return sortByCreatedAt(matches);
}

function mergeToolCalls(
  prev: RecentToolCall[],
  additions: RecentToolCall[],
  maxTotal = 80
): RecentToolCall[] {
  const fuzzyMatchMs = 2500;
  const seenIds = new Set<string>();
  const out: RecentToolCall[] = [];

  const push = (row: RecentToolCall) => {
    const key = row.id.startsWith("turn-")
      ? `${row.tool_name}:${row.created_at}`
      : row.id;
    if (seenIds.has(key)) return;
    seenIds.add(key);
    out.push(row);
  };

  const stripOptimisticDuplicate = (serverRow: RecentToolCall) => {
    const tServer = new Date(serverRow.created_at).getTime();
    if (Number.isNaN(tServer)) return;
    for (let i = out.length - 1; i >= 0; i--) {
      const row = out[i]!;
      if (!row.id.startsWith("turn-")) continue;
      if (row.tool_name !== serverRow.tool_name) continue;
      const tOpt = new Date(row.created_at).getTime();
      if (Number.isNaN(tOpt)) continue;
      if (Math.abs(tServer - tOpt) <= fuzzyMatchMs) {
        out.splice(i, 1);
        const optKey = `${row.tool_name}:${row.created_at}`;
        seenIds.delete(optKey);
        break;
      }
    }
  };

  const isOptimisticDuplicateOfServerRow = (row: RecentToolCall): boolean => {
    if (!row.id.startsWith("turn-")) return false;
    const tOpt = new Date(row.created_at).getTime();
    if (Number.isNaN(tOpt)) return false;
    return additions.some((serverRow) => {
      if (serverRow.id.startsWith("turn-")) return false;
      if (serverRow.tool_name !== row.tool_name) return false;
      if (serverRow.turn_id && row.turn_id && serverRow.turn_id !== row.turn_id) {
        return false;
      }
      const tServer = new Date(serverRow.created_at).getTime();
      if (Number.isNaN(tServer)) return false;
      return Math.abs(tServer - tOpt) <= fuzzyMatchMs;
    });
  };

  for (const row of additions) {
    stripOptimisticDuplicate(row);
    push(row);
  }
  for (const row of prev) {
    if (isOptimisticDuplicateOfServerRow(row)) continue;
    push(row);
  }
  return out.slice(0, maxTotal);
}

function normalizeResponseToolCalls(
  values: Array<RecentToolCall | string> | undefined,
  fallbackTurnId: string | null | undefined,
  fallbackCreatedAt: string
): RecentToolCall[] {
  if (!Array.isArray(values) || values.length === 0) return [];
  return values
    .map((value, index): RecentToolCall | null => {
      if (typeof value === "string") {
        return {
          id: `turn-${fallbackCreatedAt}-${index}-${value}`,
          turn_id: fallbackTurnId ?? null,
          tool_name: value,
          status: "executed",
          requires_confirmation: false,
          created_at: fallbackCreatedAt,
          finished_at: fallbackCreatedAt,
        };
      }
      if (!isRecordLike(value)) return null;
      if (
        typeof value.id !== "string" ||
        typeof value.tool_name !== "string" ||
        typeof value.created_at !== "string"
      ) {
        return null;
      }
      return {
        id: value.id,
        turn_id: typeof value.turn_id === "string" ? value.turn_id : null,
        tool_name: value.tool_name,
        arguments_json: isRecordLike(value.arguments_json)
          ? value.arguments_json
          : null,
        result_json: isRecordLike(value.result_json) ? value.result_json : null,
        status: typeof value.status === "string" ? value.status : "executed",
        requires_confirmation: value.requires_confirmation === true,
        created_at: value.created_at,
        finished_at:
          typeof value.finished_at === "string" ? value.finished_at : null,
        executor_kind:
          value.executor_kind === "deterministic" ? "deterministic" : "agent",
      };
    })
    .filter((value): value is RecentToolCall => value !== null);
}

function toolCallSignature(call: RecentToolCall): string {
  // Cheap identity check: avoid JSON.stringify of potentially large payloads
  // on every poll, but still notice when technical details become available.
  return `${call.id}|${call.status}|${call.finished_at ?? ""}|${
    call.requires_confirmation ? 1 : 0
  }|${call.arguments_json ? 1 : 0}|${call.result_json ? 1 : 0}`;
}

function messageDedupKey(message: Message): string {
  return (
    message.id ??
    `${message.turn_id ?? "no-turn"}:${message.role}:${message.created_at ?? ""}:${message.content}`
  );
}

function mergeMessages(prev: Message[], additions: Message[], maxTotal = 120): Message[] {
  const seen = new Set<string>();
  const merged = [...prev, ...additions]
    .sort((a, b) => {
      const aTime = new Date(a.created_at ?? "").getTime();
      const bTime = new Date(b.created_at ?? "").getTime();
      return (Number.isNaN(aTime) ? 0 : aTime) - (Number.isNaN(bTime) ? 0 : bTime);
    })
    .filter((message) => {
      const key = messageDedupKey(message);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return merged.slice(-maxTotal);
}

function createClientTurnId(): string {
  return crypto.randomUUID();
}

type PanelIconName =
  | "flow"
  | "memory"
  | "skills"
  | "tools"
  | "learnings"
  | "presence";

function PanelIcon({ name }: { name: PanelIconName }) {
  const common = {
    xmlns: "http://www.w3.org/2000/svg",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className: "h-4 w-4",
    "aria-hidden": true,
  };

  if (name === "memory") {
    return (
      <svg {...common} className="h-5 w-5" strokeWidth={2}>
        <path d="M8.5 6.5a3 3 0 0 0-3 3 3.5 3.5 0 0 0 1.1 6.8" />
        <path d="M15.5 6.5a3 3 0 0 1 3 3 3.5 3.5 0 0 1-1.1 6.8" />
        <path d="M8.5 6.5A3.5 3.5 0 0 1 12 3a3.5 3.5 0 0 1 3.5 3.5" />
        <path d="M8 12h8" />
        <path d="M9 16c.8 2 2 3 3 3s2.2-1 3-3" />
        <path d="M12 3v16" />
      </svg>
    );
  }

  if (name === "skills") {
    return (
      <svg {...common} className="h-5 w-5" strokeWidth={2}>
        <path d="M3.9 8.6a4 4 0 0 1 4.7-4.7 4 4 0 0 1 6.8 0 4 4 0 0 1 4.7 4.7 4 4 0 0 1 0 6.8 4 4 0 0 1-4.7 4.7 4 4 0 0 1-6.8 0 4 4 0 0 1-4.7-4.7 4 4 0 0 1 0-6.8Z" />
        <path d="m9 12 2 2 4-4" />
      </svg>
    );
  }

  if (name === "tools") {
    return (
      <svg {...common} className="h-5 w-5" strokeWidth={2}>
        <path d="M14.7 6.3a4 4 0 0 0-5 5L4 17l3 3 5.7-5.7a4 4 0 0 0 5-5l-2.4 2.4-3-3 2.4-2.4z" />
      </svg>
    );
  }

  if (name === "presence") {
    return (
      <svg {...common}>
        <path d="M3 12h4l2-6 4 12 2-6h6" />
      </svg>
    );
  }

  if (name === "learnings") {
    return (
      <svg {...common} className="h-5 w-5" strokeWidth={2}>
        <path d="M6 4h9a3 3 0 0 1 3 3v13H8a2 2 0 0 1-2-2V4z" />
        <path d="M8 18h10" />
        <path d="M10 8h4" />
        <path d="M10 11h5" />
      </svg>
    );
  }

  if (name === "flow") {
    return (
      <svg {...common} className="h-5 w-5" strokeWidth={2}>
        <path d="M10 6h11" />
        <path d="M10 12h11" />
        <path d="M10 18h11" />
        <path d="M3 6l2 2 4-4" />
        <path d="M3 12l2 2 4-4" />
        <path d="M3 18l2 2 4-4" />
      </svg>
    );
  }

  const _exhaustive: never = name;
  return _exhaustive;
}

function PanelSectionTitle({
  icon,
  title,
  children,
}: {
  icon: PanelIconName;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-start gap-3">
      <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-2xl bg-violet-100 text-violet-700 dark:bg-violet-400/10 dark:text-violet-200">
        <PanelIcon name={icon} />
      </span>
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-slate-950 dark:text-white">
          {title}
        </h3>
        {children}
      </div>
    </div>
  );
}

/** CommonMark no trata «•» como lista; lo normalizamos a «-» para <ul>/<li>. */
function normalizeAssistantMarkdownLists(content: string): string {
  return content.replace(/^(?:\s*)•\s+/gm, "- ");
}

/**
 * ReactMarkdown no autolinkea URLs sueltas; Telegram sí las hace clickables.
 * No tocar destinos ya en markdown `](https://...)`: el `(` del destino
 * matcheaba el prefijo y anidaba `[url](url)`, dejando href vacío → /chat.
 */
function autolinkBareUrlsInMarkdown(content: string): string {
  return content.replace(
    /(^|[\s(])((https?:\/\/)[^\s<>"'`)\]]+)/g,
    (full, prefix: string, url: string, _protocol: string, offset: number, whole: string) => {
      if (
        prefix === "(" &&
        typeof offset === "number" &&
        typeof whole === "string" &&
        offset > 0 &&
        whole[offset - 1] === "]"
      ) {
        return full;
      }
      const trailingMatch = url.match(/[),.]+$/);
      const trailing = trailingMatch?.[0] ?? "";
      const cleaned = trailing ? url.slice(0, -trailing.length) : url;
      if (!cleaned) return full;
      return `${prefix}[${cleaned}](${cleaned})${trailing}`;
    }
  );
}

const AssistantMarkdown = memo(function AssistantMarkdown({
  content,
}: {
  content: string;
}) {
  const markdown = autolinkBareUrlsInMarkdown(
    normalizeAssistantMarkdownLists(content)
  );
  // Ritmo cercano a Telegram (texto plano con líneas en blanco): más aire
  // entre párrafos/listas y bullets visibles (list-disc).
  return (
    <div className="prose prose-sm max-w-none break-words prose-p:my-2.5 prose-headings:my-3 prose-li:my-1 prose-ol:my-3 prose-ul:my-3 prose-ul:list-disc prose-ol:list-decimal prose-li:marker:text-slate-500 dark:prose-li:marker:text-white/50 prose-a:text-violet-700 prose-a:underline dark:prose-invert dark:prose-a:text-violet-200">
      <ReactMarkdown
        components={{
          a: ({ href, children }) => {
            // href vacío lo resuelve el browser a la página actual (/chat).
            if (typeof href !== "string" || !href.trim()) {
              return <>{children}</>;
            }
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="break-all"
              >
                {children}
              </a>
            );
          },
          img: ({ src, alt }) => {
            if (typeof src !== "string" || !src.trim()) return null;
            return (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={src}
                alt={typeof alt === "string" ? alt : ""}
                className="my-2 max-h-56 w-full rounded-2xl object-cover"
              />
            );
          },
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
});

function clarificationQuickRepliesFromMessage(message: Message): Array<{
  id: string;
  label: string;
  freeText: string;
  variant?: "primary" | "secondary";
}> | null {
  if (message.role !== "assistant") return null;
  const payload = message.structured_payload;
  if (!payload || payload.kind !== "conversation_clarification") return null;
  if (payload.actions_resolved === true) return null;
  const raw = payload.actions;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const actions: Array<{
    id: string;
    label: string;
    freeText: string;
    variant?: "primary" | "secondary";
  }> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (
      typeof record.id !== "string" ||
      typeof record.label !== "string" ||
      typeof record.freeText !== "string"
    ) {
      continue;
    }
    actions.push({
      id: record.id,
      label: record.label,
      freeText: record.freeText,
      ...(record.variant === "primary" || record.variant === "secondary"
        ? { variant: record.variant as "primary" | "secondary" }
        : {}),
    });
  }
  return actions.length > 0 ? actions : null;
}

function hitlActionsFromMessage(message: Message): {
  kind: string;
  notificationId: string;
  actions: WebHitlActionDef[];
} | null {
  if (message.role !== "assistant") return null;
  const payload = message.structured_payload;
  if (!payload || typeof payload.kind !== "string") return null;
  if (payload.actions_resolved === true) return null;
  if (!WEB_HITL_MIRROR_KINDS.has(payload.kind) && payload.kind !== "contract_pending") {
    return null;
  }
  const notificationId =
    typeof payload.notification_id === "string"
      ? payload.notification_id.trim()
      : "";
  if (!notificationId) return null;
  const raw = payload.actions;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const actions = raw.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || typeof record.label !== "string") {
      return [];
    }
    const action: WebHitlActionDef = {
      id: record.id,
      label: record.label,
      ...(record.variant === "primary" ||
      record.variant === "secondary" ||
      record.variant === "danger"
        ? { variant: record.variant }
        : {}),
      ...(record.acceptsNotes === true ? { acceptsNotes: true } : {}),
      ...(typeof record.notesPlaceholder === "string"
        ? { notesPlaceholder: record.notesPlaceholder }
        : {}),
      ...(typeof record.defaultNotes === "string"
        ? { defaultNotes: record.defaultNotes }
        : {}),
      ...(record.requiresNotes === true ? { requiresNotes: true } : {}),
      ...(record.body && typeof record.body === "object" && !Array.isArray(record.body)
        ? { body: record.body as Record<string, unknown> }
        : {}),
    };
    return [action];
  });
  if (actions.length === 0) return null;
  return { kind: payload.kind, notificationId, actions };
}

function hitlButtonClassName(variant: WebHitlActionDef["variant"]): string {
  if (variant === "primary") {
    return "rounded-xl bg-emerald-600 px-3 py-2 text-center text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-60";
  }
  if (variant === "danger") {
    return "rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-center text-xs font-semibold text-rose-700 hover:bg-rose-100 disabled:opacity-60 dark:border-rose-300/30 dark:bg-rose-400/10 dark:text-rose-100";
  }
  return "rounded-xl border border-violet-200 bg-violet-50 px-3 py-2 text-center text-xs font-semibold text-violet-800 hover:bg-violet-100 disabled:opacity-60 dark:border-violet-300/30 dark:bg-violet-400/10 dark:text-violet-100";
}

const HitlInlineActions = memo(function HitlInlineActions({
  kind,
  notificationId,
  actions,
  onResult,
}: {
  kind: string;
  notificationId: string;
  actions: WebHitlActionDef[];
  onResult?: (text: string) => void;
}) {
  const [status, setStatus] = useState<string | null>(null);
  const [busyActionId, setBusyActionId] = useState<string | null>(null);
  const [resolved, setResolved] = useState(false);
  const [notes, setNotes] = useState("");
  const notesAction = actions.find((action) => action.acceptsNotes);
  const busy = busyActionId != null;

  async function submit(action: WebHitlActionDef) {
    if (busy || resolved) return;
    const request = buildWebHitlSubmitRequest({
      kind,
      notificationId,
      action,
      notes,
    });
    if ("error" in request) {
      setStatus(
        request.error === "notes_required"
          ? "Escribe el ajuste en el campo de texto."
          : "No pude preparar la acción."
      );
      return;
    }
    setBusyActionId(action.id);
    setStatus(null);
    try {
      const res = await fetch(request.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request.body),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        message?: string;
        error?: string;
        ackText?: string;
      };
      const message =
        data.message ??
        data.ackText ??
        data.error ??
        (res.ok ? "Listo." : "No se pudo procesar.");
      setStatus(message);
      if (res.ok && data.ok !== false) {
        setResolved(true);
        // contract_review: el API ya espeja el acuse al chat (paridad
        // Telegram); el sync lo trae. Otros kinds: burbuja local inmediata.
        if (
          kind !== "contract_review" &&
          kind !== "contract_pending" &&
          (action.variant === "primary" ||
            action.id === "approve" ||
            action.id === "approve_continue" ||
            action.id === "confirm" ||
            action.id === "upload_done")
        ) {
          onResult?.(message);
        }
      }
    } catch {
      setStatus("No se pudo procesar. Intenta de nuevo.");
    } finally {
      setBusyActionId(null);
    }
  }

  return (
    <div
      className="mt-3 space-y-2 border-t border-slate-200/80 pt-3 dark:border-white/10"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {!resolved ? (
        <>
          <div className="flex flex-col gap-2">
            {actions.map((action) => (
              <button
                key={action.id}
                type="button"
                disabled={busy}
                onClick={() => void submit(action)}
                className={hitlButtonClassName(action.variant)}
              >
                {busyActionId === action.id ? "Procesando…" : action.label}
              </button>
            ))}
          </div>
          {notesAction ? (
            <input
              value={notes}
              disabled={busy}
              onChange={(event) => setNotes(event.target.value)}
              placeholder={
                notesAction.notesPlaceholder ?? "Opcional: comentario"
              }
              className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs outline-none focus:border-violet-300 dark:border-white/10 dark:bg-slate-950"
            />
          ) : null}
        </>
      ) : (
        <p className="rounded-xl bg-emerald-50 px-3 py-2 text-center text-xs font-medium text-emerald-800 dark:bg-emerald-400/10 dark:text-emerald-100">
          Decisión registrada
        </p>
      )}
      {status ? (
        <p className="text-[11px] text-slate-500 dark:text-white/60">{status}</p>
      ) : null}
    </div>
  );
});

const ListingCoverPreviewCard = memo(function ListingCoverPreviewCard({
  coverUrl,
  href,
  label,
}: {
  coverUrl: string;
  href: string | null;
  label: string;
}) {
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;
  const image = (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={coverUrl}
      alt={label}
      onError={() => setHidden(true)}
      className="aspect-[16/10] w-full object-cover"
    />
  );
  const shellClass =
    "mb-3 block overflow-hidden rounded-2xl border border-slate-200/80 bg-slate-50 shadow-sm dark:border-white/10 dark:bg-white/5";
  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(event) => event.stopPropagation()}
        className={`${shellClass} transition hover:opacity-95`}
        title={label}
      >
        {image}
        <div className="px-3 py-2 text-xs font-medium text-violet-700 dark:text-violet-200">
          {label}
        </div>
      </a>
    );
  }
  return <div className={shellClass}>{image}</div>;
});

const ChatMessageBubble = memo(function ChatMessageBubble({
  message,
  agentAvatarUrl,
  agentInitial,
  agentName,
  userAvatarUrl,
  userName,
  onSelectTurn,
  onHitlResult,
  onQuickReply,
}: {
  message: Message;
  agentAvatarUrl?: string;
  agentInitial: string;
  agentName: string;
  userAvatarUrl?: string;
  userName?: string;
  onSelectTurn: (turnId: string) => void;
  onHitlResult?: (text: string) => void;
  /** Envía freeText como mensaje normal (paridad botones Telegram). */
  onQuickReply?: (text: string) => void;
}) {
  const msg = message;
  const sourceLabel = messageSourceLabel(msg);
  const attachmentMeta = messageAttachmentMeta(msg);
  const listingPreview = listingPublishedSummaryPreview(msg);
  const chipAttachments = listingPreview
    ? attachmentMeta.filter((attachment) => !isImageAttachment(attachment))
    : attachmentMeta;
  const displayText = messageDisplayText(msg);
  const hitlActions = hitlActionsFromMessage(msg);
  const clarificationReplies = clarificationQuickRepliesFromMessage(msg);
  const [clarificationResolved, setClarificationResolved] = useState(false);
  return (
    <div
      role={msg.turn_id ? "button" : undefined}
      tabIndex={msg.turn_id ? 0 : undefined}
      title={msg.turn_id ? "Ver contexto de este turno" : undefined}
      onClick={() => {
        if (msg.turn_id) onSelectTurn(msg.turn_id);
      }}
      onKeyDown={(event) => {
        if (!msg.turn_id) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelectTurn(msg.turn_id);
        }
      }}
      className={`flex items-start gap-2 rounded-[1.75rem] outline-none ${
        msg.turn_id ? "cursor-pointer" : ""
      } ${msg.role === "user" ? "justify-end" : "justify-start"} [content-visibility:auto] [contain-intrinsic-size:0_120px]`}
    >
      {msg.role !== "user" && (
        <ChatAvatar
          imageUrl={agentAvatarUrl}
          fallback={agentInitial}
          label={`Avatar de ${agentName}`}
          tone="agent"
        />
      )}
      <div
        className={`min-w-0 max-w-[82%] overflow-hidden rounded-3xl px-4 py-3 text-sm leading-relaxed shadow-sm ${
          msg.role === "user"
            ? "bg-gradient-to-br from-violet-700 to-fuchsia-600 text-white shadow-violet-900/20"
            : "border border-slate-200/70 bg-white text-slate-900 dark:border-white/10 dark:bg-white/10 dark:text-white"
        }`}
      >
        {sourceLabel ? (
          <div className="mb-2 inline-flex rounded-full bg-violet-100 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-violet-700 dark:bg-violet-400/10 dark:text-violet-100">
            {sourceLabel}
          </div>
        ) : null}
        {listingPreview ? (
          <ListingCoverPreviewCard
            coverUrl={listingPreview.coverUrl}
            href={listingPreview.href}
            label={listingPreview.label}
          />
        ) : null}
        {chipAttachments.length > 0 ? (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {chipAttachments.map((attachment) => {
              const chipClass =
                msg.role === "user"
                  ? "inline-flex max-w-full min-w-0 items-center gap-1 rounded-full bg-white/15 px-2.5 py-1 text-[11px] font-medium text-white/90 ring-1 ring-white/20"
                  : "inline-flex max-w-full min-w-0 items-center gap-1 rounded-full bg-violet-50 px-2.5 py-1 text-[11px] font-medium text-violet-800 ring-1 ring-violet-200 hover:bg-violet-100 dark:bg-violet-400/10 dark:text-violet-100 dark:ring-violet-400/30";
              const nameClass = "min-w-0 truncate";
              if (
                isImageAttachment(attachment) &&
                attachment.downloadUrl
              ) {
                const imageCard = (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={attachment.downloadUrl}
                    alt={attachment.fileName}
                    className="max-h-48 max-w-full rounded-xl object-cover"
                  />
                );
                if (attachment.href) {
                  return (
                    <a
                      key={attachment.fileName}
                      href={attachment.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={attachment.label || attachment.fileName}
                      onClick={(event) => event.stopPropagation()}
                      className="block overflow-hidden rounded-xl"
                    >
                      {imageCard}
                    </a>
                  );
                }
                return (
                  <a
                    key={attachment.fileName}
                    href={attachment.downloadUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={attachment.fileName}
                    onClick={(event) => event.stopPropagation()}
                    className="block overflow-hidden rounded-xl"
                  >
                    {imageCard}
                  </a>
                );
              }
              if (attachment.downloadUrl) {
                return (
                  <a
                    key={attachment.fileName}
                    href={attachment.downloadUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={attachment.fileName}
                    onClick={(event) => event.stopPropagation()}
                    className={chipClass}
                  >
                    <span aria-hidden="true">📎</span>
                    <span className={nameClass}>{attachment.fileName}</span>
                  </a>
                );
              }
              return (
                <span
                  key={attachment.fileName}
                  title={attachment.fileName}
                  className={chipClass}
                >
                  <span aria-hidden="true">📎</span>
                  <span className={nameClass}>
                    {attachment.fileName}
                    {attachment.truncated ? " · truncado" : ""}
                  </span>
                </span>
              );
            })}
          </div>
        ) : null}
        {msg.role === "assistant" ? (
          <AssistantMarkdown content={msg.content} />
        ) : displayText ? (
          <p className="whitespace-pre-wrap">{displayText}</p>
        ) : attachmentMeta.length > 0 ? (
          <p className="text-white/80">Archivo adjunto enviado.</p>
        ) : null}
        {hitlActions ? (
          <HitlInlineActions
            kind={hitlActions.kind}
            notificationId={hitlActions.notificationId}
            actions={hitlActions.actions}
            onResult={onHitlResult}
          />
        ) : null}
        {clarificationReplies && !clarificationResolved && onQuickReply ? (
          <div
            className="mt-3 flex flex-wrap gap-2"
            onClick={(event) => event.stopPropagation()}
          >
            {clarificationReplies.map((action) => (
              <button
                key={action.id}
                type="button"
                className={hitlButtonClassName(action.variant)}
                onClick={() => {
                  setClarificationResolved(true);
                  onQuickReply(action.freeText);
                }}
              >
                {action.label}
              </button>
            ))}
          </div>
        ) : null}
        {msg.created_at ? (
          <p
            className={`mt-1.5 text-right text-[10px] tabular-nums ${
              msg.role === "user"
                ? "text-white/70"
                : "text-slate-400 dark:text-white/40"
            }`}
          >
            {formatBubbleTime(msg.created_at)}
          </p>
        ) : null}
      </div>
      {msg.role === "user" && (
        <ChatAvatar
          imageUrl={userAvatarUrl}
          fallback={(userName || "U").slice(0, 1).toUpperCase()}
          label="Avatar del usuario"
          tone="user"
        />
      )}
    </div>
  );
});

const NEAR_BOTTOM_PX = 120;

function adjustTextareaHeight(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

function isViewportNearBottom(viewport: HTMLElement) {
  const distanceFromBottom =
    viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
  return distanceFromBottom <= NEAR_BOTTOM_PX;
}

const ChatComposer = memo(function ChatComposer({
  loading,
  hasConfirmation,
  hasPendingAttachments,
  fileInputRef,
  composerInputRef,
  onAttachmentSelection,
  onComposingChange,
  onSend,
}: {
  loading: boolean;
  hasConfirmation: boolean;
  hasPendingAttachments: boolean;
  fileInputRef: RefObject<HTMLInputElement | null>;
  composerInputRef: RefObject<HTMLTextAreaElement | null>;
  onAttachmentSelection: (event: ChangeEvent<HTMLInputElement>) => void;
  onComposingChange: (composing: boolean) => void;
  onSend: (text: string) => void;
}) {
  const textInputRef = useRef<HTMLTextAreaElement>(null);
  const disabled = loading || hasConfirmation;

  useEffect(() => {
    const el = textInputRef.current;
    if (!el) return;
    const markComposing = () => onComposingChange(true);
    el.addEventListener("input", markComposing);
    el.addEventListener("keydown", markComposing);
    return () => {
      el.removeEventListener("input", markComposing);
      el.removeEventListener("keydown", markComposing);
    };
  }, [onComposingChange]);

  function assignTextInput(el: HTMLTextAreaElement | null) {
    textInputRef.current = el;
    composerInputRef.current = el;
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = textInputRef.current?.value.trim() ?? "";
    if (disabled || (!text && !hasPendingAttachments)) return;
    onSend(text);
    if (textInputRef.current) {
      textInputRef.current.value = "";
      adjustTextareaHeight(textInputRef.current);
    }
  }

  function handleInput(event: ChangeEvent<HTMLTextAreaElement>) {
    adjustTextareaHeight(event.target);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mx-auto max-w-2xl space-y-2">
      <div className="flex items-end gap-2 rounded-2xl border border-slate-200 bg-white p-2 shadow-sm dark:border-white/10 dark:bg-neutral-900">
        <input
          ref={fileInputRef}
          type="file"
          accept={CHAT_ATTACHMENT_ACCEPT}
          className="hidden"
          onChange={onAttachmentSelection}
        />
        <button
          type="button"
          aria-label="Adjuntar archivo"
          title="Adjuntar fotos, PDF, Word, Excel o texto (fotos máx. 10 MB)"
          disabled={disabled}
          onClick={() => fileInputRef.current?.click()}
          className="flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-xl text-slate-500 hover:bg-violet-50 hover:text-violet-700 disabled:cursor-not-allowed disabled:opacity-50 dark:text-white/60 dark:hover:bg-white/10 dark:hover:text-white"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-5 w-5"
            aria-hidden="true"
          >
            <path d="M21.44 11.05 12.25 20.24a6 6 0 1 1-8.49-8.49l9.19-9.19a4 4 0 1 1 5.66 5.66l-9.2 9.19a2 2 0 1 1-2.83-2.83l8.49-8.48" />
          </svg>
        </button>
        <textarea
          ref={assignTextInput}
          rows={1}
          defaultValue=""
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          onFocus={() => onComposingChange(true)}
          onBlur={() => onComposingChange(false)}
          placeholder={
            hasConfirmation
              ? "Resuelve la confirmación para continuar..."
              : "Dile a Gu qué necesitas..."
          }
          disabled={disabled}
          className="max-h-32 min-h-[2.5rem] min-w-0 flex-1 resize-none overflow-y-auto bg-transparent px-3 py-2 text-sm leading-5 text-slate-900 outline-none placeholder:text-slate-400 disabled:opacity-50 dark:text-white dark:placeholder:text-white/40"
        />
        <button
          type="button"
          aria-label="Mensaje de voz"
          title="Mensaje de voz"
          className="hidden h-10 w-10 shrink-0 items-center justify-center rounded-xl text-violet-700 hover:bg-violet-50 dark:text-violet-200 dark:hover:bg-white/10 sm:flex"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-5 w-5"
            aria-hidden="true"
          >
            <rect x="9" y="3" width="6" height="11" rx="3" />
            <path d="M5 11a7 7 0 0 0 14 0" />
            <line x1="12" y1="18" x2="12" y2="22" />
            <line x1="8" y1="22" x2="16" y2="22" />
          </svg>
        </button>
        <button
          type="submit"
          aria-label="Enviar mensaje"
          title="Enviar"
          disabled={disabled}
          className="flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-xl bg-gradient-to-br from-violet-700 to-fuchsia-600 text-white shadow-lg shadow-violet-900/20 transition hover:from-violet-800 hover:to-fuchsia-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-5 w-5"
            aria-hidden="true"
          >
            <path d="m4 12 16-8-6 18-3-7-7-3z" />
          </svg>
        </button>
      </div>
    </form>
  );
});

export function ChatInterface({
  agentName,
  agentAvatarUrl,
  agentEmoji,
  userAvatarUrl,
  userName,
  baseContext,
  availableSkills = [],
  availableTools = [],
  initialMessages,
  initialToolCalls = [],
  initialPendingConfirmation = null,
  initialRecentLearnings = [],
  heartbeatStatus: initialHeartbeatStatus,
  scheduledTaskSummary: initialScheduledTaskSummary,
  pendingInboxCount = 0,
}: Props) {
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [toolCalls, setToolCalls] = useState<RecentToolCall[]>(initialToolCalls);
  const [heartbeatStatus, setHeartbeatStatus] = useState<HeartbeatStatus | undefined>(
    initialHeartbeatStatus
  );
  const [scheduledTaskSummary, setScheduledTaskSummary] = useState<
    ScheduledTaskSummary | undefined
  >(initialScheduledTaskSummary);
  const [loading, setLoading] = useState(false);
  const [confirmation, setConfirmation] = useState<PendingConfirmation | null>(
    initialPendingConfirmation
  );
  const [confirming, setConfirming] = useState(false);
  const [contextExpanded, setContextExpanded] = useState(false);
  const [shortTermExpanded, setShortTermExpanded] = useState(false);
  const [heartbeatHistoryExpanded, setHeartbeatHistoryExpanded] = useState(false);
  const [scheduledTasksExpanded, setScheduledTasksExpanded] = useState(false);
  const [expandedToolCallId, setExpandedToolCallId] = useState<string | null>(
    null
  );
  const [pendingAttachments, setPendingAttachments] = useState<
    PendingAttachment[]
  >([]);
  const [attachmentUploadStatus, setAttachmentUploadStatus] = useState<
    string | null
  >(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const pendingHref = pendingInboxCount > 0 ? "/chat/pending" : null;
  const [operationalEvents, setOperationalEvents] = useState<OperationalEvent[]>([]);
  const [selectedTurnId, setSelectedTurnId] = useState<string | null>(
    () =>
      initialPendingConfirmation?.turnId ??
      defaultSelectedTurnId(initialMessages)
  );
  const handleSelectTurn = useCallback((turnId: string) => {
    setSelectedTurnId(turnId);
  }, []);
  const handleHitlResult = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setMessages((prev) => [
      ...prev,
      {
        role: "assistant",
        content: trimmed,
        created_at: new Date().toISOString(),
        structured_payload: {
          source: "operational_case",
          kind: "hitl_action_result",
        },
      },
    ]);
  }, []);
  const isComposingRef = useRef(false);
  const handleComposingChange = useCallback((composing: boolean) => {
    isComposingRef.current = composing;
  }, []);
  const isUserComposing = useCallback(() => {
    if (isComposingRef.current) return true;
    const input = composerInputRef.current;
    return input != null && document.activeElement === input;
  }, []);
  const messagesViewportRef = useRef<HTMLDivElement>(null);
  const didInitialScrollRef = useRef(false);
  const stickToBottomRef = useRef(true);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  const scrollMessagesToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const viewport = messagesViewportRef.current;
    if (!viewport) return;
    stickToBottomRef.current = true;
    setShowScrollToBottom(false);
    viewport.scrollTo({
      top: viewport.scrollHeight,
      behavior,
    });
  }, []);
  const syncAfterRef = useRef<string | null>(
    initialMessages.at(-1)?.created_at ?? null
  );
  const lastOperationalSyncAtRef = useRef<number>(0);
  const messagesRef = useRef<Message[]>(initialMessages);
  const toolCallsRef = useRef<RecentToolCall[]>(initialToolCalls);
  const loadingRef = useRef(false);
  const syncPollMs =
    process.env.NODE_ENV === "production" ? 5_000 : 30_000;
  const agentInitial =
    agentEmoji || agentName.slice(0, 1).toUpperCase() || "G";
  const agentStatus = confirmation
    ? "Esperando aprobación"
    : loading
      ? "Trabajando"
      : "En línea";
  const agentStatusDescription = confirmation
    ? "Gu necesita tu autorización para continuar con una acción."
    : loading
      ? "Gu está procesando tu solicitud y preparando la siguiente respuesta."
      : "Listo para recibir nuevas peticiones y ejecutar tareas con contexto.";
  const heartbeatDigest = heartbeatDigestItems(
    heartbeatStatus?.lastRun?.summary ?? ""
  );
  const heartbeatRuns = heartbeatStatus?.runs ?? [];
  const previousHeartbeatRuns = heartbeatRuns.slice(1);
  const scheduledTasks = useMemo(
    () => scheduledTaskSummary?.tasks ?? [],
    [scheduledTaskSummary?.tasks]
  );
  const chatTimeline = useMemo(() => buildChatTimeline(messages), [messages]);

  const inspectedTurnId = selectedTurnId ?? confirmation?.turnId ?? null;
  const inspectedMessage = inspectedTurnId
    ? [...messages].reverse().find((message) => message.turn_id === inspectedTurnId)
    : undefined;
  const inspectedSourceLabel = messageSourceLabel(inspectedMessage);
  const inspectedHeartbeatRun = heartbeatRunForMessage(
    inspectedMessage,
    heartbeatStatus
  );

  const toolsThisTurn = useMemo(
    () => toolsForLastCompletedTurn(messages, toolCalls, inspectedTurnId),
    [messages, toolCalls, inspectedTurnId]
  );
  const skillsThisTurn = useMemo(
    () => {
      const skills = skillsForLastCompletedTurn(
        messages,
        inspectedTurnId,
        confirmation?.appliedSkills
      );
      if (skills.length > 0) return skills;
      return heartbeatAppliedSkillDisplaysFromDetails(
        inspectedHeartbeatRun?.details
      );
    },
    [
      messages,
      inspectedTurnId,
      confirmation?.appliedSkills,
      inspectedHeartbeatRun?.details,
    ]
  );
  const memoryThisTurn = useMemo(
    () =>
      memoryForLastCompletedTurn(
        messages,
        inspectedTurnId,
        confirmation?.memoryUsed
      ),
    [messages, inspectedTurnId, confirmation?.memoryUsed]
  );
  const shortTermMemoryCount = memoryThisTurn.filter(
    (memory) => memory.source === "short_term"
  ).length;
  const longTermMemoryCount = memoryThisTurn.filter(
    (memory) => memory.source === "long_term"
  ).length;
  const memorySummary =
    memoryThisTurn.length > 0
      ? `${shortTermMemoryCount} corto plazo · ${longTermMemoryCount} largo plazo`
      : null;
  const baseContextName = compactText(baseContext?.identity.name, agentName);
  const businessMarkets =
    baseContext?.businessContext.markets &&
    baseContext.businessContext.markets.length > 0
      ? baseContext.businessContext.markets.join(", ")
      : "No configurado";
  const availableSkillNames =
    availableSkills.length > 0
      ? availableSkills.map((skill) => formatSkillForUserPanel(skill.id))
      : [];
  const availableToolNames =
    availableTools.length > 0
      ? availableTools.map((tool) => formatToolForUserPanel(tool.id))
      : [];
  const visibleOperationalEvents = operationalEvents
    .filter((event) => !inspectedTurnId || event.turnId === inspectedTurnId)
    .slice(-8);

  useEffect(() => {
    if (scheduleConfirmationMatchesTask(confirmation, scheduledTasks)) {
      setConfirmation(null);
      setConfirming(false);
    }
  }, [confirmation, scheduledTasks]);

  useEffect(() => {
    setExpandedToolCallId(null);
  }, [inspectedTurnId]);

  useEffect(() => {
    const viewport = messagesViewportRef.current;
    if (!viewport) return;

    const syncScrollState = () => {
      const nearBottom = isViewportNearBottom(viewport);
      stickToBottomRef.current = nearBottom;
      setShowScrollToBottom(!nearBottom);
    };

    syncScrollState();
    viewport.addEventListener("scroll", syncScrollState, { passive: true });
    return () => viewport.removeEventListener("scroll", syncScrollState);
  }, []);

  useLayoutEffect(() => {
    const viewport = messagesViewportRef.current;
    if (!viewport) return;

    const shouldStick =
      !didInitialScrollRef.current || stickToBottomRef.current;
    if (!shouldStick) {
      setShowScrollToBottom(!isViewportNearBottom(viewport));
      return;
    }

    const behavior = didInitialScrollRef.current ? "smooth" : "auto";
    scrollMessagesToBottom(behavior);
    if (!didInitialScrollRef.current) {
      requestAnimationFrame(() => scrollMessagesToBottom("auto"));
    }
    didInitialScrollRef.current = true;
  }, [
    messages.length,
    confirmation?.toolCallId,
    loading,
    scrollMessagesToBottom,
  ]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    toolCallsRef.current = toolCalls;
  }, [toolCalls]);

  useEffect(() => {
    loadingRef.current = loading;
  }, [loading]);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;

    async function syncAutomatedActivity(includeOperational = false) {
      if (
        cancelled ||
        inFlight ||
        document.visibilityState !== "visible" ||
        isUserComposing()
      ) {
        return;
      }
      inFlight = true;
      try {
        const params = new URLSearchParams();
        const after = syncAfterRef.current;
        if (after) params.set("after", after);
        if (includeOperational) {
          params.set("ops", "1");
          lastOperationalSyncAtRef.current = Date.now();
        }
        const res = await fetch(`/api/chat/sync?${params.toString()}`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const data = (await res.json()) as {
          messages?: Message[];
          toolCalls?: RecentToolCall[];
          heartbeatStatus?: HeartbeatStatus;
          scheduledTaskSummary?: ScheduledTaskSummary;
        };
        if (cancelled || isUserComposing()) return;
        if (Array.isArray(data.messages) && data.messages.length > 0) {
          const existingKeys = new Set(messagesRef.current.map(messageDedupKey));
          const newMessages = data.messages.filter(
            (message) => !existingKeys.has(messageDedupKey(message))
          );
          const newest = newMessages.filter((message) => message.turn_id).at(-1);
          const newestCreatedAt = data.messages
            .map((message) => message.created_at)
            .filter((value): value is string => typeof value === "string")
            .at(-1);
          if (newestCreatedAt) syncAfterRef.current = newestCreatedAt;
          if (newMessages.length > 0) {
            setMessages((prev) => mergeMessages(prev, newMessages));
          }
          // If the user is waiting for a web response, automated cron/heartbeat
          // messages should appear in the timeline but should not steal the
          // right-panel focus from the active user turn.
          if (newest?.turn_id && !loadingRef.current) {
            setSelectedTurnId(newest.turn_id);
          }
        }
        if (Array.isArray(data.toolCalls) && data.toolCalls.length > 0) {
          const currentById = new Map(
            toolCallsRef.current.map((call) => [call.id, toolCallSignature(call)])
          );
          const changedToolCalls = data.toolCalls.filter(
            (call) => currentById.get(call.id) !== toolCallSignature(call)
          );
          if (changedToolCalls.length > 0) {
            setToolCalls((prev) => {
              const merged = mergeToolCalls(prev, changedToolCalls);
              toolCallsRef.current = merged;
              return merged;
            });
          }
        }
        if (data.heartbeatStatus) {
          setHeartbeatStatus((current) =>
            JSON.stringify(current) === JSON.stringify(data.heartbeatStatus)
              ? current
              : data.heartbeatStatus
          );
        }
        if (data.scheduledTaskSummary) {
          setScheduledTaskSummary((current) =>
            JSON.stringify(current) === JSON.stringify(data.scheduledTaskSummary)
              ? current
              : data.scheduledTaskSummary
          );
        }
      } catch {
        // Polling is best-effort; the next tick will retry.
      } finally {
        inFlight = false;
      }
    }

    const tick = () => {
      const shouldSyncOperational =
        Date.now() - lastOperationalSyncAtRef.current >= 30_000;
      void syncAutomatedActivity(shouldSyncOperational);
    };
    void syncAutomatedActivity(true);
    const interval = window.setInterval(tick, syncPollMs);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void syncAutomatedActivity(true);
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [isUserComposing, syncPollMs]);

  function appendOperationalEvent(event: OperationalEvent) {
    setOperationalEvents((prev) => {
      const key = `${event.type}:${event.at ?? ""}:${event.message}:${event.toolName ?? ""}`;
      const exists = prev.some(
        (item) =>
          `${item.type}:${item.at ?? ""}:${item.message}:${item.toolName ?? ""}` ===
          key
      );
      if (exists) return prev;
      return [...prev, event].slice(-40);
    });
  }

  async function handleAttachmentSelection(
    event: React.ChangeEvent<HTMLInputElement>
  ) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || loading) return;

    setAttachmentUploadStatus(`Procesando ${file.name}...`);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/chat/attachments", {
        method: "POST",
        body: formData,
      });
      const data = (await res.json().catch(() => ({}))) as {
        fileName?: string;
        version?: 1;
        fileId?: string;
        mimeType?: string;
        sizeBytes?: number;
        text?: string;
        truncated?: boolean;
        storageBucket?: string;
        storagePath?: string;
        sha256?: string;
        suggestedKind?: string;
        error?: string;
      };
      const extractedText =
        typeof data.text === "string" ? data.text : "";
      const extractedName =
        typeof data.fileName === "string" ? data.fileName : "";
      if (
        !res.ok ||
        !extractedText ||
        !extractedName ||
        typeof data.storageBucket !== "string" ||
        typeof data.storagePath !== "string" ||
        typeof data.sha256 !== "string"
      ) {
        setAttachmentUploadStatus(
          data.error ?? "No se pudo adjuntar el archivo."
        );
        return;
      }
      const storageBucket = data.storageBucket;
      const storagePath = data.storagePath;
      const sha256 = data.sha256;
      setPendingAttachments((current) => [
        ...current,
        {
          version: data.version,
          fileId: data.fileId,
          fileName: extractedName,
          mimeType: data.mimeType ?? file.type,
          sizeBytes: data.sizeBytes ?? file.size,
          text: extractedText,
          truncated: data.truncated === true,
          storageBucket,
          storagePath,
          sha256,
          suggestedKind:
            typeof data.suggestedKind === "string" && data.suggestedKind.trim()
              ? data.suggestedKind
              : "unknown",
        },
      ]);
      setAttachmentUploadStatus(null);
    } catch {
      setAttachmentUploadStatus("No se pudo adjuntar el archivo.");
    }
  }

  async function handleSend(draft: string) {
    const text = draft.trim();
    if ((!text && pendingAttachments.length === 0) || loading) return;
    const clientTurnId = createClientTurnId();
    const attachmentsForTurn = [...pendingAttachments];
    const agentMessage = buildAgentMessageText(text, attachmentsForTurn);
    const attachmentMeta: ChatAttachmentMeta[] = attachmentsForTurn.map(
      (attachment) => ({
        fileName: attachment.fileName,
        truncated: attachment.truncated,
        sizeBytes: attachment.sizeBytes,
      })
    );

    const userMsg: Message = {
      role: "user",
      content: agentMessage,
      created_at: new Date().toISOString(),
      turn_id: clientTurnId,
      structured_payload: {
        userText: text,
        attachments: attachmentMeta,
        appliedSkills: [],
        memoryUsed: [],
      },
    };
    setMessages((prev) => [...prev, userMsg]);
    setSelectedTurnId(clientTurnId);
    setShortTermExpanded(false);
    setOperationalEvents([]);
    setPendingAttachments([]);
    setAttachmentUploadStatus(null);
    setLoading(true);

    const eventSource = new EventSource(
      `/api/chat/events?turnId=${encodeURIComponent(clientTurnId)}`
    );
    eventSource.addEventListener("turn-event", (event) => {
      try {
        appendOperationalEvent(JSON.parse(event.data) as OperationalEvent);
      } catch {
        // Ignore malformed event payloads; they are non-critical UI hints.
      }
    });
    eventSource.onerror = () => {
      eventSource.close();
    };

    try {
      type ChatPostResponse = {
        response?: string | null;
        turnId?: string;
        appliedSkills?: AppliedSkillDisplay[];
        memoryUsed?: AppliedMemoryDisplay[];
        pendingConfirmation?: PendingConfirmation | null;
        toolCalls?: Array<RecentToolCall | string>;
        error?: string;
        reason?: string;
        retryable?: boolean;
        structuredPayload?: Record<string, unknown>;
      };
      const chatBody = JSON.stringify({
        message: agentMessage,
        turnId: clientTurnId,
        attachments: attachmentsForTurn.map((attachment) => ({
          version: attachment.version,
          fileId: attachment.fileId,
          fileName: attachment.fileName,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          storageBucket: attachment.storageBucket,
          storagePath: attachment.storagePath,
          sha256: attachment.sha256,
          suggestedKind: attachment.suggestedKind,
        })),
      });
      const maxChatAttempts = 3;
      let res: Response | null = null;
      let data: ChatPostResponse = {};
      for (let attempt = 0; attempt < maxChatAttempts; attempt += 1) {
        res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: chatBody,
        });
        data = (await res.json().catch(() => ({}))) as ChatPostResponse;
        if (res.ok) break;
        const retryableAuth =
          res.status === 503 ||
          data.retryable === true ||
          data.reason === "auth_unreachable" ||
          data.error === "auth_unavailable";
        if (!retryableAuth || attempt >= maxChatAttempts - 1) break;
        await new Promise((resolve) =>
          setTimeout(resolve, 250 * (attempt + 1))
        );
      }
      if (!res) return;

      if (!res.ok) {
        const isTransientAuth =
          res.status === 503 ||
          data.error === "auth_unavailable" ||
          data.reason === "auth_unreachable";
        const isSessionAuthFailure =
          isTransientAuth ||
          res.status === 401 ||
          (typeof data.error === "string" &&
            /unauthorized|unauthenticated|session/i.test(data.error));
        const errText = isTransientAuth
          ? "No pude verificar tu sesión porque Auth no respondió a tiempo (ya reintenté). Espera un momento y vuelve a enviar el mensaje, o recarga la página."
          : isSessionAuthFailure
            ? "No pude verificar tu sesión (puede haber caducado). Recarga la página o vuelve a iniciar sesión e intenta de nuevo."
            : typeof data.error === "string"
              ? data.error
              : `Error HTTP ${res.status}`;
        const errIso = new Date().toISOString();
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant" as const,
            content: isSessionAuthFailure ? errText : `Error: ${errText}`,
            created_at: errIso,
            turn_id: data.turnId ?? clientTurnId,
            structured_payload: {
              appliedSkills: data.appliedSkills ?? [],
              memoryUsed: data.memoryUsed ?? [],
              ...(isSessionAuthFailure
                ? { source: "session_auth_failure", reason: data.reason ?? null }
                : {}),
            },
          },
        ]);
        setSelectedTurnId(data.turnId ?? clientTurnId);
        return;
      }

      if (data.pendingConfirmation) {
        setConfirmation(data.pendingConfirmation);
        setSelectedTurnId(data.pendingConfirmation.turnId ?? data.turnId ?? clientTurnId);
      }

      const assistantIso = new Date().toISOString();

      // Usar typeof === 'string' (no truthiness): null/undefined no son respuesta; "" sí debe mostrarse.
      const assistantText = data.response;
      if (typeof assistantText === "string") {
        const content =
          assistantText.length > 0
            ? assistantText
            : "Respuesta vacía del asistente. Si esperabas una tarjeta de confirmación, revisa debajo del chat.";
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant" as const,
            content,
            created_at: assistantIso,
            turn_id: data.turnId ?? clientTurnId,
            structured_payload: {
              appliedSkills: data.appliedSkills ?? [],
              memoryUsed: data.memoryUsed ?? [],
              ...(data.structuredPayload ?? {}),
            },
          },
        ]);
        setSelectedTurnId(data.turnId ?? clientTurnId);
      } else if (!data.pendingConfirmation) {
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant" as const,
            content:
              "Respuesta incompleta del servidor (sin texto). Recarga la página o revisa la consola del servidor.",
            created_at: assistantIso,
            turn_id: data.turnId ?? clientTurnId,
            structured_payload: {
              appliedSkills: data.appliedSkills ?? [],
              memoryUsed: data.memoryUsed ?? [],
            },
          },
        ]);
        setSelectedTurnId(data.turnId ?? clientTurnId);
      }

      const responseToolCalls = normalizeResponseToolCalls(
        data.toolCalls,
        data.turnId ?? clientTurnId,
        assistantIso
      );
      if (responseToolCalls.length > 0) {
        setToolCalls((prev) => mergeToolCalls(prev, responseToolCalls));
      }
    } catch {
      const errIso = new Date().toISOString();
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: "Error al procesar tu mensaje. Intenta de nuevo.",
          created_at: errIso,
          turn_id: clientTurnId,
          structured_payload: { appliedSkills: [], memoryUsed: [] },
        },
      ]);
      setSelectedTurnId(clientTurnId);
    } finally {
      eventSource.close();
      setLoading(false);
    }
  }

  async function handleConfirm(action: "approve" | "reject") {
    if (!confirmation) return;
    setConfirming(true);
    let keepPending: PendingConfirmation | null = null;
    const confirmTurnId = confirmation.turnId ?? null;
    const eventSource = confirmTurnId
      ? new EventSource(
          `/api/chat/events?turnId=${encodeURIComponent(confirmTurnId)}`
        )
      : null;
    eventSource?.addEventListener("turn-event", (event) => {
      try {
        appendOperationalEvent(JSON.parse(event.data) as OperationalEvent);
      } catch {
        // Ignore malformed event payloads; they are non-critical UI hints.
      }
    });
    eventSource?.addEventListener("error", () => {
      eventSource.close();
    });

    try {
      const res = await fetch("/api/chat/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          toolCallId: confirmation.toolCallId,
          action,
        }),
      });

      const data = (await res.json()) as {
        ok?: boolean;
        response?: string | null;
        turnId?: string;
        appliedSkills?: AppliedSkillDisplay[];
        memoryUsed?: AppliedMemoryDisplay[];
        pendingConfirmation?: PendingConfirmation | null;
        toolCalls?: Array<RecentToolCall | string>;
        error?: string;
      };

      const assistantIso = new Date().toISOString();

      const responseText =
        typeof data.response === "string" ? data.response : null;
      if (data.ok && responseText && responseText.length > 0) {
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: responseText,
            created_at: assistantIso,
            turn_id: data.turnId ?? confirmation.turnId ?? null,
            structured_payload: {
              appliedSkills:
                data.appliedSkills ?? confirmation.appliedSkills ?? [],
              memoryUsed: data.memoryUsed ?? confirmation.memoryUsed ?? [],
            },
          },
        ]);
        setSelectedTurnId(data.turnId ?? confirmation.turnId ?? null);
      }

      if (data.pendingConfirmation) {
        keepPending = data.pendingConfirmation as PendingConfirmation;
      }

      if (!data.ok) {
        const msg =
          typeof data.error === "string"
            ? data.error
            : formatConfirmFailureMessage(undefined);
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: `Error al ejecutar: ${msg}`,
            created_at: assistantIso,
            turn_id: data.turnId ?? confirmation.turnId ?? null,
            structured_payload: {
              appliedSkills:
                data.appliedSkills ?? confirmation.appliedSkills ?? [],
              memoryUsed: data.memoryUsed ?? confirmation.memoryUsed ?? [],
            },
          },
        ]);
        setSelectedTurnId(data.turnId ?? confirmation.turnId ?? null);
      } else if (action === "reject" && !data.response) {
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: "Acción cancelada.",
            created_at: assistantIso,
            turn_id: data.turnId ?? confirmation.turnId ?? null,
            structured_payload: {
              appliedSkills:
                data.appliedSkills ?? confirmation.appliedSkills ?? [],
              memoryUsed: data.memoryUsed ?? confirmation.memoryUsed ?? [],
            },
          },
        ]);
        setSelectedTurnId(data.turnId ?? confirmation.turnId ?? null);
      }

      const responseToolCalls = normalizeResponseToolCalls(
        data.toolCalls,
        data.turnId ?? confirmation.turnId ?? null,
        assistantIso
      );
      if (responseToolCalls.length > 0) {
        setToolCalls((prev) => mergeToolCalls(prev, responseToolCalls));
      }
    } catch {
      const errIso = new Date().toISOString();
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: "Error al procesar la confirmación.",
          created_at: errIso,
          turn_id: confirmation.turnId ?? null,
        },
      ]);
      setSelectedTurnId(confirmation.turnId ?? null);
    } finally {
      eventSource?.close();
      setConfirmation(keepPending);
      setConfirming(false);
    }
  }

  const handleSendRef = useRef(handleSend);
  handleSendRef.current = handleSend;
  const handleAttachmentSelectionRef = useRef(handleAttachmentSelection);
  handleAttachmentSelectionRef.current = handleAttachmentSelection;
  const onComposerSend = useCallback((text: string) => {
    stickToBottomRef.current = true;
    setShowScrollToBottom(false);
    void handleSendRef.current(text);
  }, []);
  const onComposerAttachmentSelection = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      void handleAttachmentSelectionRef.current(event);
    },
    []
  );

  return (
    <div className="relative flex h-full min-h-0 flex-1 flex-col text-slate-950 dark:text-white">
      <div className="relative grid h-full min-h-0 flex-1 grid-cols-1 gap-4 xl:grid-cols-[minmax(0,0.95fr)_460px] 2xl:grid-cols-[minmax(0,0.9fr)_520px]">
            <section className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-[2rem] border border-slate-200 bg-white shadow-xl shadow-violet-950/5 dark:border-white/10 dark:bg-neutral-900">
              {/* Messages */}
              <div className="relative min-h-0 flex-1">
                <div ref={messagesViewportRef} className="h-full overflow-y-auto px-4 py-6">
                  <div className="mx-auto max-w-2xl space-y-4">
          {messages.length === 0 && (
            <div className="mx-auto max-w-md rounded-3xl border border-violet-100 bg-violet-50/80 px-6 py-10 text-center text-sm text-slate-500 dark:border-white/10 dark:bg-white/5 dark:text-white/60">
              <p className="text-lg font-semibold text-slate-900 dark:text-white">
                Hola, soy {agentName}
              </p>
              <p className="mt-2">Estoy listo para ayudarte a organizar, decidir y ejecutar tareas.</p>
            </div>
          )}
          {chatTimeline.map((item) => {
            if (item.type === "date") {
              return (
                <div key={item.key} className="flex justify-center py-1">
                  <span className="rounded-full bg-white/80 px-3 py-1 text-[11px] font-semibold text-slate-500 shadow-sm ring-1 ring-slate-200/80 dark:bg-white/10 dark:text-white/60 dark:ring-white/10">
                    {item.label}
                  </span>
                </div>
              );
            }

            return (
              <ChatMessageBubble
                key={item.key}
                message={item.message}
                agentAvatarUrl={agentAvatarUrl}
                agentInitial={agentInitial}
                agentName={agentName}
                userAvatarUrl={userAvatarUrl}
                userName={userName}
                onSelectTurn={handleSelectTurn}
                onHitlResult={handleHitlResult}
                onQuickReply={onComposerSend}
              />
            );
          })}

          {/* Confirmation prompt */}
          {confirmation && (
            <div className="flex items-start justify-start gap-2">
              <ChatAvatar
                imageUrl={agentAvatarUrl}
                fallback={agentInitial}
                label={`Avatar de ${agentName}`}
                tone="agent"
              />
              <div className="max-w-[82%] rounded-3xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm shadow-sm dark:border-amber-400/20 dark:bg-amber-400/10">
                <p className="mb-3 text-slate-900 dark:text-white">
                  {confirmation.message}
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => handleConfirm("approve")}
                    disabled={confirming}
                    className="rounded-full bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                  >
                    {confirming ? "Ejecutando..." : "Aprobar"}
                  </button>
                  <button
                    onClick={() => handleConfirm("reject")}
                    disabled={confirming}
                    className="rounded-full border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-400/30 dark:text-red-200 dark:hover:bg-red-400/10"
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            </div>
          )}

          {loading && (
            <div className="flex items-start justify-start gap-2">
              <ChatAvatar
                imageUrl={agentAvatarUrl}
                fallback={agentInitial}
                label={`Avatar de ${agentName}`}
                tone="agent"
              />
              <div className="rounded-3xl border border-slate-200/70 bg-white px-4 py-3 text-sm shadow-sm dark:border-white/10 dark:bg-white/10">
                <span>Pensando...</span>
              </div>
            </div>
          )}
          <div ref={bottomRef} />
                  </div>
                </div>

                {showScrollToBottom ? (
                  <button
                    type="button"
                    aria-label="Ir al último mensaje"
                    title="Ir al último mensaje"
                    onClick={() => scrollMessagesToBottom("smooth")}
                    className="absolute bottom-4 right-5 z-10 flex h-10 w-10 cursor-pointer items-center justify-center rounded-full border border-slate-200/80 bg-white text-slate-600 shadow-lg shadow-slate-900/10 transition hover:bg-slate-50 hover:text-violet-700 dark:border-white/15 dark:bg-neutral-800 dark:text-white/80 dark:shadow-black/30 dark:hover:bg-neutral-700 dark:hover:text-white"
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="h-5 w-5"
                      aria-hidden="true"
                    >
                      <path d="m6 9 6 6 6-6" />
                    </svg>
                  </button>
                ) : null}
              </div>

              {/* Input */}
              <div className="shrink-0 border-t border-slate-200 bg-white px-4 py-4 dark:border-white/10 dark:bg-neutral-900">
                <div className="mx-auto max-w-2xl space-y-2">
                  {pendingAttachments.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {pendingAttachments.map((attachment, index) => (
                        <span
                          key={`${attachment.fileName}-${index}`}
                          className="inline-flex items-center gap-2 rounded-full border border-violet-200 bg-violet-50 px-3 py-1 text-xs font-medium text-violet-800 dark:border-violet-300/20 dark:bg-violet-400/10 dark:text-violet-100"
                        >
                          <span aria-hidden="true">📎</span>
                          {attachment.fileName}
                          {attachment.truncated ? " · truncado" : ""}
                          <button
                            type="button"
                            aria-label={`Quitar ${attachment.fileName}`}
                            onClick={() =>
                              setPendingAttachments((current) =>
                                current.filter((_, itemIndex) => itemIndex !== index)
                              )
                            }
                            className="cursor-pointer rounded-full px-1 text-violet-500 hover:bg-violet-100 hover:text-violet-900 dark:hover:bg-violet-300/20"
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                  ) : null}
                  {attachmentUploadStatus ? (
                    <p className="text-xs text-slate-500 dark:text-white/60">
                      {attachmentUploadStatus}
                    </p>
                  ) : null}
                  <ChatComposer
                    loading={loading}
                    hasConfirmation={Boolean(confirmation)}
                    hasPendingAttachments={pendingAttachments.length > 0}
                    fileInputRef={fileInputRef}
                    composerInputRef={composerInputRef}
                    onAttachmentSelection={onComposerAttachmentSelection}
                    onComposingChange={handleComposingChange}
                    onSend={onComposerSend}
                  />
                </div>
              </div>
            </section>

            <aside className="hidden h-full min-h-0 flex-col gap-4 overflow-y-auto pr-1 xl:flex">
              <section className="rounded-[2rem] border border-white/70 bg-[#32107a] p-5 text-white shadow-xl shadow-violet-950/10 dark:border-white/10">
                <div className="flex items-center gap-4">
                  <div className="flex h-24 w-24 shrink-0 items-center justify-center overflow-hidden rounded-[1.75rem] bg-white/10 ring-1 ring-white/20">
                    {agentAvatarUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={agentAvatarUrl} alt="Avatar de Gu" className="h-full w-full object-cover" />
                    ) : (
                      <span className="text-4xl font-black">{agentInitial}</span>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-3">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-violet-100">
                        Colaborador en acción
                      </p>
                      <span className="shrink-0 rounded-full bg-white/15 px-3 py-1 text-xs font-semibold">
                        {agentStatus}
                      </span>
                    </div>
                    <h2 className="mt-2 truncate text-xl font-bold">{agentName}</h2>
                    <p className="mt-1 line-clamp-2 text-sm leading-5 text-violet-100">
                      {agentStatusDescription}
                    </p>
                  </div>
                </div>
                <div className="mt-4 grid grid-cols-3 items-stretch rounded-2xl bg-white/10 text-center text-xs ring-1 ring-white/10">
                  <div className="flex flex-col items-center px-3 py-3">
                    <div className="inline-flex flex-col items-center">
                      <div className="flex min-h-10 items-center justify-center gap-1.5 font-bold">
                        <span className="relative inline-flex size-10 shrink-0 items-center justify-center">
                          {heartbeatStatus?.enabled ? (
                            <span className="absolute inline-flex size-8 rounded-full bg-fuchsia-400/[0.13]" />
                          ) : null}
                          <span
                            className={`relative text-[1.625rem] leading-none ${
                              heartbeatStatus?.enabled
                                ? "text-fuchsia-300"
                                : "text-white/45"
                            }`}
                            aria-hidden="true"
                          >
                            ♥
                          </span>
                        </span>
                        <span className="text-base leading-tight">Pulso</span>
                      </div>
                      <p className="mt-0.5 text-center text-violet-100">
                        {heartbeatStatus?.enabled ? "Activo" : "Desactivado"}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-col items-center border-x border-white/10 px-3 py-3">
                    <p className="flex min-h-10 items-center justify-center text-base font-bold leading-none">
                      {scheduledTaskSummary?.activeCount ?? 0}
                    </p>
                    <p className="mt-0.5 text-violet-100">Programadas</p>
                  </div>
                  <div className="flex flex-col items-center px-3 py-3">
                    <p className="flex min-h-10 items-center justify-center text-base font-bold leading-none">
                      {pendingInboxCount}
                    </p>
                    {pendingHref ? (
                      <a
                        href={pendingHref}
                        className="mt-0.5 text-violet-100 underline decoration-violet-200/70 underline-offset-2 hover:text-white"
                      >
                        Pendientes
                      </a>
                    ) : (
                      <p className="mt-0.5 text-violet-100">Pendientes</p>
                    )}
                  </div>
                </div>
              </section>

              <section className="rounded-[2rem] border border-slate-200 bg-white p-5 shadow-xl shadow-violet-950/5 dark:border-white/10 dark:bg-neutral-900">
                <PanelSectionTitle icon="flow" title="Flujo actual">
                  <p className="mt-1 text-xs text-slate-500 dark:text-white/60">
                    {inspectedSourceLabel
                      ? `Contexto del turno seleccionado · ${inspectedSourceLabel}.`
                      : "Contexto del turno seleccionado en el chat."}
                  </p>
                </PanelSectionTitle>
                <div className="mt-4 space-y-1 text-sm">
                  <div className="rounded-2xl px-3 py-2 transition hover:bg-white/60 dark:hover:bg-white/[0.04]">
                    <button
                      type="button"
                      aria-expanded={contextExpanded}
                      onClick={() => setContextExpanded((current) => !current)}
                      className="flex w-full items-start gap-3 text-left"
                    >
                    <span className="mt-1.5 inline-flex h-2.5 w-2.5 shrink-0 rounded-full bg-emerald-500" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-3">
                        <p className="font-medium text-slate-800 dark:text-white">
                          Contexto preparado
                        </p>
                        <span className="shrink-0 text-xs font-semibold text-violet-700 dark:text-violet-200">
                          {contextExpanded ? "Ocultar" : "Ver contexto"}
                        </span>
                      </div>
                      <p className="text-xs text-slate-500 dark:text-white/60">
                        Configuración persistente que Gu tiene antes de cada solicitud.
                      </p>
                    </div>
                    </button>
                    {contextExpanded && (
                      <div className="mt-3 space-y-2 rounded-2xl bg-emerald-50/70 p-3 text-xs text-slate-600 ring-1 ring-emerald-100 dark:bg-emerald-400/10 dark:text-white/70 dark:ring-emerald-400/20">
                        <FieldRow label="Identidad" value={baseContextName} />
                        <FieldRow
                          label="Rol"
                          value={compactText(baseContext?.identity.role)}
                        />
                        <FieldRow
                          label="Descripción"
                          value={compactText(baseContext?.identity.shortDescription)}
                        />
                        <FieldRow
                          label="Alma"
                          value={[
                            baseContext?.soul.voice
                              ? `Voz: ${baseContext.soul.voice}`
                              : "",
                            baseContext?.soul.tone
                              ? `Tono: ${baseContext.soul.tone}`
                              : "",
                            baseContext?.soul.style
                              ? `Estilo: ${baseContext.soul.style}`
                              : "",
                            baseContext?.soul.brevity
                              ? `Brevedad: ${baseContext.soul.brevity}`
                              : "",
                          ]
                            .filter(Boolean)
                            .join(" · ") || "No configurado"}
                        />
                        <FieldRow
                          label="Cuenta"
                          value={userName ? `Configurado para ${userName}` : "Usuario actual"}
                        />
                        <FieldRow
                          label="Contexto del negocio"
                          value={[
                            baseContext?.businessContext.kind
                              ? `Tipo: ${baseContext.businessContext.kind}`
                              : "",
                            businessMarkets !== "No configurado"
                              ? `Mercados: ${businessMarkets}`
                              : "",
                            baseContext?.businessContext.notes
                              ? `Notas: ${baseContext.businessContext.notes}`
                              : "",
                          ]
                            .filter(Boolean)
                            .join(" · ") || "No configurado"}
                        />
                        <FieldRow
                          label="Preferencias operativas"
                          value={compactText(baseContext?.operatingPreferences)}
                        />
                        <div>
                          <p className="font-semibold text-slate-800 dark:text-white">
                            Habilidades disponibles para selección
                          </p>
                          {availableSkillNames.length > 0 ? (
                            <ul className="mt-1 list-disc space-y-1 pl-4">
                              {availableSkillNames.map((skillName) => (
                                <li key={skillName}>{skillName}</li>
                              ))}
                            </ul>
                          ) : (
                            <p>Catálogo no disponible en esta carga.</p>
                          )}
                          <p className="mt-1 text-[11px] text-slate-500 dark:text-white/50">
                            No todas se cargan a la vez: el selector elige la más
                            relevante después de leer tu solicitud.
                          </p>
                        </div>
                        <div>
                          <p className="font-semibold text-slate-800 dark:text-white">
                            Herramientas configuradas
                          </p>
                          {availableToolNames.length > 0 ? (
                            <ul className="mt-1 list-disc space-y-1 pl-4">
                              {availableToolNames.map((toolName) => (
                                <li key={toolName}>{toolName}</li>
                              ))}
                            </ul>
                          ) : (
                            <p>No hay herramientas habilitadas en Settings.</p>
                          )}
                          <p className="mt-1 text-[11px] text-slate-500 dark:text-white/50">
                            La lista final del turno puede reducirse según la
                            habilidad seleccionada, integraciones activas y reglas
                            de seguridad. Las ejecutadas aparecen abajo.
                          </p>
                        </div>
                        <p className="border-t border-emerald-100 pt-2 text-[11px] text-slate-500 dark:border-emerald-400/20 dark:text-white/50">
                          Este resumen no muestra el system prompt crudo ni razonamiento privado; solo configuración de usuario que alimenta el contexto base.
                        </p>
                      </div>
                    )}
                  </div>
                  <div
                    className={`flex items-start gap-3 rounded-2xl px-3 py-2 transition ${
                      loading
                        ? "bg-violet-100/80 ring-1 ring-violet-200 dark:bg-violet-400/15 dark:ring-violet-400/30"
                        : ""
                    }`}
                  >
                    <span
                      className={`relative mt-1.5 inline-flex h-2.5 w-2.5 shrink-0 items-center justify-center rounded-full ${
                        loading
                          ? "bg-violet-500 shadow-[0_0_0_4px_rgba(139,92,246,0.18)]"
                            : "bg-slate-300 dark:bg-white/20"
                      }`}
                    >
                      {loading && (
                        <span className="absolute inline-flex h-3.5 w-3.5 rounded-full bg-violet-500/60" />
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2 font-medium text-slate-800 dark:text-white">
                        {loading ? "Procesando solicitud" : "Procesamiento"}
                        {loading && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-violet-600 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
                            <span className="h-1.5 w-1.5 rounded-full bg-white" />
                            En vivo
                          </span>
                        )}
                      </p>
                      <p className="text-xs text-slate-500 dark:text-white/60">
                        {loading
                          ? "Gu está procesando tu solicitud."
                          : "Listo para actuar y dar resultados."}
                      </p>
                      {loading && (
                        <div className="mt-2 h-1 overflow-hidden rounded-full bg-violet-200/70 dark:bg-violet-400/20">
                          <div className="h-full w-1/2 rounded-full bg-violet-500" />
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="rounded-2xl px-3 py-2">
                    <div className="flex items-start gap-3">
                      <span
                        className={`mt-1.5 inline-flex h-2.5 w-2.5 shrink-0 rounded-full ${
                          loading
                            ? "bg-violet-500 shadow-[0_0_0_4px_rgba(139,92,246,0.18)]"
                            : "bg-slate-300 dark:bg-white/20"
                        }`}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="font-medium text-slate-800 dark:text-white">
                          Timeline operativo
                        </p>
                        <p className="text-xs text-slate-500 dark:text-white/60">
                          Estados en vivo del turno, razonamiento interno no mostrado.
                        </p>
                        {visibleOperationalEvents.length > 0 ? (
                          <div className="mt-2 space-y-2">
                            {visibleOperationalEvents.map((event, index) => (
                              <div
                                key={`${event.type}-${event.at ?? index}-${index}`}
                                className="rounded-2xl bg-white/70 px-3 py-2 text-xs ring-1 ring-slate-100 dark:bg-white/5 dark:ring-white/10"
                              >
                                <div className="mb-1 flex items-center justify-between gap-2">
                                  <span className="inline-flex items-center gap-2 font-semibold text-slate-800 dark:text-white">
                                    <span
                                      className={`h-2 w-2 rounded-full ${operationalEventDotClass(event.type)}`}
                                    />
                                    {formatOperationalEventType(event.type)}
                                  </span>
                                  {event.at && (
                                    <span className="shrink-0 text-[11px] text-slate-400 dark:text-white/40">
                                      {formatOperationalEventTime(event.at)}
                                    </span>
                                  )}
                                </div>
                                <p className="text-slate-600 dark:text-white/70">
                                  {event.message}
                                </p>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="mt-2 text-xs text-slate-400 dark:text-white/40">
                            {inspectedSourceLabel
                              ? "El replay detallado del flujo no está persistido aún; revisa herramientas, memoria y habilidades de este turno abajo."
                              : "Envía una solicitud para ver el flujo operativo."}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-start gap-3 rounded-2xl px-3 py-2">
                    <span
                      className={`mt-1.5 inline-flex h-2.5 w-2.5 shrink-0 rounded-full ${
                        confirmation ? "bg-amber-500" : "bg-slate-300 dark:bg-white/20"
                      }`}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-slate-800 dark:text-white">Confirmación humana</p>
                      <p className="text-xs text-slate-500 dark:text-white/60">
                        Las acciones sensibles aparecen aquí antes de ejecutarse.
                      </p>
                    </div>
                  </div>
                </div>
              </section>

              <section className="rounded-[2rem] border border-slate-200 bg-white p-5 shadow-xl shadow-violet-950/5 dark:border-white/10 dark:bg-neutral-900">
                <div className="flex items-center justify-between gap-3">
                  <PanelSectionTitle icon="memory" title="Memoria del turno">
                    <p className="mt-1 text-xs text-slate-500 dark:text-white/60">
                      Contexto que Gu recordó o cargó para responder.
                    </p>
                    {memorySummary && (
                      <p className="mt-1 text-[11px] font-medium text-violet-700 dark:text-violet-200">
                        {memorySummary}
                      </p>
                    )}
                  </PanelSectionTitle>
                  <span className="rounded-full bg-violet-100 px-3 py-1 text-xs font-semibold text-violet-700 dark:bg-violet-400/10 dark:text-violet-200">
                    {memoryThisTurn.length}
                  </span>
                </div>

                <div className="mt-4 space-y-2">
                  {memoryThisTurn.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-slate-200 px-4 py-4 text-center text-xs text-slate-500 dark:border-white/10 dark:text-white/50">
                      {loading
                        ? "Esperando memoria de este turno…"
                        : "Sin memoria específica registrada para este turno."}
                    </div>
                  ) : (
                    memoryThisTurn.map((memory, index) => (
                      <div
                        key={`${memory.source}-${memory.type ?? "context"}-${index}`}
                        className="flex items-start gap-3 rounded-2xl bg-white/70 px-3 py-3 text-sm ring-1 ring-slate-100 dark:bg-white/5 dark:ring-white/10"
                      >
                        <span
                          className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${
                            memory.source === "long_term"
                              ? "bg-emerald-500"
                              : "bg-sky-400"
                          }`}
                        />
                        <div className="min-w-0 flex-1">
                          <span
                            className={`mb-1 inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                              memory.source === "long_term"
                                ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-200"
                                : "bg-sky-100 text-sky-700 dark:bg-sky-400/10 dark:text-sky-200"
                            }`}
                          >
                            {formatMemorySource(memory)}
                          </span>
                          <p className="line-clamp-2 font-medium text-slate-800 dark:text-white">
                            {memory.content}
                          </p>
                          {memory.source === "short_term" && (
                            memory.previews && memory.previews.length > 0 ? (
                                <>
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setShortTermExpanded((current) => !current)
                                    }
                                    className="mt-2 text-xs font-semibold text-sky-700 hover:text-sky-900 dark:text-sky-200 dark:hover:text-sky-100"
                                  >
                                    {shortTermExpanded
                                      ? "Ocultar mensajes"
                                      : `Ver ${memory.previews.length} mensajes`}
                                  </button>
                                  {shortTermExpanded && (
                                    <div className="mt-2 space-y-2 rounded-2xl bg-sky-50/70 p-3 dark:bg-sky-400/10">
                                      <p className="text-[11px] font-semibold uppercase tracking-wide text-sky-700 dark:text-sky-200">
                                        Orden cronológico
                                      </p>
                                      {memory.previews.map((preview, previewIndex) => (
                                        <div
                                          key={`${preview.role}-${previewIndex}`}
                                          className="rounded-xl bg-white/70 px-2.5 py-2 text-xs text-slate-600 ring-1 ring-sky-100 dark:bg-white/5 dark:text-white/70 dark:ring-white/10"
                                        >
                                          <div className="mb-1 flex items-center justify-between gap-2">
                                            <span className="font-semibold text-slate-800 dark:text-white">
                                              {formatShortTermRole(preview.role)}
                                            </span>
                                            {formatShortTermPreviewTime(
                                              preview.created_at
                                            ) && (
                                              <span className="shrink-0 text-[11px] text-slate-400 dark:text-white/40">
                                                {formatShortTermPreviewTime(
                                                  preview.created_at
                                                )}
                                              </span>
                                            )}
                                          </div>
                                          <p>{preview.content}</p>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </>
                              ) : (
                                <p className="mt-2 text-xs text-slate-400 dark:text-white/40">
                                  El detalle estará disponible en turnos nuevos.
                                </p>
                              )
                          )}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </section>

              <section className="rounded-[2rem] border border-slate-200 bg-white p-5 shadow-xl shadow-violet-950/5 dark:border-white/10 dark:bg-neutral-900">
                <div className="flex items-center justify-between gap-3">
                  <PanelSectionTitle icon="skills" title="Habilidades del turno">
                    <p className="mt-1 text-xs text-slate-500 dark:text-white/60">
                      Playbooks que Gu cargó para resolver este turno.
                    </p>
                  </PanelSectionTitle>
                  <span className="rounded-full bg-violet-100 px-3 py-1 text-xs font-semibold text-violet-700 dark:bg-violet-400/10 dark:text-violet-200">
                    {skillsThisTurn.length}
                  </span>
                </div>

                <div className="mt-4 space-y-2">
                  {skillsThisTurn.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-slate-200 px-4 py-4 text-center text-xs text-slate-500 dark:border-white/10 dark:text-white/50">
                      Sin habilidad especializada para este turno.
                    </div>
                  ) : (
                    skillsThisTurn.map((skill) => (
                      <div
                        key={`${skill.id}-${skill.role}`}
                        className="flex items-center gap-3 rounded-2xl bg-white/70 px-3 py-3 text-sm ring-1 ring-slate-100 dark:bg-white/5 dark:ring-white/10"
                      >
                        <span
                          className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                            skill.role === "primary" ? "bg-violet-500" : "bg-sky-400"
                          }`}
                        />
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium text-slate-800 dark:text-white">
                            {formatSkillForUserPanel(skill.id)}
                          </p>
                          <p className="mt-1 text-xs text-slate-500 dark:text-white/60">
                            {formatSkillRole(skill.role)}
                          </p>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </section>

              <section className="rounded-[2rem] border border-slate-200 bg-white p-5 shadow-xl shadow-violet-950/5 dark:border-white/10 dark:bg-neutral-900">
                <div className="flex items-center justify-between gap-3">
                  <PanelSectionTitle icon="tools" title="Herramientas del turno">
                    <p className="mt-1 text-xs text-slate-500 dark:text-white/60">
                      Acciones que Gu ejecutó para contestar este turno.
                    </p>
                  </PanelSectionTitle>
                  <span className="rounded-full bg-violet-100 px-3 py-1 text-xs font-semibold text-violet-700 dark:bg-violet-400/10 dark:text-violet-200">
                    {toolsThisTurn.length}
                  </span>
                </div>

                <div className="mt-4 space-y-2">
                  {toolsThisTurn.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-slate-200 px-4 py-5 text-center text-xs text-slate-500 dark:border-white/10 dark:text-white/50">
                      {loading
                        ? "Esperando herramientas de este turno…"
                        : "Sin herramientas registradas para este turno (o la respuesta fue solo con contexto)."}
                    </div>
                  ) : (
                    toolsThisTurn.map((tool, index) => {
                      const detail = toolDetailText(tool);
                      const resultSummary = toolResultSummary(tool);
                      const executor = formatToolExecutor(tool.executor_kind);
                      return (
                        <div
                          key={tool.id}
                          className="flex items-center gap-3 rounded-2xl bg-white/70 px-3 py-3 text-sm ring-1 ring-slate-100 dark:bg-white/5 dark:ring-white/10"
                        >
                          <span
                            className={`h-2.5 w-2.5 shrink-0 rounded-full ${toolStatusClass(tool.status)}`}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-start justify-between gap-3">
                              <div className="flex min-w-0 flex-1 items-center gap-2">
                                <p className="truncate font-medium text-slate-800 dark:text-white">
                                  {toolsThisTurn.length > 1
                                    ? `${index + 1}. ${formatToolForUserPanel(tool.tool_name)}`
                                    : formatToolForUserPanel(tool.tool_name)}
                                </p>
                                <span
                                  className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${toolExecutorBadgeClass(executor.tone)}`}
                                  title={
                                    executor.tone === "deterministic"
                                      ? "Lectura determinística iniciada por el sistema (no por el modelo)."
                                      : "Llamada emitida por el modelo durante el turno."
                                  }
                                >
                                  {executor.label}
                                </span>
                              </div>
                              <span className="shrink-0 text-[11px] text-slate-400 dark:text-white/40">
                                {formatToolTime(tool.created_at)}
                              </span>
                            </div>
                            {detail ? (
                              <p className="mt-1 line-clamp-2 break-words text-[11px] text-slate-500 dark:text-white/55">
                                {detail}
                              </p>
                            ) : null}
                            {resultSummary ? (
                              <p className="mt-1 break-words text-[11px] text-slate-500 dark:text-white/55">
                                <span className="font-semibold text-slate-600 dark:text-white/70">
                                  Resultado:
                                </span>{" "}
                                {resultSummary}
                              </p>
                            ) : null}
                            <div className="mt-1 flex items-center justify-between gap-3 text-xs text-slate-500 dark:text-white/60">
                              <p className="min-w-0">
                                {formatToolStatus(tool.status)}
                                {tool.requires_confirmation ? " · HITL" : ""}
                              </p>
                              {hasTechnicalToolDetail(tool) ? (
                                <button
                                  type="button"
                                  onClick={() =>
                                    setExpandedToolCallId((current) =>
                                      current === tool.id ? null : tool.id
                                    )
                                  }
                                  className="shrink-0 font-semibold text-violet-700 hover:text-violet-900 dark:text-violet-200 dark:hover:text-violet-100"
                                >
                                  Ver detalle técnico{" "}
                                  {expandedToolCallId === tool.id ? "▾" : "▸"}
                                </button>
                              ) : null}
                            </div>
                            {expandedToolCallId === tool.id
                              ? renderToolTechnicalDetail(tool)
                              : null}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </section>

              <section className="rounded-[2rem] border border-slate-200 bg-white p-5 shadow-xl shadow-violet-950/5 dark:border-white/10 dark:bg-neutral-900">
                <div className="flex items-center justify-between gap-3">
                  <PanelSectionTitle icon="learnings" title="Aprendizajes recientes">
                    <p className="mt-1 text-xs text-slate-500 dark:text-white/60">
                      Últimas memorias que Gu ha guardado para ti.
                    </p>
                  </PanelSectionTitle>
                  <span className="rounded-full bg-violet-100 px-3 py-1 text-xs font-semibold text-violet-700 dark:bg-violet-400/10 dark:text-violet-200">
                    {initialRecentLearnings.length}
                  </span>
                </div>

                <div className="mt-4 space-y-2">
                  {initialRecentLearnings.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-slate-200 px-4 py-4 text-center text-xs text-slate-500 dark:border-white/10 dark:text-white/50">
                      Sin aprendizajes guardados recientemente.
                    </div>
                  ) : (
                    initialRecentLearnings.map((learning) => (
                      <div
                        key={learning.id}
                        className="rounded-2xl bg-white/70 px-3 py-3 text-sm ring-1 ring-slate-100 dark:bg-white/5 dark:ring-white/10"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-200">
                            {formatMemoryType(learning.type)}
                          </span>
                          <span className="shrink-0 text-[11px] text-slate-400 dark:text-white/40">
                            {formatLearningTime(learning.created_at)}
                          </span>
                        </div>
                        <p className="mt-2 line-clamp-2 font-medium text-slate-800 dark:text-white">
                          {learning.content}
                        </p>
                      </div>
                    ))
                  )}
                </div>
              </section>

              <section className="rounded-[2rem] border border-violet-100 bg-white p-5 shadow-xl shadow-violet-950/5 dark:border-white/10 dark:bg-neutral-900">
                <div className="flex items-start justify-between gap-4">
                  <PanelSectionTitle icon="presence" title="Actividad proactiva">
                    <p className="mt-1 text-xs text-slate-500 dark:text-white/60">
                      Actividad proactiva y automatizaciones fuera del turno actual.
                    </p>
                  </PanelSectionTitle>
                  <span
                    className={`relative inline-flex h-8 w-8 items-center justify-center rounded-full ${
                      heartbeatStatus?.enabled
                        ? "bg-fuchsia-100 text-fuchsia-600 dark:bg-fuchsia-400/10 dark:text-fuchsia-200"
                        : "bg-slate-100 text-slate-400 dark:bg-white/10 dark:text-white/40"
                    }`}
                    title={heartbeatStatus?.enabled ? "Pulso operativo activo" : "Pulso operativo inactivo"}
                  >
                    {heartbeatStatus?.enabled ? (
                      <span className="absolute inline-flex h-8 w-8 rounded-full bg-fuchsia-400/25" />
                    ) : null}
                    <span
                      className={`relative text-base leading-none ${
                        heartbeatStatus?.enabled ? "" : ""
                      }`}
                    >
                      ♥
                    </span>
                  </span>
                </div>
                <div className="mt-4 space-y-3 text-xs">
                  <div className="rounded-2xl bg-emerald-50 p-3 text-emerald-900 dark:bg-emerald-400/10 dark:text-emerald-100">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-semibold">Pulso</p>
                        <p className="mt-1 opacity-70">
                          {heartbeatStatus?.enabled
                            ? `Activo · cada ${heartbeatStatus.intervalMinutes} min`
                            : "Desactivado actualmente"}
                        </p>
                      </div>
                      {heartbeatStatus?.lastRun ? (
                        <span className="rounded-full bg-white/70 px-2 py-0.5 font-semibold text-emerald-800 dark:bg-white/10 dark:text-emerald-100">
                          {formatHeartbeatStatus(heartbeatStatus.lastRun.status)}
                        </span>
                      ) : null}
                    </div>
                    {heartbeatStatus?.lastRun ? (
                      <div className="mt-2 rounded-xl bg-white/55 p-2 dark:bg-white/10">
                        <div className="max-h-44 overflow-y-auto pr-1">
                          <p className="mb-1 font-semibold opacity-80">
                            {formatLearningTime(heartbeatStatus.lastRun.startedAt)}
                          </p>
                          {heartbeatItemCountFromDetails(
                            heartbeatStatus.lastRun.details
                          ) > 0 ? (
                            <p className="mb-1 text-[11px] opacity-70">
                              {heartbeatItemCountFromDetails(
                                heartbeatStatus.lastRun.details
                              )}{" "}
                              item(s) evaluados
                              {heartbeatAppliedSkillsFromDetails(
                                heartbeatStatus.lastRun.details
                              ).length > 0
                                ? ` · skills: ${heartbeatAppliedSkillsFromDetails(
                                    heartbeatStatus.lastRun.details
                                  ).join(", ")}`
                                : ""}
                            </p>
                          ) : null}
                          <HeartbeatDigestBulletList items={heartbeatDigest} />
                        </div>
                        {previousHeartbeatRuns.length > 0 ? (
                          <button
                            type="button"
                            onClick={() =>
                              setHeartbeatHistoryExpanded((expanded) => !expanded)
                            }
                            className="mt-2 text-[11px] font-semibold text-emerald-700 underline-offset-2 hover:underline dark:text-emerald-100"
                          >
                            {heartbeatHistoryExpanded
                              ? "Ocultar historial"
                              : `Ver ${previousHeartbeatRuns.length === 1 ? "heartbeat anterior" : `los ${previousHeartbeatRuns.length} heartbeats anteriores`}`}
                          </button>
                        ) : null}
                        {heartbeatHistoryExpanded ? (
                          <div className="mt-2 max-h-64 space-y-2 overflow-y-auto border-t border-emerald-200/70 pt-2 dark:border-white/10">
                            {previousHeartbeatRuns.map((run, runIndex) => {
                              const runDigest = heartbeatDigestItems(run.summary);
                              return (
                                <div
                                  key={`${run.startedAt}-${run.status}-${runIndex}`}
                                  className="rounded-lg bg-white/55 p-2 dark:bg-white/10"
                                >
                                  <div className="flex items-center justify-between gap-2">
                                    <span className="font-semibold opacity-80">
                                      {formatLearningTime(run.startedAt)}
                                    </span>
                                    <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-800 dark:bg-white/10 dark:text-emerald-100">
                                      {formatHeartbeatStatus(run.status)}
                                    </span>
                                  </div>
                                  <div className="mt-2 max-h-28 overflow-y-scroll pr-1">
                                    <HeartbeatDigestBulletList items={runDigest} />
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        ) : null}
                      </div>
                    ) : (
                      <p className="mt-2 opacity-80">Aún no hay corridas registradas.</p>
                    )}
                  </div>
                  <div className="rounded-2xl bg-violet-50 p-3 text-violet-900 dark:bg-violet-400/10 dark:text-violet-100">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-semibold">Tareas programadas</p>
                        <p className="mt-1 opacity-70">
                          Programadas por ti, ejecutadas por Gu.
                        </p>
                      </div>
                      <span className="rounded-full bg-white/70 px-2 py-0.5 font-semibold text-violet-800 dark:bg-white/10 dark:text-violet-100">
                        {scheduledTaskSummary?.activeCount ?? 0} activas
                      </span>
                    </div>
                    <div className="mt-2 space-y-1.5 opacity-80">
                      {scheduledTaskSummary?.nextTask ? (
                        <div className="flex items-start justify-between gap-x-2 gap-y-1.5">
                          <p className="min-w-0 flex-1 text-[13px] leading-snug">
                            {formatScheduledTaskRunLabel(scheduledTaskSummary.nextTask)}{" "}
                            ·{" "}
                            {truncatePanelText(
                              displayScheduledTaskText(scheduledTaskSummary.nextTask)
                            )}
                          </p>
                          <span
                            className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${scheduledTaskScheduleTypeClass(
                              scheduledTaskSummary.nextTask.scheduleType
                            )}`}
                          >
                            {formatScheduledTaskScheduleType(
                              scheduledTaskSummary.nextTask.scheduleType
                            )}
                          </span>
                        </div>
                      ) : (
                        <p>Sin próximas tareas activas.</p>
                      )}
                      {scheduledTaskSummary?.nextTask?.skillId ? (
                        <p className="text-[11px] opacity-70">
                          {formatScheduledTaskSkillLabel(
                            scheduledTaskSummary.nextTask.skillId
                          )}
                        </p>
                      ) : null}
                    </div>
                    {scheduledTaskSummary?.pausedCount ? (
                      <p className="mt-1 opacity-70">
                        {scheduledTaskSummary.pausedCount} pausada(s).
                      </p>
                    ) : null}
                    {scheduledTaskSummary?.lastFailure ? (
                      <p className="mt-1 text-red-700 dark:text-red-200">
                        Último fallo:{" "}
                        {formatScheduledTaskFailureForUser(
                          scheduledTaskSummary.lastFailure
                        )}
                      </p>
                    ) : null}
                    {scheduledTasks.length > 0 ? (
                      <button
                        type="button"
                        onClick={() =>
                          setScheduledTasksExpanded((expanded) => !expanded)
                        }
                        className="mt-2 text-[11px] font-semibold text-violet-700 underline-offset-2 hover:underline dark:text-violet-100"
                      >
                        {scheduledTasksExpanded
                          ? "Ocultar tareas"
                          : "Ver todas (activas y pausadas)"}
                      </button>
                    ) : null}
                    {scheduledTasksExpanded ? (
                      <div className="mt-2 max-h-64 space-y-2 overflow-y-auto border-t border-violet-200/70 pt-2 dark:border-white/10">
                        {scheduledTasks.map((task) => {
                          const taskDisplayText = displayScheduledTaskText(task);
                          const taskTimingText = formatScheduledTaskRunLabel(task);
                          return (
                            <div
                              key={task.id}
                              className="rounded-lg bg-white/55 p-2 dark:bg-white/10"
                            >
                              <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5">
                                <p className="min-w-0 flex-1 font-semibold">{taskTimingText}</p>
                                <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
                                  <span
                                    className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${scheduledTaskScheduleTypeClass(
                                      task.scheduleType
                                    )}`}
                                  >
                                    {formatScheduledTaskScheduleType(
                                      task.scheduleType
                                    )}
                                  </span>
                                  <span
                                    className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${scheduledTaskStatusClass(task.status)}`}
                                  >
                                    {formatScheduledTaskStatus(task.status)}
                                  </span>
                                </div>
                              </div>
                              <div className="mt-2 max-h-24 overflow-y-scroll pr-1">
                                <p className="break-words font-medium">
                                  {taskDisplayText}
                                </p>
                                {task.skillId ? (
                                  <p className="mt-1 text-[11px] opacity-70">
                                    {formatScheduledTaskSkillLabel(task.skillId)}
                                  </p>
                                ) : null}
                                {taskDisplayText !== task.prompt ? (
                                  <p className="mt-2 break-words text-[11px] opacity-60">
                                    Instrucción programada: {task.prompt}
                                  </p>
                                ) : null}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                </div>
              </section>
            </aside>
          </div>
    </div>
  );
}
