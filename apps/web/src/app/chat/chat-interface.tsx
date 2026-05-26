"use client";

import {
  useState,
  useRef,
  useLayoutEffect,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import {
  formatSkillForUserPanel,
  formatSkillRole,
  type AppliedSkillDisplay,
} from "@/lib/skill-display";
import { formatToolForUserPanel } from "@/lib/tool-display";
import { internalNotificationKindConfig } from "@/lib/internal-notifications/registry";

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

interface InternalNotificationDisplay {
  id: string;
  kind: string;
  title: string;
  body: string;
  priority: "low" | "normal" | "high";
  action_url: string | null;
  due_at: string | null;
  created_at: string;
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
  initialNotifications?: InternalNotificationDisplay[];
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

function toolDetailText(tool: RecentToolCall): string {
  const args = tool.arguments_json;
  if (!args) return "";
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
      "bg-sky-100 text-sky-800 dark:bg-sky-400/15 dark:text-sky-100 animate-pulse",
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
  if (source === "heartbeat") return "Heartbeat proactivo";
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

  for (const row of additions) {
    stripOptimisticDuplicate(row);
    push(row);
  }
  for (const row of prev) push(row);
  return out.slice(0, maxTotal);
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
  initialNotifications = [],
}: Props) {
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [toolCalls, setToolCalls] = useState<RecentToolCall[]>(initialToolCalls);
  const [heartbeatStatus, setHeartbeatStatus] = useState<HeartbeatStatus | undefined>(
    initialHeartbeatStatus
  );
  const [scheduledTaskSummary, setScheduledTaskSummary] = useState<
    ScheduledTaskSummary | undefined
  >(initialScheduledTaskSummary);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [confirmation, setConfirmation] = useState<PendingConfirmation | null>(
    initialPendingConfirmation
  );
  const [confirming, setConfirming] = useState(false);
  const [contextExpanded, setContextExpanded] = useState(false);
  const [shortTermExpanded, setShortTermExpanded] = useState(false);
  const [heartbeatHistoryExpanded, setHeartbeatHistoryExpanded] = useState(false);
  const [scheduledTasksExpanded, setScheduledTasksExpanded] = useState(false);
  const [notificationsExpanded, setNotificationsExpanded] = useState(false);
  const [notifications, setNotifications] =
    useState<InternalNotificationDisplay[]>(initialNotifications);
  const [notificationInputs, setNotificationInputs] = useState<Record<string, string>>({});
  const [notificationActionStatus, setNotificationActionStatus] =
    useState<Record<string, string>>({});
  const [notificationCleanupStatus, setNotificationCleanupStatus] = useState<string | null>(null);
  const [operationalEvents, setOperationalEvents] = useState<OperationalEvent[]>([]);
  const [selectedTurnId, setSelectedTurnId] = useState<string | null>(
    () =>
      initialPendingConfirmation?.turnId ??
      defaultSelectedTurnId(initialMessages)
  );
  const messagesViewportRef = useRef<HTMLDivElement>(null);
  const didInitialScrollRef = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const syncAfterRef = useRef<string | null>(
    initialMessages.at(-1)?.created_at ?? null
  );
  const messagesRef = useRef<Message[]>(initialMessages);
  const loadingRef = useRef(false);
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
  async function refreshNotifications() {
    const res = await fetch("/api/notifications");
    const data = (await res.json().catch(() => ({}))) as {
      notifications?: InternalNotificationDisplay[];
    };
    if (res.ok && Array.isArray(data.notifications)) {
      setNotifications(data.notifications);
    }
  }

  async function updateNotificationStatus(
    id: string,
    status: "read" | "actioned" | "dismissed"
  ) {
    const res = await fetch("/api/notifications", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, status }),
    });
    if (res.ok) {
      setNotifications((current) => current.filter((item) => item.id !== id));
    }
  }

  async function cleanupSettingsTestNotifications() {
    setNotificationCleanupStatus("Limpiando pendientes de prueba...");
    const res = await fetch("/api/notifications?scope=settings-test", {
      method: "DELETE",
    });
    const data = (await res.json().catch(() => ({}))) as {
      deleted?: number;
      error?: string;
    };
    if (res.ok) {
      setNotificationCleanupStatus(
        `Pendientes de prueba eliminados: ${data.deleted ?? 0}.`
      );
      await refreshNotifications();
    } else {
      setNotificationCleanupStatus(
        data.error ?? "No se pudieron limpiar los pendientes de prueba."
      );
    }
  }

  async function submitPriceApprovalDecision(
    notificationId: string,
    payload: { action?: "approve" | "reject"; text?: string }
  ) {
    setNotificationActionStatus((current) => ({
      ...current,
      [notificationId]: "Procesando...",
    }));
    const res = await fetch("/api/business-decisions/price-approval", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        notification_id: notificationId,
        ...payload,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      message?: string;
    };
    setNotificationActionStatus((current) => ({
      ...current,
      [notificationId]: data.message ?? (res.ok ? "Listo." : "No se pudo procesar."),
    }));
    if (res.ok && data.ok !== false) {
      await refreshNotifications();
    }
  }
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

  useLayoutEffect(() => {
    const viewport = messagesViewportRef.current;
    if (!viewport) return;
    viewport.scrollTo({
      top: viewport.scrollHeight,
      behavior: didInitialScrollRef.current ? "smooth" : "auto",
    });
    didInitialScrollRef.current = true;
  }, [messages.length, confirmation?.toolCallId, loading]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    loadingRef.current = loading;
  }, [loading]);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;

    async function syncAutomatedActivity() {
      if (cancelled || inFlight || document.visibilityState !== "visible") return;
      inFlight = true;
      try {
        const params = new URLSearchParams();
        const after = syncAfterRef.current;
        if (after) params.set("after", after);
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
        if (cancelled) return;
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
        if (Array.isArray(data.toolCalls)) {
          setToolCalls((prev) => mergeToolCalls(prev, data.toolCalls ?? []));
        }
        if (data.heartbeatStatus) setHeartbeatStatus(data.heartbeatStatus);
        if (data.scheduledTaskSummary) {
          setScheduledTaskSummary(data.scheduledTaskSummary);
        }
      } catch {
        // Polling is best-effort; the next tick will retry.
      } finally {
        inFlight = false;
      }
    }

    const interval = window.setInterval(syncAutomatedActivity, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

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

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || loading) return;
    const clientTurnId = createClientTurnId();

    const userMsg: Message = {
      role: "user",
      content: text,
      created_at: new Date().toISOString(),
      turn_id: clientTurnId,
      structured_payload: { appliedSkills: [], memoryUsed: [] },
    };
    setMessages((prev) => [...prev, userMsg]);
    setSelectedTurnId(clientTurnId);
    setShortTermExpanded(false);
    setOperationalEvents([]);
    setInput("");
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
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, turnId: clientTurnId }),
      });

      const data = (await res.json()) as {
        response?: string | null;
        turnId?: string;
        appliedSkills?: AppliedSkillDisplay[];
        memoryUsed?: AppliedMemoryDisplay[];
        pendingConfirmation?: PendingConfirmation | null;
        toolCalls?: string[];
        error?: string;
      };

      if (!res.ok) {
        const errText =
          typeof data.error === "string"
            ? data.error
            : `Error HTTP ${res.status}`;
        const errIso = new Date().toISOString();
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant" as const,
            content: `Error: ${errText}`,
            created_at: errIso,
            turn_id: data.turnId ?? clientTurnId,
            structured_payload: {
              appliedSkills: data.appliedSkills ?? [],
              memoryUsed: data.memoryUsed ?? [],
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

      if (Array.isArray(data.toolCalls) && data.toolCalls.length > 0) {
        const optimistic = data.toolCalls.map((name, index) => ({
          id: `turn-${assistantIso}-${index}-${name}`,
          turn_id: data.turnId ?? clientTurnId,
          tool_name: name,
          status: "executed",
          requires_confirmation: false,
          created_at: assistantIso,
          finished_at: assistantIso,
        }));
        setToolCalls((prev) => mergeToolCalls(prev, optimistic));
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
        toolCalls?: string[];
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

      if (Array.isArray(data.toolCalls) && data.toolCalls.length > 0) {
        const turnId = data.turnId ?? confirmation.turnId ?? null;
        const optimistic = data.toolCalls.map((name, index) => ({
          id: `turn-${assistantIso}-${index}-${name}`,
          turn_id: turnId,
          tool_name: name,
          status: "executed",
          requires_confirmation: false,
          created_at: assistantIso,
          finished_at: assistantIso,
        }));
        setToolCalls((prev) => mergeToolCalls(prev, optimistic));
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

  return (
    <div className="h-screen overflow-hidden bg-[#f8f4ff] text-slate-950 dark:bg-[#090411] dark:text-white">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -left-32 top-16 h-72 w-72 rounded-full bg-violet-500/20 blur-3xl" />
        <div className="absolute right-0 top-0 h-96 w-96 rounded-full bg-fuchsia-500/20 blur-3xl" />
      </div>

      <div className="relative flex h-full">
        <main className="flex min-h-0 min-w-0 flex-1 flex-col px-3 py-3 sm:px-5 sm:py-5">
          <header className="mb-4 grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,0.95fr)_460px] 2xl:grid-cols-[minmax(0,0.9fr)_520px]">
            <div className="flex min-w-0 items-center gap-3 rounded-[2rem] border border-white/70 bg-white/70 px-4 py-3 shadow-sm backdrop-blur-xl dark:border-white/10 dark:bg-white/5">
              <div className="flex h-12 w-20 shrink-0 items-center justify-center rounded-2xl border border-violet-100 bg-white px-3 shadow-sm dark:border-white/10 dark:bg-white/90">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="/ungga-logo.png"
                  alt="Logo de la cuenta"
                  className="max-h-9 w-full object-contain"
                />
              </div>
              <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-gradient-to-br from-violet-700 to-fuchsia-600 text-sm font-bold text-white shadow-lg shadow-violet-900/20">
                {agentAvatarUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={agentAvatarUrl} alt="Avatar del colaborador IA" className="h-full w-full object-cover" />
                ) : (
                  agentInitial
                )}
              </div>
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-[0.28em] text-violet-700 dark:text-violet-200">
                  Consola Ungga
                </p>
                <h1 className="truncate text-lg font-semibold text-slate-950 dark:text-white">
                  {agentName}
                </h1>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 rounded-[2rem] border border-white/70 bg-white/70 px-4 py-3 shadow-sm backdrop-blur-xl dark:border-white/10 dark:bg-white/5">
              <span className="hidden rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700 dark:border-emerald-400/20 dark:bg-emerald-400/10 dark:text-emerald-200 sm:inline-flex">
                {agentStatus}
              </span>
              <a
                href="/memory"
                className="hidden rounded-full border border-slate-200 bg-white/70 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-white dark:border-white/10 dark:bg-white/5 dark:text-white/70 dark:hover:bg-white/10 sm:inline-flex"
              >
                Memoria
              </a>
              <a
                href="/operational-cases"
                className="hidden rounded-full border border-slate-200 bg-white/70 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-white dark:border-white/10 dark:bg-white/5 dark:text-white/70 dark:hover:bg-white/10 lg:inline-flex"
              >
                Casos operacionales
              </a>
              <button
                type="button"
                onClick={() => {
                  setNotificationsExpanded((value) => !value);
                  if (!notificationsExpanded) void refreshNotifications();
                }}
                className="rounded-full border border-violet-200 bg-violet-50 px-3 py-1.5 text-xs font-semibold text-violet-700 hover:bg-violet-100 dark:border-violet-400/20 dark:bg-violet-400/10 dark:text-violet-100"
              >
                Pendientes {notifications.length > 0 ? `(${notifications.length})` : ""}
              </button>
              <a
                href="/settings"
                className="rounded-full border border-slate-200 bg-white/70 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-white dark:border-white/10 dark:bg-white/5 dark:text-white/70 dark:hover:bg-white/10"
              >
                Ajustes
              </a>
              <form action="/api/auth/signout" method="POST">
                <button
                  type="submit"
                  className="rounded-full border border-slate-200 bg-white/70 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-white dark:border-white/10 dark:bg-white/5 dark:text-white/70 dark:hover:bg-white/10"
                >
                  Salir
                </button>
              </form>
            </div>
          </header>

          {notificationsExpanded ? (
            <section className="mb-4 rounded-[1.5rem] border border-violet-100 bg-white/85 p-4 text-sm shadow-sm backdrop-blur-xl dark:border-white/10 dark:bg-white/[0.06]">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="font-semibold text-slate-950 dark:text-white">
                    Pendientes internos
                  </h2>
                  <p className="text-xs text-slate-500 dark:text-white/50">
                    Notificaciones persistentes guardadas para tu usuario web.
                  </p>
                </div>
                <div className="flex flex-wrap justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => void cleanupSettingsTestNotifications()}
                    className="rounded-full border border-rose-200 px-3 py-1 text-xs font-semibold text-rose-700 hover:bg-rose-50 dark:border-rose-300/20 dark:text-rose-100 dark:hover:bg-rose-300/10"
                  >
                    Limpiar pruebas
                  </button>
                  <button
                    type="button"
                    onClick={() => void refreshNotifications()}
                    className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50 dark:border-white/10 dark:text-white/70 dark:hover:bg-white/10"
                  >
                    Refrescar
                  </button>
                </div>
              </div>
              {notificationCleanupStatus ? (
                <p className="mt-2 rounded-2xl bg-slate-50 p-2 text-xs text-slate-500 dark:bg-white/5 dark:text-white/60">
                  {notificationCleanupStatus}
                </p>
              ) : null}
              {notifications.length === 0 ? (
                <p className="mt-3 rounded-2xl bg-slate-50 p-3 text-xs text-slate-500 dark:bg-white/5 dark:text-white/60">
                  No tienes pendientes internos sin leer.
                </p>
              ) : (
                <div className="mt-3 grid gap-2">
                  {notifications.map((notification) => (
                    <div
                      key={notification.id}
                      className="rounded-2xl border border-slate-200 bg-white p-3 text-xs dark:border-white/10 dark:bg-white/5"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <p className="font-semibold text-slate-900 dark:text-white">
                            {internalNotificationKindConfig(notification.kind).label}
                          </p>
                          {notification.title !== notification.kind ? (
                            <p className="mt-0.5 text-[11px] text-slate-400">
                              {notification.title}
                            </p>
                          ) : null}
                          <p className="mt-1 text-slate-600 dark:text-white/70">
                            {notification.body}
                          </p>
                          <p className="mt-1 text-[11px] text-slate-400">
                            Prioridad: {notification.priority}
                            {notification.due_at
                              ? ` · vence ${new Date(notification.due_at).toLocaleString()}`
                              : ""}
                          </p>
                          {notification.kind === "price_approval" ? (
                            <div className="mt-3 space-y-2 rounded-2xl border border-amber-100 bg-amber-50/70 p-2 dark:border-amber-300/20 dark:bg-amber-300/10">
                              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-700 dark:text-amber-100">
                                Aprobacion de precio
                              </p>
                              <div className="flex flex-wrap gap-1">
                                <button
                                  type="button"
                                  onClick={() =>
                                    void submitPriceApprovalDecision(notification.id, {
                                      action: "approve",
                                    })
                                  }
                                  className="rounded-full bg-emerald-600 px-2 py-1 font-semibold text-white hover:bg-emerald-700"
                                >
                                  Aprobar
                                </button>
                              </div>
                              <div className="flex flex-col gap-1 sm:flex-row">
                                <input
                                  value={notificationInputs[notification.id] ?? ""}
                                  onChange={(event) =>
                                    setNotificationInputs((current) => ({
                                      ...current,
                                      [notification.id]: event.target.value,
                                    }))
                                  }
                                  placeholder="Ej. AJUSTAR PRECIO salida=23500 ideal=22000 minimo=18000"
                                  className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs outline-none focus:border-violet-300 dark:border-white/10 dark:bg-slate-950"
                                />
                                <button
                                  type="button"
                                  onClick={() =>
                                    void submitPriceApprovalDecision(notification.id, {
                                      text: notificationInputs[notification.id] ?? "",
                                    })
                                  }
                                  className="rounded-xl border border-violet-200 px-3 py-2 font-semibold text-violet-700 hover:bg-violet-50 dark:border-violet-300/20 dark:text-violet-100"
                                >
                                  Ajustar y aprobar
                                </button>
                              </div>
                              {notificationActionStatus[notification.id] ? (
                                <p className="text-[11px] text-slate-500 dark:text-white/60">
                                  {notificationActionStatus[notification.id]}
                                </p>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                        <div className="flex shrink-0 flex-wrap gap-1">
                          {notification.action_url ? (
                            <a
                              href={notification.action_url}
                              className="rounded-full bg-violet-700 px-2 py-1 font-semibold text-white hover:bg-violet-800"
                            >
                              Abrir
                            </a>
                          ) : null}
                          <button
                            type="button"
                            onClick={() =>
                              void updateNotificationStatus(notification.id, "read")
                            }
                            className="rounded-full border border-slate-200 px-2 py-1 font-semibold text-slate-600 hover:bg-slate-50 dark:border-white/10 dark:text-white/70"
                          >
                            Leida
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              void updateNotificationStatus(notification.id, "actioned")
                            }
                            className="rounded-full border border-emerald-200 px-2 py-1 font-semibold text-emerald-700 hover:bg-emerald-50"
                          >
                            Atendida
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          ) : null}

          <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 xl:grid-cols-[minmax(0,0.95fr)_460px] 2xl:grid-cols-[minmax(0,0.9fr)_520px]">
            <section className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[2rem] border border-white/70 bg-white/75 shadow-xl shadow-violet-950/5 backdrop-blur-xl dark:border-white/10 dark:bg-white/[0.06]">
              <div className="border-b border-slate-200/70 px-5 py-4 dark:border-white/10">
                <p className="text-sm font-semibold text-slate-900 dark:text-white">
                  Conversación
                </p>
                <p className="text-xs text-slate-500 dark:text-white/50">
                  Apóyate en Gu, tu colaborador digital.
                </p>
              </div>

              {/* Messages */}
              <div ref={messagesViewportRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-6">
                <div className="mx-auto max-w-2xl space-y-4">
          {messages.length === 0 && (
            <div className="mx-auto max-w-md rounded-3xl border border-violet-100 bg-violet-50/80 px-6 py-10 text-center text-sm text-slate-500 dark:border-white/10 dark:bg-white/5 dark:text-white/60">
              <p className="text-lg font-semibold text-slate-900 dark:text-white">
                Hola, soy {agentName}
              </p>
              <p className="mt-2">Estoy listo para ayudarte a organizar, decidir y ejecutar tareas.</p>
            </div>
          )}
          {messages.map((msg, i) => {
            const sourceLabel = messageSourceLabel(msg);
            return (
            <div
              key={i}
              role={msg.turn_id ? "button" : undefined}
              tabIndex={msg.turn_id ? 0 : undefined}
              title={msg.turn_id ? "Ver contexto de este turno" : undefined}
              onClick={() => {
                if (msg.turn_id) setSelectedTurnId(msg.turn_id);
              }}
              onKeyDown={(event) => {
                if (!msg.turn_id) return;
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setSelectedTurnId(msg.turn_id);
                }
              }}
              className={`flex items-start gap-2 rounded-[1.75rem] outline-none transition ${
                msg.turn_id ? "cursor-pointer" : ""
              } ${msg.role === "user" ? "justify-end" : "justify-start"}`}
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
                className={`max-w-[82%] rounded-3xl px-4 py-3 text-sm leading-relaxed shadow-sm ${
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
                {msg.role === "assistant" ? (
                  <div className="prose prose-sm max-w-none prose-p:my-1 prose-li:my-0.5 prose-ol:my-1 prose-ul:my-1 prose-a:text-violet-700 prose-a:underline dark:prose-invert dark:prose-a:text-violet-200">
                    <ReactMarkdown
                      components={{
                        a: ({ href, children }) => (
                          <a href={href} target="_blank" rel="noopener noreferrer">
                            {children}
                          </a>
                        ),
                      }}
                    >
                      {msg.content}
                    </ReactMarkdown>
                  </div>
                ) : (
                  <p className="whitespace-pre-wrap">{msg.content}</p>
                )}
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
                <span className="animate-pulse">Pensando...</span>
              </div>
            </div>
          )}
          <div ref={bottomRef} />
                </div>
              </div>

              {/* Input */}
              <div className="border-t border-slate-200/70 bg-white/80 px-4 py-4 dark:border-white/10 dark:bg-white/[0.03]">
                <form onSubmit={handleSend} className="mx-auto flex max-w-2xl items-center gap-2 rounded-2xl border border-slate-200 bg-white p-2 shadow-sm dark:border-white/10 dark:bg-white/10">
                  <button
                    type="button"
                    aria-label="Adjuntar archivo"
                    title="Adjuntar archivo"
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-slate-500 hover:bg-violet-50 hover:text-violet-700 dark:text-white/60 dark:hover:bg-white/10 dark:hover:text-white"
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
                  <input
                    type="text"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder={confirmation ? "Resuelve la confirmación para continuar..." : "Dile a Gu qué necesitas..."}
                    disabled={loading || !!confirmation}
                    className="min-w-0 flex-1 bg-transparent px-3 py-2 text-sm text-slate-900 outline-none placeholder:text-slate-400 disabled:opacity-50 dark:text-white dark:placeholder:text-white/40"
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
                    disabled={loading || !input.trim() || !!confirmation}
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-violet-700 to-fuchsia-600 text-white shadow-lg shadow-violet-900/20 transition hover:from-violet-800 hover:to-fuchsia-700 disabled:cursor-not-allowed disabled:opacity-50"
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
                </form>
              </div>
            </section>

            <aside className="hidden min-h-0 flex-col gap-4 overflow-y-auto pr-1 xl:flex">
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
                            <span className="absolute inline-flex size-8 animate-ping rounded-full bg-fuchsia-400/[0.13]" />
                          ) : null}
                          <span
                            className={`relative text-[1.625rem] leading-none ${
                              heartbeatStatus?.enabled
                                ? "animate-pulse text-fuchsia-300 drop-shadow-[0_0_6px_rgba(244,114,182,0.28)]"
                                : "text-white/45"
                            }`}
                            aria-hidden="true"
                          >
                            ♥
                          </span>
                        </span>
                        <span className="text-base leading-tight">Heartbeat</span>
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
                      {confirmation ? "1" : "0"}
                    </p>
                    <p className="mt-0.5 text-violet-100">Por aprobar</p>
                  </div>
                </div>
              </section>

              <section className="rounded-[2rem] border border-white/70 bg-white/75 p-5 shadow-xl shadow-violet-950/5 backdrop-blur-xl dark:border-white/10 dark:bg-white/[0.06]">
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
                        <span className="absolute inline-flex h-3.5 w-3.5 animate-ping rounded-full bg-violet-500/60" />
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2 font-medium text-slate-800 dark:text-white">
                        {loading ? "Procesando solicitud" : "Procesamiento"}
                        {loading && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-violet-600 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
                            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
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
                          <div className="h-full w-1/2 animate-pulse rounded-full bg-violet-500" />
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

              <section className="rounded-[2rem] border border-white/70 bg-white/75 p-5 shadow-xl shadow-violet-950/5 backdrop-blur-xl dark:border-white/10 dark:bg-white/[0.06]">
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

              <section className="rounded-[2rem] border border-white/70 bg-white/75 p-5 shadow-xl shadow-violet-950/5 backdrop-blur-xl dark:border-white/10 dark:bg-white/[0.06]">
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

              <section className="rounded-[2rem] border border-white/70 bg-white/75 p-5 shadow-xl shadow-violet-950/5 backdrop-blur-xl dark:border-white/10 dark:bg-white/[0.06]">
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
                            <p className="mt-1 text-xs text-slate-500 dark:text-white/60">
                              {formatToolStatus(tool.status)}
                              {tool.requires_confirmation ? " · HITL" : ""}
                            </p>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </section>

              <section className="rounded-[2rem] border border-white/70 bg-white/75 p-5 shadow-xl shadow-violet-950/5 backdrop-blur-xl dark:border-white/10 dark:bg-white/[0.06]">
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

              <section className="rounded-[2rem] border border-violet-100 bg-white/80 p-5 shadow-xl shadow-violet-950/5 backdrop-blur-xl dark:border-white/10 dark:bg-white/[0.06]">
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
                    title={heartbeatStatus?.enabled ? "Heartbeat activo" : "Heartbeat inactivo"}
                  >
                    {heartbeatStatus?.enabled ? (
                      <span className="absolute inline-flex h-8 w-8 animate-ping rounded-full bg-fuchsia-400/25" />
                    ) : null}
                    <span
                      className={`relative text-base leading-none ${
                        heartbeatStatus?.enabled ? "animate-pulse" : ""
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
                        <p className="font-semibold">Heartbeat proactivo</p>
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
        </main>
      </div>
    </div>
  );
}
