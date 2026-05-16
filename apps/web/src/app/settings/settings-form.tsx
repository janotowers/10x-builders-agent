"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createBrowserClient } from "@supabase/ssr";
import { TOOL_CATALOG } from "@agents/agent/src/tools/catalog";
import {
  HEARTBEAT_CHECKLIST_TEMPLATES,
  generateHeartbeatChecklistProposal,
  normalizeHeartbeatChecklist,
  validateHeartbeatChecklist,
} from "@agents/agent/src/heartbeat/checklist";
import type { HeartbeatChecklistTemplate } from "@agents/agent/src/heartbeat/checklist";
import type {
  BusinessBrain,
  BusinessBrainWarehouseSource,
  HeartbeatChecklistTemplateRow,
  HeartbeatRun,
  ToolRisk,
} from "@agents/types";

interface Props {
  userId: string;
  profile: Record<string, unknown> | null;
  toolSettings: Array<{ tool_id: string; enabled: boolean }>;
  skillSettings: Array<{
    skill_id: string;
    enabled: boolean;
    config_json?: Record<string, unknown>;
  }>;
  skillCatalog: SkillCatalogItem[];
  telegramLinked: boolean;
  githubConnected: boolean;
  googleCalendarConnected: boolean;
  heartbeatRuns: HeartbeatRun[];
  scheduledTasks: ScheduledTaskItem[];
  heartbeatChecklistTemplates: HeartbeatChecklistTemplateRow[];
  /** Query `google_calendar` tras OAuth (connected | error). */
  googleOAuthStatus?: string;
  googleOAuthReason?: string;
}

interface ScheduledTaskItem {
  id: string;
  prompt: string;
  user_request?: string | null;
  display_title?: string | null;
  skill_id?: string | null;
  schedule_type: "one_time" | "recurring";
  run_at: string | null;
  cron_expr: string | null;
  timezone: string;
  status: "active" | "paused" | "completed" | "failed";
  last_run_at: string | null;
  next_run_at: string | null;
  consecutive_failures?: number;
  last_failure_error?: string | null;
}

interface SkillCatalogItem {
  name: string;
  description: string;
  scope: "business" | "personal" | "shared";
  allowedTools: string[];
  requiresTenantContext: boolean;
}

type HeartbeatTemplateOption = HeartbeatChecklistTemplate & {
  kind: "system" | "user";
  sourceTemplateId?: string | null;
};

type ReviewSlot =
  | "agent_identity.role"
  | "agent_identity.short_description"
  | "soul.voice"
  | "soul.tone"
  | "soul.style"
  | "soul.brevity"
  | "business_context.notes"
  | "operating_preferences.text";

interface SectionReviewResult {
  severity: "ok" | "warning" | "blocked";
  normalized_fields: Partial<Record<ReviewSlot, string>>;
  warnings: string[];
  moved_suggestions: Array<{ target_slot: string; text: string }>;
  rejected_items: Array<{ text: string; reason: string }>;
  used_llm: boolean;
}

type ReviewSection = "identity" | "soul" | "context" | "operating";

interface SectionReviewState {
  loading?: boolean;
  error?: string;
  result?: SectionReviewResult;
}

const TIMEZONES = [
  "America/Mexico_City",
  "America/Bogota",
  "America/Lima",
  "America/Santiago",
  "America/Buenos_Aires",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Europe/Madrid",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Tokyo",
  "Asia/Shanghai",
  "UTC",
];

const TOOL_IDS = [
  "get_user_preferences",
  "list_enabled_tools",
  "github_list_repos",
  "github_list_issues",
  "github_create_repo",
  "github_create_issue",
  "calendar_list_calendars",
  "calendar_list_events",
  "calendar_create_event",
  "calendar_update_event",
  "calendar_delete_event",
  "bash",
  "read_file",
  "write_file",
  "edit_file",
  "schedule_task",
  "manage_scheduled_tasks",
  "bigquery_run_query",
  "read_skill_reference",
  "list_user_memories",
  "search_user_memories",
  "archive_user_memory",
  "delete_user_memory",
];

const TOOL_DEF_BY_ID = new Map(TOOL_CATALOG.map((d) => [d.id, d]));

const TOOL_RISK_META: Record<
  ToolRisk,
  { label: string; hint: string }
> = {
  low: {
    label: "Bajo",
    hint: "Lectura o alcance acotado.",
  },
  medium: {
    label: "Medio",
    hint: "Puede modificar datos; suele pedir confirmación.",
  },
  high: {
    label: "Alto",
    hint: "Ejecución sensible o efectos amplios.",
  },
};

function toolRiskForSettings(id: string): ToolRisk {
  return TOOL_DEF_BY_ID.get(id)?.risk ?? "high";
}

const TOOL_RISK_ROW_CLASSES: Record<ToolRisk, string> = {
  low: "border-emerald-200 bg-emerald-50/90 dark:border-emerald-900 dark:bg-emerald-950/35",
  medium:
    "border-amber-200 bg-amber-50/90 dark:border-amber-900 dark:bg-amber-950/35",
  high: "border-red-200 bg-red-50/90 dark:border-red-900 dark:bg-red-950/40",
};

const TOOL_RISK_BADGE_CLASSES: Record<ToolRisk, string> = {
  low: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  medium: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  high: "bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200",
};

function toolRiskRowClasses(risk: ToolRisk): string {
  return TOOL_RISK_ROW_CLASSES[risk];
}

function toolRiskBadgeClasses(risk: ToolRisk): string {
  return TOOL_RISK_BADGE_CLASSES[risk];
}

const SKILL_SCOPE_LABELS: Record<SkillCatalogItem["scope"], string> = {
  business: "Negocio",
  personal: "Personal",
  shared: "Compartidas",
};

const SKILL_SCOPE_ORDER: SkillCatalogItem["scope"][] = [
  "business",
  "personal",
  "shared",
];

const DEFAULT_AGENT_NAME = "Gu";
const DEFAULT_AGENT_ROLE =
  "Colaborador IA operativo y comercial que ayuda a organizar prioridades, analizar información y ejecutar tareas con las herramientas disponibles.";
const DEFAULT_AGENT_DESCRIPTION =
  "Gu actúa como un copiloto práctico para el trabajo diario: entiende el contexto del usuario y del negocio, responde con claridad, propone próximos pasos y usa memoria, skills y herramientas cuando aportan valor, respetando permisos, confirmaciones y límites de datos.";
const DEFAULT_HEARTBEAT_INTERVAL_MINUTES = 30;
const DEFAULT_HEARTBEAT_CHECKLIST =
  HEARTBEAT_CHECKLIST_TEMPLATES.find(
    (template) => template.id === "hybrid-founder-operator"
  )?.markdown ?? `# Heartbeat checklist
- Detecta conflictos, cambios o huecos de preparación en agenda y próximos compromisos dentro de las siguientes 24 horas. Umbral: solo si hay evento próximo, conflicto, preparación faltante o decisión pendiente. Avisar cuando: hay una acción práctica que el usuario debe tomar antes del siguiente compromiso.`;
const PROFILE_ASSETS_BUCKET = "profile-assets";
const REVIEW_SLOT_LABELS: Record<ReviewSlot, string> = {
  "agent_identity.role": "Rol del colaborador IA",
  "agent_identity.short_description": "Descripción breve",
  "soul.voice": "Voz",
  "soul.tone": "Tono",
  "soul.style": "Estilo",
  "soul.brevity": "Brevedad",
  "business_context.notes": "Notas de contexto",
  "operating_preferences.text": "Preferencias operativas",
};
const REVIEW_TARGET_LABELS: Record<string, string> = {
  ...REVIEW_SLOT_LABELS,
  soul: "Alma",
  "business_context.notes": "Contexto del negocio",
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function readBusinessBrain(profile: Record<string, unknown> | null): BusinessBrain {
  const raw = profile?.business_brain;
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as BusinessBrain)
    : {};
}

function readWarehouse(brain: BusinessBrain): BusinessBrainWarehouseSource {
  const dataSources = asRecord(brain.data_sources);
  const warehouse = asRecord(dataSources.warehouse);
  const identity = asRecord(brain.identity);
  const bigquery = asRecord(brain.bigquery);
  return {
    provider: "bigquery",
    organization_id:
      readString(warehouse.organization_id) || readString(identity.organization_id),
    org_name: readString(warehouse.org_name) || readString(identity.org_name),
    country: readString(warehouse.country) || readString(identity.country),
    project_id: readString(warehouse.project_id) || readString(bigquery.project_id),
    location: readString(warehouse.location) || readString(bigquery.location),
    dataset_allowlist:
      readStringArray(warehouse.dataset_allowlist).length > 0
        ? readStringArray(warehouse.dataset_allowlist)
        : readStringArray(bigquery.dataset_allowlist),
  };
}

function readHeartbeat(brain: BusinessBrain): {
  enabled: boolean;
  intervalMinutes: number;
  checklistMarkdown: string;
  checklistTemplateId: string;
} {
  const heartbeat = asRecord(brain.heartbeat);
  const intervalRaw = heartbeat.interval_minutes;
  const intervalMinutes =
    typeof intervalRaw === "number" && Number.isFinite(intervalRaw)
      ? Math.max(5, Math.min(24 * 60, Math.floor(intervalRaw)))
      : DEFAULT_HEARTBEAT_INTERVAL_MINUTES;
  const checklistMarkdown =
    readString(heartbeat.checklist_markdown) ||
    readString(heartbeat.checklist_md) ||
    DEFAULT_HEARTBEAT_CHECKLIST;
  return {
    enabled: heartbeat.enabled === true,
    intervalMinutes,
    checklistMarkdown,
    checklistTemplateId: readString(heartbeat.checklist_template_id),
  };
}

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function charCount(value: string, max: number) {
  return (
    <p className="mt-1 text-right text-xs text-neutral-400">
      {value.length}/{max}
    </p>
  );
}

function assetExt(file: File): string {
  const fromName = file.name.split(".").pop()?.toLowerCase();
  if (fromName && ["png", "jpg", "jpeg", "webp", "gif"].includes(fromName)) {
    return fromName;
  }
  if (file.type === "image/png") return "png";
  if (file.type === "image/webp") return "webp";
  if (file.type === "image/gif") return "gif";
  return "jpg";
}

function normalizeForCompare(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function formatRunDate(value?: string | null): string {
  if (!value) return "Sin fecha";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString("es-MX", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function readHeartbeatPayload(run: HeartbeatRun): Record<string, unknown> {
  if (typeof run.payload === "string") {
    try {
      const parsed = JSON.parse(run.payload);
      return asRecord(parsed);
    } catch {
      return {};
    }
  }
  return asRecord(run.payload);
}

function heartbeatRunSummary(run: HeartbeatRun): string {
  if (run.error) return run.error;
  const payload = readHeartbeatPayload(run);
  const response = readString(payload.response).trim();
  if (!response) return "Sin resumen guardado.";
  return response;
}

function heartbeatToolCalls(run: HeartbeatRun): string[] {
  const payload = readHeartbeatPayload(run);
  const toolCalls = payload.toolCalls;
  return Array.isArray(toolCalls)
    ? toolCalls.filter((item): item is string => typeof item === "string")
    : [];
}

function heartbeatAppliedSkills(run: HeartbeatRun): string[] {
  const payload = readHeartbeatPayload(run);
  const skills = payload.appliedHeartbeatSkills;
  return Array.isArray(skills)
    ? skills.filter((item): item is string => typeof item === "string")
    : [];
}

function heartbeatChecklistSelectionLabels(run: HeartbeatRun): string[] {
  const payload = readHeartbeatPayload(run);
  const selections = payload.heartbeatSkillSelection;
  if (!Array.isArray(selections)) return [];
  return selections
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const itemId = typeof record.itemId === "string" ? record.itemId : "item";
      const status = typeof record.status === "string" ? record.status : "unknown";
      const skillIds = Array.isArray(record.skillIds)
        ? record.skillIds.filter((v): v is string => typeof v === "string")
        : [];
      const blocked = Array.isArray(record.blockedSkillIds)
        ? record.blockedSkillIds.filter((v): v is string => typeof v === "string")
        : [];
      const suffix =
        skillIds.length > 0
          ? `skills: ${skillIds.join(", ")}`
          : blocked.length > 0
            ? `bloqueado: ${blocked.join(", ")}`
            : "sin skill";
      return `${itemId} · ${status} · ${suffix}`;
    })
    .filter((item): item is string => Boolean(item));
}

function heartbeatStatusLabel(status: HeartbeatRun["status"]): string {
  const labels: Record<HeartbeatRun["status"], string> = {
    running: "En curso",
    completed: "Completado",
    error: "Con error",
  };
  return labels[status];
}

function scheduledTaskTiming(task: ScheduledTaskItem): string {
  if (task.schedule_type === "recurring") {
    return task.cron_expr
      ? `Recurrente · ${task.cron_expr} · ${task.timezone}`
      : `Recurrente · ${task.timezone}`;
  }
  return task.run_at ? `Una vez · ${formatRunDate(task.run_at)}` : "Una vez";
}

function scheduledTaskNextRun(task: ScheduledTaskItem): string {
  if (task.status === "completed") return "Completada";
  if (task.status === "failed") return "Con error";
  if (task.next_run_at) {
    const next = new Date(task.next_run_at);
    if (!Number.isNaN(next.getTime()) && next.getTime() <= Date.now()) {
      return task.status === "active"
        ? `Pendiente desde: ${formatRunDate(task.next_run_at)}`
        : `Fecha pasada: ${formatRunDate(task.next_run_at)}`;
    }
    return `Próxima: ${formatRunDate(task.next_run_at)}`;
  }
  return task.status === "paused" ? "Pausada" : "Sin próxima corrida";
}

function isPastOneTimeTask(task: ScheduledTaskItem): boolean {
  if (task.schedule_type !== "one_time") return false;
  const scheduledAt = task.next_run_at ?? task.run_at;
  if (!scheduledAt) return true;
  const date = new Date(scheduledAt);
  return Number.isNaN(date.getTime()) || date.getTime() <= Date.now();
}

function canResumeScheduledTask(task: ScheduledTaskItem): boolean {
  if (task.status !== "paused") return false;
  return !isPastOneTimeTask(task);
}

function scheduledTaskDisplayText(task: ScheduledTaskItem): string {
  return task.display_title?.trim() || task.user_request?.trim() || task.prompt;
}

function scheduledTaskSkillLabel(task: ScheduledTaskItem): string | null {
  if (!task.skill_id) return null;
  return `Skill: ${task.skill_id.replace(/[-_]+/g, " ")}`;
}

export function SettingsForm({
  userId,
  profile,
  toolSettings,
  skillSettings,
  skillCatalog,
  telegramLinked,
  githubConnected,
  googleCalendarConnected,
  heartbeatRuns = [],
  scheduledTasks = [],
  heartbeatChecklistTemplates = [],
  googleOAuthStatus,
  googleOAuthReason,
}: Props) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [name, setName] = useState((profile?.name as string) ?? "");
  const [email, setEmail] = useState((profile?.email as string | null) ?? "");
  const [phone, setPhone] = useState((profile?.phone as string | null) ?? "");
  const browserTz = typeof window !== "undefined"
    ? Intl.DateTimeFormat().resolvedOptions().timeZone
    : "UTC";
  const profileTz = (profile?.timezone as string) || "";
  const [timezone, setTimezone] = useState(profileTz || browserTz);
  const profileAgentName = (profile?.agent_name as string | undefined) ?? "";
  const [agentName, setAgentName] = useState(
    profileAgentName.trim() && profileAgentName !== "Agente"
      ? profileAgentName
      : DEFAULT_AGENT_NAME
  );
  const [systemPrompt, setSystemPrompt] = useState(
    (profile?.agent_system_prompt as string) ?? ""
  );
  const [enabledTools, setEnabledTools] = useState<string[]>(
    toolSettings.filter((t) => t.enabled).map((t) => t.tool_id)
  );
  const [enabledSkills, setEnabledSkills] = useState<string[]>(() => {
    const settingsBySkill = new Map(
      skillSettings.map((s) => [s.skill_id, s.enabled])
    );
    return skillCatalog
      .filter((skill) => settingsBySkill.get(skill.name) !== false)
      .map((skill) => skill.name);
  });
  const [linkCode, setLinkCode] = useState<string | null>(null);
  const [ghConnected, setGhConnected] = useState(githubConnected);
  const [gCalConnected, setGCalConnected] = useState(googleCalendarConnected);
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectingGCal, setDisconnectingGCal] = useState(false);
  const [bookingBusy, setBookingBusy] = useState(false);
  const [bookingUrl, setBookingUrl] = useState<string | null>(null);
  const initialBrain = readBusinessBrain(profile);
  const initialWarehouse = readWarehouse(initialBrain);
  const initialHeartbeat = readHeartbeat(initialBrain);
  const [agentRole, setAgentRole] = useState(
    initialBrain.agent_identity?.role ?? DEFAULT_AGENT_ROLE
  );
  const [agentDescription, setAgentDescription] = useState(
    initialBrain.agent_identity?.short_description ?? DEFAULT_AGENT_DESCRIPTION
  );
  const [agentEmoji, setAgentEmoji] = useState(
    initialBrain.agent_identity?.emoji ?? ""
  );
  const [agentAvatarPath, setAgentAvatarPath] = useState(
    initialBrain.agent_identity?.avatar_path ?? ""
  );
  const [agentAvatarUrl, setAgentAvatarUrl] = useState(
    initialBrain.agent_identity?.avatar_url ?? ""
  );
  const [userAvatarPath, setUserAvatarPath] = useState(
    (profile?.avatar_path as string | null) ?? ""
  );
  const [userAvatarUrl, setUserAvatarUrl] = useState(
    (profile?.avatar_url as string | null) ?? ""
  );
  const [uploadingAgentAvatar, setUploadingAgentAvatar] = useState(false);
  const [uploadingUserAvatar, setUploadingUserAvatar] = useState(false);
  const [assetError, setAssetError] = useState<string | null>(null);
  const [soulVoice, setSoulVoice] = useState(initialBrain.soul?.voice ?? "");
  const [soulTone, setSoulTone] = useState(initialBrain.soul?.tone ?? "");
  const [soulStyle, setSoulStyle] = useState(initialBrain.soul?.style ?? "");
  const [soulBrevity, setSoulBrevity] = useState(
    initialBrain.soul?.brevity ?? ""
  );
  const [businessKind, setBusinessKind] = useState(
    initialBrain.business_context?.kind ?? ""
  );
  const [businessMarkets, setBusinessMarkets] = useState(
    (initialBrain.business_context?.markets ?? []).join(", ")
  );
  const [businessNotes, setBusinessNotes] = useState(
    initialBrain.business_context?.notes ?? ""
  );
  const [operatingPreferences, setOperatingPreferences] = useState(
    initialBrain.operating_preferences?.text ?? ""
  );
  const [warehouseOrgName, setWarehouseOrgName] = useState(
    initialWarehouse.org_name ?? ""
  );
  const [warehouseOrgId, setWarehouseOrgId] = useState(
    initialWarehouse.organization_id ?? ""
  );
  const [warehouseCountry, setWarehouseCountry] = useState(
    initialWarehouse.country ?? ""
  );
  const [warehouseProject, setWarehouseProject] = useState(
    initialWarehouse.project_id ?? ""
  );
  const [warehouseLocation, setWarehouseLocation] = useState(
    initialWarehouse.location ?? ""
  );
  const [warehouseDatasets, setWarehouseDatasets] = useState(
    (initialWarehouse.dataset_allowlist ?? []).join(", ")
  );
  const [heartbeatEnabled, setHeartbeatEnabled] = useState(
    initialHeartbeat.enabled
  );
  const [heartbeatIntervalMinutes, setHeartbeatIntervalMinutes] = useState(
    initialHeartbeat.intervalMinutes
  );
  const [heartbeatChecklist, setHeartbeatChecklist] = useState(
    initialHeartbeat.checklistMarkdown
  );
  const [activeHeartbeatChecklist, setActiveHeartbeatChecklist] = useState(
    initialHeartbeat.checklistMarkdown
  );
  const [activeHeartbeatTemplateId, setActiveHeartbeatTemplateId] = useState(
    initialHeartbeat.checklistTemplateId || "hybrid-founder-operator"
  );
  const [userHeartbeatTemplates, setUserHeartbeatTemplates] = useState(
    heartbeatChecklistTemplates
  );
  const [heartbeatTemplateId, setHeartbeatTemplateId] = useState(
    initialHeartbeat.checklistTemplateId || "hybrid-founder-operator"
  );
  const [heartbeatTemplateName, setHeartbeatTemplateName] = useState("");
  const [heartbeatTemplateMessage, setHeartbeatTemplateMessage] = useState<
    string | null
  >(null);
  const [savingHeartbeatTemplate, setSavingHeartbeatTemplate] = useState(false);
  const [deletingHeartbeatTemplate, setDeletingHeartbeatTemplate] = useState(false);
  const [activatingHeartbeatChecklist, setActivatingHeartbeatChecklist] =
    useState(false);
  const [heartbeatChecklistIntent, setHeartbeatChecklistIntent] = useState("");
  const [heartbeatChecklistProposal, setHeartbeatChecklistProposal] =
    useState<ReturnType<typeof generateHeartbeatChecklistProposal> | null>(null);
  const latestHeartbeatRun = heartbeatRuns[0];
  const [scheduledTaskRows, setScheduledTaskRows] = useState(scheduledTasks);
  const [updatingTaskId, setUpdatingTaskId] = useState<string | null>(null);
  const isUnggaAdmin = Boolean(profile?.is_ungga_admin);
  const [sectionReviews, setSectionReviews] = useState<
    Partial<Record<ReviewSection, SectionReviewState>>
  >({});
  const [approvingSection, setApprovingSection] = useState<ReviewSection | null>(
    null
  );
  const [correctedSections, setCorrectedSections] = useState<
    Partial<Record<ReviewSection, boolean>>
  >({});
  const [savedSectionFields, setSavedSectionFields] = useState<
    Record<ReviewSection, Partial<Record<ReviewSlot, string>>>
  >({
    identity: {
      "agent_identity.role": initialBrain.agent_identity?.role ?? DEFAULT_AGENT_ROLE,
      "agent_identity.short_description":
        initialBrain.agent_identity?.short_description ??
        DEFAULT_AGENT_DESCRIPTION,
    },
    soul: {
      "soul.voice": initialBrain.soul?.voice ?? "",
      "soul.tone": initialBrain.soul?.tone ?? "",
      "soul.style": initialBrain.soul?.style ?? "",
      "soul.brevity": initialBrain.soul?.brevity ?? "",
    },
    context: {
      "business_context.notes": initialBrain.business_context?.notes ?? "",
    },
    operating: {
      "operating_preferences.text":
        initialBrain.operating_preferences?.text ?? "",
    },
  });

  const supabase = useMemo(
    () =>
      createBrowserClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
      ),
    []
  );
  const heartbeatTemplateOptions: HeartbeatTemplateOption[] = [
    ...HEARTBEAT_CHECKLIST_TEMPLATES.map((template) => ({
      ...template,
      kind: "system" as const,
    })),
    ...userHeartbeatTemplates.map((template) => ({
      id: template.id,
      name: template.name,
      description: template.description,
      markdown: template.markdown,
      kind: "user" as const,
      sourceTemplateId: template.source_template_id ?? null,
    })),
  ];
  const defaultHeartbeatTemplate = heartbeatTemplateOptions.find(
    (template) => template.id === "hybrid-founder-operator"
  );
  const selectedHeartbeatTemplate =
    heartbeatTemplateOptions.find((template) => template.id === heartbeatTemplateId) ??
    defaultHeartbeatTemplate ??
    heartbeatTemplateOptions[0];
  const heartbeatChecklistChangedFromTemplate =
    !!selectedHeartbeatTemplate &&
    heartbeatChecklist.trim() !== selectedHeartbeatTemplate.markdown.trim();
  const heartbeatChecklistValidation = validateHeartbeatChecklist(heartbeatChecklist);
  const activeHeartbeatChecklistValidation =
    validateHeartbeatChecklist(activeHeartbeatChecklist);

  useEffect(() => {
    setGCalConnected(googleCalendarConnected);
  }, [googleCalendarConnected]);

  useEffect(() => {
    async function signExistingAssets() {
      const paths = [
        { path: agentAvatarPath, setUrl: setAgentAvatarUrl },
        { path: userAvatarPath, setUrl: setUserAvatarUrl },
      ];
      for (const item of paths) {
        if (!item.path || item.path.startsWith("http")) continue;
        const { data } = await supabase.storage
          .from(PROFILE_ASSETS_BUCKET)
          .createSignedUrl(item.path, 60 * 60);
        if (data?.signedUrl) item.setUrl(data.signedUrl);
      }
    }
    void signExistingAssets();
  }, [agentAvatarPath, userAvatarPath, supabase]);

  function toggleTool(id: string) {
    setEnabledTools((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]
    );
  }

  function toggleSkill(id: string) {
    setEnabledSkills((prev) =>
      prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]
    );
  }

  function applyHeartbeatTemplate(template: HeartbeatTemplateOption | undefined) {
    if (!template) return;
    setHeartbeatTemplateId(template.id);
    setHeartbeatChecklist(template.markdown);
    setHeartbeatTemplateName("");
    setHeartbeatTemplateMessage(null);
  }

  async function saveHeartbeatTemplate() {
    setSavingHeartbeatTemplate(true);
    setHeartbeatTemplateMessage(null);
    try {
      const validation = validateHeartbeatChecklist(heartbeatChecklist);
      if (validation.warnings.length > 0) {
        throw new Error("Primero valida y ajusta el checklist hasta que no tenga sugerencias.");
      }
      const res = await fetch("/api/heartbeat-checklist-templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: heartbeatTemplateName.trim(),
          description: selectedHeartbeatTemplate
            ? `Derivado de ${selectedHeartbeatTemplate.name}`
            : "",
          markdown: heartbeatChecklist.trim(),
          source_template_id: selectedHeartbeatTemplate?.id ?? null,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error ?? "No se pudo guardar el template");
      }
      const template = json.template as HeartbeatChecklistTemplateRow;
      setUserHeartbeatTemplates((prev) => [template, ...prev]);
      setHeartbeatTemplateId(template.id);
      setHeartbeatTemplateName("");
      setHeartbeatTemplateMessage(
        "Template guardado. Cuando quieras, úsalo como checklist para Heartbeat."
      );
      router.refresh();
    } catch (err) {
      setHeartbeatTemplateMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingHeartbeatTemplate(false);
    }
  }

  async function deleteSelectedHeartbeatTemplate() {
    if (!selectedHeartbeatTemplate || selectedHeartbeatTemplate.kind !== "user") return;
    setDeletingHeartbeatTemplate(true);
    setHeartbeatTemplateMessage(null);
    try {
      const res = await fetch(
        `/api/heartbeat-checklist-templates/${selectedHeartbeatTemplate.id}`,
        { method: "DELETE" }
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "No se pudo eliminar el template");
      setUserHeartbeatTemplates((prev) =>
        prev.filter((template) => template.id !== selectedHeartbeatTemplate.id)
      );
      const fallback =
        HEARTBEAT_CHECKLIST_TEMPLATES.find(
          (template) => template.id === "hybrid-founder-operator"
        ) ?? HEARTBEAT_CHECKLIST_TEMPLATES[0];
      if (fallback) applyHeartbeatTemplate({ ...fallback, kind: "system" });
      setHeartbeatTemplateMessage("Template eliminado.");
      router.refresh();
    } catch (err) {
      setHeartbeatTemplateMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingHeartbeatTemplate(false);
    }
  }

  async function useHeartbeatChecklistAsActive() {
    setActivatingHeartbeatChecklist(true);
    setHeartbeatTemplateMessage(null);
    try {
      const validation = validateHeartbeatChecklist(heartbeatChecklist);
      if (validation.items.length === 0 || validation.warnings.length > 0) {
        throw new Error(
          "Antes de usarlo como checklist, valida y ajusta hasta que no haya sugerencias."
        );
      }
      const normalizedHeartbeatInterval = Math.max(
        5,
        Math.min(24 * 60, Math.floor(heartbeatIntervalMinutes || 0))
      );
      const res = await fetch("/api/business-brain", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          patch: {
            heartbeat: {
              enabled: heartbeatEnabled,
              interval_minutes: normalizedHeartbeatInterval,
              checklist_markdown: heartbeatChecklist.trim(),
              checklist_template_id: heartbeatTemplateId,
              checklist_metadata: {
                validation_warnings: validation.warnings,
                detected_skills: [
                  ...new Set(
                    validation.items.flatMap((item) => item.candidateSkills)
                  ),
                ],
              },
            },
          },
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "No se pudo actualizar el checklist");
      setActiveHeartbeatChecklist(heartbeatChecklist.trim());
      setActiveHeartbeatTemplateId(heartbeatTemplateId);
      setSaved(true);
      setHeartbeatTemplateMessage(
        "Checklist actualizado. Usa el toggle de Heartbeat para activarlo o desactivarlo."
      );
      setTimeout(() => setSaved(false), 2000);
      router.refresh();
    } catch (err) {
      setHeartbeatTemplateMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setActivatingHeartbeatChecklist(false);
    }
  }

  async function reviewSection(
    section: ReviewSection,
    fields: Partial<Record<ReviewSlot, string>>
  ) {
    setSectionReviews((prev) => ({
      ...prev,
      [section]: { ...(prev[section] ?? {}), loading: true, error: undefined },
    }));
    try {
      const res = await fetch("/api/business-brain/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ section, fields }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "No se pudo revisar");
      setSectionReviews((prev) => ({
        ...prev,
        [section]: { loading: false, result: json.result as SectionReviewResult },
      }));
      setCorrectedSections((prev) => ({ ...prev, [section]: false }));
    } catch (err) {
      setSectionReviews((prev) => ({
        ...prev,
        [section]: {
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        },
      }));
    }
  }

  function applySectionCorrection(section: ReviewSection) {
    const fields = sectionReviews[section]?.result?.normalized_fields ?? {};
    if (fields["agent_identity.role"] !== undefined) {
      setAgentRole(fields["agent_identity.role"]);
    }
    if (fields["agent_identity.short_description"] !== undefined) {
      setAgentDescription(fields["agent_identity.short_description"]);
    }
    if (fields["soul.voice"] !== undefined) setSoulVoice(fields["soul.voice"]);
    if (fields["soul.tone"] !== undefined) setSoulTone(fields["soul.tone"]);
    if (fields["soul.style"] !== undefined) setSoulStyle(fields["soul.style"]);
    if (fields["soul.brevity"] !== undefined) {
      setSoulBrevity(fields["soul.brevity"]);
    }
    if (fields["business_context.notes"] !== undefined) {
      setBusinessNotes(fields["business_context.notes"]);
    }
    if (fields["operating_preferences.text"] !== undefined) {
      setOperatingPreferences(fields["operating_preferences.text"]);
    }
    setCorrectedSections((prev) => ({ ...prev, [section]: true }));
  }

  async function applySectionReview(section: ReviewSection) {
    setApprovingSection(section);
    setSaveError(null);
    try {
      await saveBusinessBrain();
      setSaved(true);
      setSavedSectionFields((prev) => ({
        ...prev,
        [section]: {
          ...currentSectionFields(section),
        },
      }));
      setCorrectedSections((prev) => ({ ...prev, [section]: false }));
      setTimeout(() => setSaved(false), 2000);
      router.refresh();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setApprovingSection(null);
    }
  }

  function currentSectionFields(
    section: ReviewSection
  ): Partial<Record<ReviewSlot, string>> {
    if (section === "identity") {
      return {
        "agent_identity.role": agentRole,
        "agent_identity.short_description": agentDescription,
      };
    }
    if (section === "soul") {
      return {
        "soul.voice": soulVoice,
        "soul.tone": soulTone,
        "soul.style": soulStyle,
        "soul.brevity": soulBrevity,
      };
    }
    if (section === "context") {
      return { "business_context.notes": businessNotes };
    }
    return { "operating_preferences.text": operatingPreferences };
  }

  async function uploadProfileAsset(kind: "agent" | "user", file: File) {
    setAssetError(null);
    if (!file.type.startsWith("image/")) {
      setAssetError("El archivo debe ser una imagen.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setAssetError("La imagen debe pesar máximo 5 MB.");
      return;
    }
    const setUploading =
      kind === "agent" ? setUploadingAgentAvatar : setUploadingUserAvatar;
    setUploading(true);
    try {
      const path = `${userId}/${kind}-avatar-${Date.now()}.${assetExt(file)}`;
      const { error } = await supabase.storage
        .from(PROFILE_ASSETS_BUCKET)
        .upload(path, file, { upsert: true, contentType: file.type });
      if (error) throw error;
      const { data } = await supabase.storage
        .from(PROFILE_ASSETS_BUCKET)
        .createSignedUrl(path, 60 * 60);
      const signedUrl = data?.signedUrl ?? "";
      if (kind === "agent") {
        setAgentAvatarPath(path);
        setAgentAvatarUrl(signedUrl);
        await fetch("/api/business-brain", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            patch: {
              agent_identity: {
                name: agentName.trim(),
                role: agentRole.trim(),
                emoji: agentEmoji.trim(),
                short_description: agentDescription.trim(),
                avatar_path: path,
                avatar_url: "",
              },
            },
          }),
        });
      } else {
        setUserAvatarPath(path);
        setUserAvatarUrl(signedUrl);
        const { error: profileError } = await supabase
          .from("profiles")
          .update({
            avatar_path: path,
            avatar_url: null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", userId);
        if (profileError) throw profileError;
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setAssetError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }

  function buildBusinessBrainPatch(
    overrides: Partial<{
      agentRole: string;
      agentDescription: string;
      soulVoice: string;
      soulTone: string;
      soulStyle: string;
      soulBrevity: string;
      businessNotes: string;
      operatingPreferences: string;
    }> = {}
  ): Partial<BusinessBrain> {
    const normalizedHeartbeatInterval = Math.max(
      5,
      Math.min(24 * 60, Math.floor(heartbeatIntervalMinutes || 0))
    );
    return {
      agent_identity: {
        name: agentName.trim(),
        role: (overrides.agentRole ?? agentRole).trim(),
        emoji: agentEmoji.trim(),
        avatar_path: agentAvatarPath.trim(),
        avatar_url: "",
        short_description: (
          overrides.agentDescription ?? agentDescription
        ).trim(),
      },
      soul: {
        voice: (overrides.soulVoice ?? soulVoice).trim(),
        tone: (overrides.soulTone ?? soulTone).trim(),
        style: (overrides.soulStyle ?? soulStyle).trim(),
        brevity: (overrides.soulBrevity ?? soulBrevity).trim(),
      },
      business_context: {
        kind: businessKind.trim(),
        markets: splitCsv(businessMarkets),
        notes: (overrides.businessNotes ?? businessNotes).trim(),
      },
      operating_preferences: {
        text: (
          overrides.operatingPreferences ?? operatingPreferences
        ).trim(),
      },
      data_sources: {
        warehouse: {
          provider: "bigquery",
          org_name: warehouseOrgName.trim(),
          organization_id: warehouseOrgId.trim(),
          country: warehouseCountry.trim(),
          project_id: warehouseProject.trim(),
          location: warehouseLocation.trim(),
          dataset_allowlist: splitCsv(warehouseDatasets),
        },
      },
      heartbeat: {
        enabled: heartbeatEnabled,
        interval_minutes: normalizedHeartbeatInterval,
        checklist_markdown: activeHeartbeatChecklist.trim(),
        checklist_template_id: activeHeartbeatTemplateId,
        checklist_metadata: {
          generated_from: heartbeatChecklistProposal
            ? heartbeatChecklistIntent.trim()
            : undefined,
          generated_at: heartbeatChecklistProposal
            ? new Date().toISOString()
            : undefined,
          validation_warnings: activeHeartbeatChecklistValidation.warnings,
          detected_skills: [
            ...new Set(
              activeHeartbeatChecklistValidation.items.flatMap(
                (item) => item.candidateSkills
              )
            ),
          ],
        },
      },
    };
  }

  async function saveBusinessBrain(
    overrides?: Partial<{
      agentRole: string;
      agentDescription: string;
      soulVoice: string;
      soulTone: string;
      soulStyle: string;
      soulBrevity: string;
      businessNotes: string;
      operatingPreferences: string;
    }>
  ) {
    const res = await fetch("/api/business-brain", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ patch: buildBusinessBrainPatch(overrides) }),
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      throw new Error(json.error ?? "No se pudo guardar Business Brain");
    }
  }

  async function updateScheduledTaskStatus(
    taskId: string,
    action: "pause" | "resume" | "cancel"
  ) {
    if (
      action === "cancel" &&
      !window.confirm("¿Cancelar esta tarea programada? Dejará de aparecer en tareas activas o pausadas.")
    ) {
      return;
    }
    setUpdatingTaskId(taskId);
    setSaveError(null);
    try {
      const res = await fetch(`/api/scheduled-tasks/${taskId}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error ?? "No se pudo actualizar la tarea");
      }
      const updated = json.task as ScheduledTaskItem;
      setScheduledTaskRows((rows) =>
        action === "cancel"
          ? rows.filter((task) => task.id !== taskId)
          : rows.map((task) => (task.id === taskId ? updated : task))
      );
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      router.refresh();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setUpdatingTaskId(null);
    }
  }

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    try {
      if (!agentName.trim() || !agentRole.trim() || !agentDescription.trim()) {
        throw new Error("Nombre, rol y descripción breve del colaborador IA son obligatorios.");
      }
      if (heartbeatEnabled && !activeHeartbeatChecklist.trim()) {
        throw new Error(
          "El checklist activo de Heartbeat no puede estar vacío cuando Heartbeat está habilitado."
        );
      }
      if (
        heartbeatEnabled &&
        activeHeartbeatChecklistValidation.items.length === 0
      ) {
        throw new Error(
          "El checklist activo de Heartbeat necesita al menos un item en formato bullet o numerado."
        );
      }
      if (
        heartbeatEnabled &&
        activeHeartbeatChecklistValidation.warnings.length > 0
      ) {
        throw new Error(
          "Antes de activar Heartbeat, el checklist guardado no debe tener sugerencias pendientes."
        );
      }
      if (
        !Number.isFinite(heartbeatIntervalMinutes) ||
        heartbeatIntervalMinutes < 5 ||
        heartbeatIntervalMinutes > 24 * 60
      ) {
        throw new Error(
          "El intervalo de Heartbeat debe estar entre 5 y 1440 minutos."
        );
      }

      await supabase.from("profiles").update({
        name,
        timezone,
        email: email.trim() === "" ? null : email.trim(),
        phone: phone.trim() === "" ? null : phone.trim(),
        avatar_path: userAvatarPath.trim() === "" ? null : userAvatarPath.trim(),
        avatar_url: null,
        agent_name: agentName,
        agent_system_prompt: systemPrompt.slice(0, 500),
        updated_at: new Date().toISOString(),
      }).eq("id", userId);

      await saveBusinessBrain();

      for (const toolId of TOOL_IDS) {
        await supabase.from("user_tool_settings").upsert(
          {
            user_id: userId,
            tool_id: toolId,
            enabled: enabledTools.includes(toolId),
            config_json: {},
          },
          { onConflict: "user_id,tool_id" }
        );
      }

      for (const skill of skillCatalog) {
        await supabase.from("user_skill_settings").upsert(
          {
            user_id: userId,
            skill_id: skill.name,
            enabled: enabledSkills.includes(skill.name),
            config_json:
              skillSettings.find((s) => s.skill_id === skill.name)
                ?.config_json ?? {},
          },
          { onConflict: "user_id,skill_id" }
        );
      }

      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      router.refresh();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function disconnectGoogleCalendar() {
    setDisconnectingGCal(true);
    try {
      await fetch("/api/integrations/google/disconnect", { method: "POST" });
      setGCalConnected(false);
      setBookingUrl(null);
      router.refresh();
    } finally {
      setDisconnectingGCal(false);
    }
  }

  async function createPublicBookingLink() {
    setBookingBusy(true);
    setBookingUrl(null);
    try {
      const res = await fetch("/api/calendar/booking-link", { method: "POST" });
      const json = await res.json();
      if (!res.ok) {
        console.error(json);
        return;
      }
      setBookingUrl(json.book_url as string);
    } finally {
      setBookingBusy(false);
    }
  }

  async function disconnectGitHub() {
    setDisconnecting(true);
    try {
      await fetch("/api/integrations/github/disconnect", { method: "POST" });
      setGhConnected(false);
      router.refresh();
    } finally {
      setDisconnecting(false);
    }
  }

  async function generateTelegramCode() {
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    await supabase.from("telegram_link_codes").insert({
      user_id: userId,
      code,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    });
    setLinkCode(code);
  }

  function sectionReviewControls(
    section: ReviewSection,
    label: string,
    fields: Partial<Record<ReviewSlot, string>>
  ) {
    const state = sectionReviews[section];
    const hasText = Object.values(fields).some((value) => value?.trim());
    const savedFields = savedSectionFields[section] ?? {};
    const hasChanges = Object.entries(fields).some(
      ([slot, value]) =>
        normalizeForCompare(value ?? "") !==
        normalizeForCompare(savedFields[slot as ReviewSlot] ?? "")
    );
    const canReview = hasText && hasChanges;
    const okNoSuggestions =
      state?.result?.severity === "ok" &&
      state.result.warnings.length === 0 &&
      state.result.moved_suggestions.length === 0 &&
      state.result.rejected_items.length === 0;
    const hasWarnings = Boolean(state?.result && !okNoSuggestions);
    const correctionApplied = correctedSections[section] === true;
    return (
      <div className="mt-2 space-y-2">
        <button
          type="button"
          onClick={() => reviewSection(section, fields)}
          disabled={state?.loading || !canReview}
          className={`rounded-md px-2.5 py-1 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50 ${
            canReview
              ? "border border-blue-600 bg-blue-600 text-white hover:bg-blue-700"
              : "border border-neutral-300 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          }`}
        >
          {state?.loading
            ? "Revisando..."
            : hasWarnings
              ? label.replace("Revisar", "Corregir")
              : label}
        </button>
        {!hasChanges && (
          <p className="text-xs text-neutral-400">
            Sin cambios desde la última versión guardada.
          </p>
        )}
        {state?.error && (
          <p className="text-xs text-red-600 dark:text-red-400">{state.error}</p>
        )}
        {state?.result && (
          <div className="rounded-md border border-neutral-200 bg-neutral-50 p-3 text-xs dark:border-neutral-800 dark:bg-neutral-950">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="font-medium">
                {okNoSuggestions
                  ? "Ok. No hay sugerencias."
                  : `Sugerencias (${state.result.severity})`}
              </span>
              {okNoSuggestions && hasChanges && (
                <button
                  type="button"
                  onClick={() => void applySectionReview(section)}
                  disabled={approvingSection === section}
                  className="rounded-md bg-neutral-900 px-2 py-1 font-medium text-white disabled:cursor-not-allowed disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
                >
                  {approvingSection === section
                    ? "Guardando..."
                    : "Guardar sección"}
                </button>
              )}
              {!okNoSuggestions && !correctionApplied && (
                <button
                  type="button"
                  onClick={() => applySectionCorrection(section)}
                  className="rounded-md bg-blue-600 px-2 py-1 font-medium text-white hover:bg-blue-700"
                >
                  {label.replace("Revisar", "Corregir")}
                </button>
              )}
              {!okNoSuggestions && correctionApplied && (
                <button
                  type="button"
                  onClick={() => void applySectionReview(section)}
                  disabled={
                    state.result.severity === "blocked" ||
                    approvingSection === section
                  }
                  className="rounded-md bg-neutral-900 px-2 py-1 font-medium text-white disabled:cursor-not-allowed disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
                >
                  {approvingSection === section
                    ? "Guardando..."
                    : "Aprobar y guardar sección"}
                </button>
              )}
            </div>
            {!okNoSuggestions && (
              <div className="space-y-2">
                {Object.entries(state.result.normalized_fields).map(([slot, value]) => (
                  <label key={slot} className="block">
                    <span className="mb-1 block text-[11px] text-neutral-500">
                      {REVIEW_SLOT_LABELS[slot as ReviewSlot] ?? slot}
                    </span>
                    <textarea
                      readOnly
                      value={value ?? ""}
                      rows={2}
                      className="w-full rounded-md border border-neutral-300 bg-white px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-900"
                    />
                  </label>
                ))}
              </div>
            )}
            {!okNoSuggestions && !correctionApplied && (
              <p className="mt-2 text-xs text-neutral-500">
                Primero aplica la corrección sugerida. Después podrás aprobar y guardar la sección.
              </p>
            )}
            {state.result.warnings.length > 0 && (
              <ul className="mt-2 list-disc space-y-1 pl-4 text-amber-700 dark:text-amber-300">
                {state.result.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            )}
            {state.result.moved_suggestions.length > 0 && (
              <div className="mt-2 text-neutral-500">
                Mover a otro campo:{" "}
                {[...new Set(
                  state.result.moved_suggestions.map(
                    (item) =>
                      REVIEW_TARGET_LABELS[item.target_slot] ?? item.target_slot
                  )
                )].join(", ")}
              </div>
            )}
            {state.result.rejected_items.length > 0 && (
              <ul className="mt-2 list-disc space-y-1 pl-4 text-red-700 dark:text-red-300">
                {state.result.rejected_items.map((item) => (
                  <li key={`${item.text}-${item.reason}`}>
                    {item.text}: {item.reason}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {googleOAuthStatus === "connected" && (
        <div className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800 dark:border-green-900 dark:bg-green-950/30 dark:text-green-200">
          Google Calendar se conectó correctamente. Si no ves el estado abajo, recarga la página (F5).
        </div>
      )}
      {googleOAuthStatus === "error" && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          No se pudo completar la conexión con Google
          {googleOAuthReason ? ` (${googleOAuthReason})` : ""}. Revisa{" "}
          <code className="text-xs">GOOGLE_CLIENT_*</code>,{" "}
          <code className="text-xs">NEXT_PUBLIC_SITE_URL</code> y el redirect en Google Cloud.
        </div>
      )}
      {/* Profile */}
      <section className="space-y-4">
        <h2 className="text-base font-semibold">Perfil de usuario</h2>
        <div>
          <label className="block text-sm font-medium mb-1">Foto / avatar</label>
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-full bg-neutral-200 text-sm font-semibold text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200">
              {userAvatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={userAvatarUrl} alt="Avatar del usuario" className="h-full w-full object-cover" />
              ) : (
                (name || email || "U").slice(0, 1).toUpperCase()
              )}
            </div>
            <label className="cursor-pointer rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900">
              {uploadingUserAvatar ? "Subiendo..." : "Subir imagen"}
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void uploadProfileAsset("user", file);
                  e.currentTarget.value = "";
                }}
              />
            </label>
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Nombre</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Email</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="tu@correo.com"
            className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
          <p className="text-xs text-neutral-400 mt-1">
            El agente lo conocerá sin preguntártelo. Útil para &quot;pásale mi email a X&quot;.
          </p>
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Teléfono</label>
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+52 55 1234 5678"
            className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
          <p className="text-xs text-neutral-400 mt-1">
            Igual que el email: canónico y disponible sin preguntar.
          </p>
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Zona horaria</label>
          <select
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          >
            {TIMEZONES.map((tz) => (
              <option key={tz} value={tz}>
                {tz.replace(/_/g, " ")}
              </option>
            ))}
            {!TIMEZONES.includes(timezone) && (
              <option value={timezone}>{timezone.replace(/_/g, " ")}</option>
            )}
          </select>
          <p className="text-xs text-neutral-400 mt-1">
            Afecta las horas que ves en eventos de calendario y la interpretación de períodos.
          </p>
        </div>
      </section>

      {/* Agent / Business Brain */}
      <section className="space-y-5">
        <div>
          <h2 className="text-base font-semibold">Perfil de IA</h2>
          <p className="mt-1 text-sm text-neutral-500">
            Define identidad, voz, contexto y preferencias. Las reglas de
            seguridad, aprobaciones humanas, herramientas habilitadas y
            separación de datos entre cuentas siempre tienen prioridad.
          </p>
        </div>
        <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <div className="grid gap-4 md:grid-cols-[auto_1fr]">
            <div>
              <label className="block text-sm font-medium mb-1">Avatar</label>
              <div className="flex items-center gap-3">
                <div className="flex h-14 w-14 items-center justify-center overflow-hidden rounded-full bg-blue-600 text-lg font-bold text-white">
                  {agentAvatarUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={agentAvatarUrl} alt="Avatar del colaborador IA" className="h-full w-full object-cover" />
                  ) : (
                    agentEmoji || agentName.slice(0, 1).toUpperCase() || "G"
                  )}
                </div>
                <label className="cursor-pointer rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900">
                  {uploadingAgentAvatar ? "Subiendo..." : "Subir imagen"}
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) void uploadProfileAsset("agent", file);
                      e.currentTarget.value = "";
                    }}
                  />
                </label>
              </div>
            </div>
            <div className="grid gap-4 md:grid-cols-[1fr_120px]">
              <div>
                <label className="block text-sm font-medium mb-1">
                  Nombre del colaborador IA <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={agentName}
                  onChange={(e) => setAgentName(e.target.value)}
                  placeholder="p. ej. Gu, Lobi, Vera"
                  required
                  maxLength={50}
                  className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Emoji</label>
                <input
                  type="text"
                  value={agentEmoji}
                  onChange={(e) => setAgentEmoji(e.target.value.slice(0, 8))}
                  placeholder="✨"
                  maxLength={8}
                  className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                />
              </div>
            </div>
          </div>
          {assetError && (
            <p className="mt-2 text-xs text-red-600 dark:text-red-400">{assetError}</p>
          )}
          <div className="mt-4 grid gap-4 md:grid-cols-2">
          <div>
            <label className="block text-sm font-medium mb-1">
              Rol <span className="text-red-500">*</span>
            </label>
            <textarea
              value={agentRole}
              onChange={(e) => setAgentRole(e.target.value.slice(0, 220))}
              placeholder={DEFAULT_AGENT_ROLE}
              rows={4}
              required
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
            {charCount(agentRole, 220)}
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">
              Descripción breve <span className="text-red-500">*</span>
            </label>
            <textarea
              value={agentDescription}
              onChange={(e) => setAgentDescription(e.target.value.slice(0, 400))}
              rows={4}
              placeholder={DEFAULT_AGENT_DESCRIPTION}
              required
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
            {charCount(agentDescription, 400)}
          </div>
          </div>
          {sectionReviewControls("identity", "Revisar identidad", {
            "agent_identity.role": agentRole,
            "agent_identity.short_description": agentDescription,
          })}
        </div>

        <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h3 className="text-sm font-semibold">Alma</h3>
          <p className="mt-1 text-xs text-neutral-500">
            Estos campos solo afectan estilo, tono y forma de respuesta.
          </p>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div>
              <label className="block text-sm font-medium mb-1">Voz</label>
              <textarea
                value={soulVoice}
                onChange={(e) => setSoulVoice(e.target.value.slice(0, 300))}
                placeholder="Directa, cálida, orientada a negocio"
                rows={3}
                className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
              />
              {charCount(soulVoice, 300)}
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Tono</label>
              <textarea
                value={soulTone}
                onChange={(e) => setSoulTone(e.target.value.slice(0, 300))}
                placeholder="Profesional, cercano, sin sonar corporativo"
                rows={3}
                className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
              />
              {charCount(soulTone, 300)}
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Estilo</label>
              <textarea
                value={soulStyle}
                onChange={(e) => setSoulStyle(e.target.value.slice(0, 300))}
                placeholder="Respuestas escaneables, bullets cuando ayuden"
                rows={3}
                className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
              />
              {charCount(soulStyle, 300)}
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Brevedad</label>
              <textarea
                value={soulBrevity}
                onChange={(e) => setSoulBrevity(e.target.value.slice(0, 220))}
                placeholder="Breve por defecto; profundidad cuando se pida"
                rows={3}
                className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
              />
              {charCount(soulBrevity, 220)}
            </div>
          </div>
          {sectionReviewControls("soul", "Revisar Alma", {
            "soul.voice": soulVoice,
            "soul.tone": soulTone,
            "soul.style": soulStyle,
            "soul.brevity": soulBrevity,
          })}
        </div>

        <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h3 className="text-sm font-semibold">Contexto del negocio</h3>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div>
              <label className="block text-sm font-medium mb-1">Tipo</label>
              <input
                type="text"
                value={businessKind}
                onChange={(e) => setBusinessKind(e.target.value)}
                placeholder="inmobiliaria, personal, mixto"
                className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Mercados</label>
              <input
                type="text"
                value={businessMarkets}
                onChange={(e) => setBusinessMarkets(e.target.value)}
                placeholder="MX-CDMX, MX-QRO"
                className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
              />
            </div>
          </div>
          <div className="mt-4">
            <label className="block text-sm font-medium mb-1">Notas de contexto</label>
            <textarea
              value={businessNotes}
              onChange={(e) => setBusinessNotes(e.target.value.slice(0, 800))}
              rows={4}
              placeholder="Cómo opera el negocio, prioridades comerciales, criterios estables."
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
            {charCount(businessNotes, 800)}
          </div>
          {sectionReviewControls("context", "Revisar contexto", {
            "business_context.notes": businessNotes,
          })}
        </div>

        <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h3 className="text-sm font-semibold">Preferencias operativas</h3>
          <p className="mt-1 text-xs text-neutral-500">
            Preferencias editables. No pueden desactivar aprobaciones humanas,
            permisos o reglas de separación de datos entre cuentas.
          </p>
          <textarea
            value={operatingPreferences}
            onChange={(e) => setOperatingPreferences(e.target.value.slice(0, 800))}
            rows={4}
            placeholder="p. ej. prioriza leads calientes y pregunta una sola aclaración cuando falte información."
            className="mt-3 w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
          {charCount(operatingPreferences, 800)}
          {sectionReviewControls("operating", "Revisar preferencias", {
            "operating_preferences.text": operatingPreferences,
          })}
        </div>

        <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h3 className="text-sm font-semibold">Fuente de datos principal</h3>
          <p className="mt-1 text-xs text-neutral-500">
            Binding de esta cuenta hacia el warehouse. La tool y la skill siguen
            viviendo en sus registries.
          </p>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div>
              <label className="block text-sm font-medium mb-1">Inmobiliaria</label>
              <input
                type="text"
                value={warehouseOrgName}
                onChange={(e) => setWarehouseOrgName(e.target.value)}
                placeholder="Inmobiliaria Garios"
                className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">organization_id</label>
              <input
                type="text"
                value={warehouseOrgId}
                onChange={(e) => setWarehouseOrgId(e.target.value)}
                placeholder="id real en BigQuery"
                className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
              />
              <p className="mt-1 text-xs text-neutral-400">
                Requerido para métricas, BigQuery y skills de datos de negocio.
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">País</label>
              <input
                type="text"
                value={warehouseCountry}
                onChange={(e) => setWarehouseCountry(e.target.value.toUpperCase())}
                placeholder="MX"
                className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
              />
            </div>
          </div>
          <details className="mt-4 rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
            <summary className="cursor-pointer text-sm font-medium">
              Configuración avanzada de datos{isUnggaAdmin ? " (admin)" : ""}
            </summary>
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <div>
                <label className="block text-sm font-medium mb-1">BigQuery project</label>
                <input
                  type="text"
                  value={warehouseProject}
                  onChange={(e) => setWarehouseProject(e.target.value)}
                  placeholder="ungga-full"
                  className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Location</label>
                <input
                  type="text"
                  value={warehouseLocation}
                  onChange={(e) => setWarehouseLocation(e.target.value)}
                  placeholder="US"
                  className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                />
              </div>
              <div className="md:col-span-2">
                <label className="block text-sm font-medium mb-1">Dataset allowlist</label>
                <input
                  type="text"
                  value={warehouseDatasets}
                  onChange={(e) => setWarehouseDatasets(e.target.value)}
                  placeholder="firestore_users, mongo_data"
                  className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                />
              </div>
            </div>
          </details>
        </div>

        <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h3 className="text-sm font-semibold">Heartbeat proactivo</h3>
          <p className="mt-1 text-xs text-neutral-500">
            Configura la rutina periódica de Gu cuando no hay un mensaje manual.
            En esta etapa se ejecuta en modo seguro (solo lectura).
          </p>
          <div className="mt-4 rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs dark:border-neutral-800 dark:bg-neutral-950">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-medium text-neutral-800 dark:text-neutral-100">
                  Última corrida
                </p>
                <p className="text-neutral-500">
                  {latestHeartbeatRun
                    ? `${formatRunDate(latestHeartbeatRun.started_at)} · ${heartbeatStatusLabel(latestHeartbeatRun.status)}`
                    : "Aún no hay corridas registradas."}
                </p>
              </div>
              {latestHeartbeatRun ? (
                <span
                  className={`rounded-full px-2 py-1 text-[11px] font-medium ${
                    latestHeartbeatRun.status === "completed"
                      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                      : latestHeartbeatRun.status === "error"
                      ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300"
                      : "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
                  }`}
                >
                  {heartbeatStatusLabel(latestHeartbeatRun.status)}
                </span>
              ) : null}
            </div>
            {latestHeartbeatRun ? (
              <p className="mt-2 max-h-72 overflow-y-auto whitespace-pre-line pr-2 text-neutral-600 dark:text-neutral-300">
                {heartbeatRunSummary(latestHeartbeatRun)}
              </p>
            ) : null}
          </div>
          <div className="mt-4 flex items-center justify-between gap-3 rounded-md border border-neutral-200 px-3 py-2 dark:border-neutral-800">
            <div>
              <p className="text-sm font-medium">Habilitar Heartbeat</p>
              <p className="text-xs text-neutral-500">
                Activa corridas periódicas usando este checklist.
              </p>
            </div>
            <label className="inline-flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={heartbeatEnabled}
                onChange={(e) => setHeartbeatEnabled(e.target.checked)}
                className="rounded border-neutral-300"
              />
              {heartbeatEnabled ? "Activo" : "Inactivo"}
            </label>
          </div>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div>
              <label className="block text-sm font-medium mb-1">
                Intervalo (minutos)
              </label>
              <input
                type="number"
                min={5}
                max={1440}
                step={1}
                value={heartbeatIntervalMinutes}
                onChange={(e) =>
                  setHeartbeatIntervalMinutes(Math.floor(Number(e.target.value) || 0))
                }
                className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
              />
              <p className="mt-1 text-xs text-neutral-400">
                Rango recomendado para V1: 5 a 1440 minutos.
              </p>
            </div>
            <div className="flex flex-wrap items-end justify-start gap-2 md:justify-end">
              {heartbeatChecklistChangedFromTemplate ? (
                <>
                  <button
                    type="button"
                    onClick={() =>
                      setHeartbeatChecklist(
                        normalizeHeartbeatChecklist(heartbeatChecklist)
                      )
                    }
                    className="rounded-md border border-emerald-300 px-3 py-2 text-sm font-medium text-emerald-700 hover:bg-emerald-50 dark:border-emerald-900 dark:text-emerald-300 dark:hover:bg-emerald-950"
                  >
                    Validar y ajustar
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      selectedHeartbeatTemplate &&
                      setHeartbeatChecklist(selectedHeartbeatTemplate.markdown)
                    }
                    className="rounded-md border border-neutral-300 px-3 py-2 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
                  >
                    {selectedHeartbeatTemplate?.kind === "user"
                      ? "Restaurar último guardado"
                      : "Restaurar template original"}
                  </button>
                </>
              ) : null}
            </div>
          </div>
          <div className="mt-4 rounded-md border border-violet-100 bg-violet-50 p-3 text-xs dark:border-violet-900 dark:bg-violet-950/40">
            <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-start">
              <div className="min-w-0 flex-1">
                <label className="block text-sm font-medium mb-1">
                  Templates de checklist
                </label>
                <select
                  value={heartbeatTemplateId}
                  onChange={(e) => {
                    const template = heartbeatTemplateOptions.find(
                      (item) => item.id === e.target.value
                    );
                    applyHeartbeatTemplate(template);
                  }}
                  className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                >
                  {heartbeatTemplateOptions.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.kind === "user" ? "Usuario · " : "Sistema · "}
                      {template.name}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-neutral-500 dark:text-neutral-400">
                  {selectedHeartbeatTemplate?.description}
                </p>
              </div>
              <button
                type="button"
                onClick={useHeartbeatChecklistAsActive}
                disabled={
                  activatingHeartbeatChecklist ||
                  heartbeatChecklistValidation.items.length === 0 ||
                  heartbeatChecklistValidation.warnings.length > 0
                }
                className="rounded-md border border-violet-300 px-3 py-2 text-sm font-medium text-violet-800 hover:bg-violet-100 md:mt-6 dark:border-violet-700 dark:text-violet-100 dark:hover:bg-violet-900"
              >
                {activatingHeartbeatChecklist
                  ? "Actualizando..."
                  : "Usar como checklist"}
              </button>
            </div>
            <div className="mt-3 flex flex-wrap items-end gap-2">
              <div className="min-w-48 flex-1">
                <label className="block text-xs font-medium text-neutral-600 dark:text-neutral-300">
                  Nombre para guardar cambios
                </label>
                <input
                  value={heartbeatTemplateName}
                  onChange={(e) => setHeartbeatTemplateName(e.target.value.slice(0, 120))}
                  placeholder="Mi checklist operativo"
                  className="mt-1 w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                />
              </div>
              <button
                type="button"
                onClick={saveHeartbeatTemplate}
                disabled={
                  savingHeartbeatTemplate ||
                  !heartbeatChecklistChangedFromTemplate ||
                  !heartbeatTemplateName.trim() ||
                  heartbeatChecklistValidation.warnings.length > 0
                }
                className="rounded-md border border-emerald-300 px-3 py-2 text-sm font-medium text-emerald-700 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-emerald-900 dark:text-emerald-300 dark:hover:bg-emerald-950"
              >
                {savingHeartbeatTemplate
                  ? "Guardando..."
                  : "Guardar como nuevo template"}
              </button>
              {selectedHeartbeatTemplate?.kind === "user" ? (
                <button
                  type="button"
                  onClick={deleteSelectedHeartbeatTemplate}
                  disabled={deletingHeartbeatTemplate}
                  className="rounded-md border border-red-300 px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950"
                >
                  {deletingHeartbeatTemplate ? "Eliminando..." : "Eliminar template"}
                </button>
              ) : null}
            </div>
            {heartbeatTemplateMessage ? (
              <p className="mt-2 text-neutral-600 dark:text-neutral-300">
                {heartbeatTemplateMessage}
              </p>
            ) : null}
          </div>
          <div className="mt-4 rounded-md border border-neutral-200 p-3 text-xs dark:border-neutral-800">
            <label className="block text-sm font-medium mb-1">
              Generar propuesta desde lenguaje natural
            </label>
            <textarea
              value={heartbeatChecklistIntent}
              onChange={(e) => setHeartbeatChecklistIntent(e.target.value.slice(0, 1000))}
              rows={3}
              placeholder="Describe qué quieres que Gu vigile de forma proactiva. Ej. agenda personal + leads calientes + visitas por confirmar."
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() =>
                  setHeartbeatChecklistProposal(
                    generateHeartbeatChecklistProposal(heartbeatChecklistIntent)
                  )
                }
                disabled={!heartbeatChecklistIntent.trim()}
                className="rounded-md border border-neutral-300 px-3 py-2 text-sm font-medium hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-neutral-700 dark:hover:bg-neutral-900"
              >
                Generar propuesta
              </button>
              {heartbeatChecklistProposal ? (
                <button
                  type="button"
                  onClick={() =>
                    setHeartbeatChecklist(heartbeatChecklistProposal.markdown)
                  }
                  className="rounded-md border border-emerald-300 px-3 py-2 text-sm font-medium text-emerald-700 hover:bg-emerald-50 dark:border-emerald-900 dark:text-emerald-300 dark:hover:bg-emerald-950"
                >
                  Copiar propuesta al checklist
                </button>
              ) : null}
            </div>
            {heartbeatChecklistProposal ? (
              <div className="mt-3 rounded-md bg-neutral-50 p-3 dark:bg-neutral-950">
                <p className="font-medium">Propuesta validada (no se activa hasta guardar):</p>
                <pre className="mt-2 max-h-56 overflow-y-auto whitespace-pre-wrap font-mono text-[11px] text-neutral-600 dark:text-neutral-300">
                  {heartbeatChecklistProposal.markdown}
                </pre>
                <p className="mt-2 text-neutral-500">
                  Skills detectados/gaps a revisar:{" "}
                  {heartbeatChecklistProposal.missingSkills.join(", ") || "ninguno"}
                </p>
              </div>
            ) : null}
          </div>
          <div className="mt-4">
            <label className="block text-sm font-medium mb-1">
              Checklist markdown
            </label>
            <textarea
              value={heartbeatChecklist}
              onChange={(e) => {
                setHeartbeatChecklist(e.target.value.slice(0, 6000));
                setHeartbeatTemplateMessage(null);
              }}
              rows={8}
              placeholder={DEFAULT_HEARTBEAT_CHECKLIST}
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm font-mono dark:border-neutral-700 dark:bg-neutral-900"
            />
            <p className="mt-1 text-xs text-neutral-400">
              Este markdown es un borrador. No reemplaza el checklist hasta pulsar «Usar como checklist»;
              el guardado general conserva el checklist vigente en tu perfil.
            </p>
            {heartbeatChecklistValidation.warnings.length > 0 ? (
              <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
                <p className="font-medium">Sugerencias de mejores prácticas:</p>
                <ul className="mt-1 list-disc space-y-1 pl-4">
                  {heartbeatChecklistValidation.warnings.slice(0, 5).map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="mt-2 text-xs text-emerald-600 dark:text-emerald-300">
                No hay sugerencias. Checklist con {heartbeatChecklistValidation.items.length} item(s) operativos detectados.
                {heartbeatChecklistChangedFromTemplate
                  ? " Ya puedes guardarlo como nuevo template o aplicarlo con «Usar como checklist»."
                  : ""}
              </p>
            )}
            {charCount(heartbeatChecklist, 6000)}
          </div>
          {heartbeatRuns.length > 0 ? (
            <details className="mt-4 rounded-md border border-neutral-200 px-3 py-2 dark:border-neutral-800">
              <summary className="cursor-pointer text-sm font-medium">
                Historial reciente de Heartbeat
              </summary>
              <div className="mt-3 space-y-3">
                {heartbeatRuns.map((run) => {
                  const tools = heartbeatToolCalls(run);
                  const heartbeatSkills = heartbeatAppliedSkills(run);
                  const checklistSelections = heartbeatChecklistSelectionLabels(run);
                  return (
                    <div
                      key={run.id}
                      className="rounded-md border border-neutral-200 p-3 text-xs dark:border-neutral-800"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-medium">
                          {formatRunDate(run.started_at)}
                        </span>
                        <span
                          className={`rounded-full px-2 py-0.5 text-[11px] ${
                            run.status === "completed"
                              ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                              : run.status === "error"
                              ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300"
                              : "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
                          }`}
                        >
                          {heartbeatStatusLabel(run.status)}
                        </span>
                      </div>
                      <p className="mt-2 max-h-48 overflow-y-auto whitespace-pre-line pr-2 text-neutral-600 dark:text-neutral-300">
                        {heartbeatRunSummary(run)}
                      </p>
                      {tools.length > 0 ? (
                        <p className="mt-2 text-neutral-400">
                          Tools: {tools.join(", ")}
                        </p>
                      ) : null}
                      {heartbeatSkills.length > 0 ? (
                        <p className="mt-2 text-neutral-400">
                          Skills Heartbeat: {heartbeatSkills.join(", ")}
                        </p>
                      ) : null}
                      {checklistSelections.length > 0 ? (
                        <details className="mt-2 rounded-md bg-neutral-50 px-2 py-1 dark:bg-neutral-950">
                          <summary className="cursor-pointer text-neutral-500">
                            Items evaluados ({checklistSelections.length})
                          </summary>
                          <ul className="mt-1 list-disc space-y-1 pl-4 text-neutral-500">
                            {checklistSelections.map((selection) => (
                              <li key={selection}>{selection}</li>
                            ))}
                          </ul>
                        </details>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </details>
          ) : null}
        </div>

        <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">Tareas programadas</h3>
              <p className="mt-1 text-xs text-neutral-500">
                Automatizaciones que tú pediste a Gu. Se ejecutan por cron y son
                distintas del Heartbeat proactivo.
              </p>
            </div>
            <span className="rounded-full bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-700 dark:bg-neutral-900 dark:text-neutral-300">
              {scheduledTaskRows.filter((task) => task.status === "active").length} activas
            </span>
          </div>

          <div className="mt-4 space-y-3">
            {scheduledTaskRows.length === 0 ? (
              <div className="rounded-md border border-dashed border-neutral-200 px-3 py-4 text-center text-xs text-neutral-500 dark:border-neutral-800">
                No hay tareas programadas activas o pausadas. Puedes pedirle a Gu
                en chat que programe una tarea.
              </div>
            ) : (
              scheduledTaskRows.map((task) => (
                <div
                  key={task.id}
                  className="rounded-md border border-neutral-200 p-3 text-sm dark:border-neutral-800"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                            task.status === "active"
                              ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                              : "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
                          }`}
                        >
                          {task.status === "active" ? "Activa" : "Pausada"}
                        </span>
                        <span className="text-xs text-neutral-400">
                          {scheduledTaskTiming(task)}
                        </span>
                      </div>
                      <p className="mt-2 line-clamp-2 font-medium text-neutral-800 dark:text-neutral-100">
                        {scheduledTaskDisplayText(task)}
                      </p>
                      {scheduledTaskSkillLabel(task) ? (
                        <p className="mt-1 text-xs text-neutral-500">
                          {scheduledTaskSkillLabel(task)}
                        </p>
                      ) : null}
                      {scheduledTaskDisplayText(task) !== task.prompt ? (
                        <p className="mt-1 line-clamp-2 text-xs text-neutral-400">
                          Instrucción programada: {task.prompt}
                        </p>
                      ) : null}
                      <p className="mt-1 text-xs text-neutral-500">
                        {scheduledTaskNextRun(task)}
                        {typeof task.consecutive_failures === "number" &&
                        task.consecutive_failures > 0
                          ? ` · ${task.consecutive_failures} fallo(s) consecutivo(s)`
                          : ""}
                      </p>
                      {task.last_failure_error ? (
                        <p className="mt-2 rounded-md bg-red-50 px-2 py-1 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">
                          Último error: {task.last_failure_error}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={
                          updatingTaskId === task.id ||
                          (task.status === "paused" && !canResumeScheduledTask(task))
                        }
                        onClick={() =>
                          updateScheduledTaskStatus(
                            task.id,
                            task.status === "active" ? "pause" : "resume"
                          )
                        }
                        className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-neutral-700 dark:hover:bg-neutral-900"
                      >
                        {updatingTaskId === task.id
                          ? "Actualizando..."
                          : task.status === "active"
                          ? "Pausar"
                          : canResumeScheduledTask(task)
                          ? "Reanudar"
                          : "Fecha pasada"}
                      </button>
                      <button
                        type="button"
                        disabled={updatingTaskId === task.id}
                        onClick={() => updateScheduledTaskStatus(task.id, "cancel")}
                        className="rounded-md border border-red-200 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950"
                      >
                        Cancelar tarea
                      </button>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <details className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <summary className="cursor-pointer text-sm font-semibold">
            Instrucciones legacy
          </summary>
          <p className="mt-2 text-xs text-neutral-500">
            Fallback temporal mientras el Perfil de IA se estabiliza.
          </p>
          <textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value.slice(0, 500))}
            rows={4}
            maxLength={500}
            className="mt-3 w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
          <p className="text-xs text-neutral-400 text-right mt-1">{systemPrompt.length}/500</p>
        </details>
      </section>

      {/* Tools */}
      <section className="space-y-4">
        <div>
          <h2 className="text-base font-semibold">Herramientas</h2>
          <p className="mt-1 text-sm text-neutral-500">
            El color indica el nivel de riesgo operativo declarado para cada tool.
            Las reglas del producto (confirmaciones, permisos, integraciones) siguen aplicándose siempre.
          </p>
        </div>
        <div
          className="flex flex-wrap gap-2 rounded-md border border-neutral-200 bg-neutral-50/80 px-3 py-2 text-xs dark:border-neutral-800 dark:bg-neutral-950/40"
          aria-label="Leyenda de riesgo de herramientas"
        >
          {(["low", "medium", "high"] as const).map((risk) => (
            <span
              key={risk}
              className={`inline-flex items-center gap-2 rounded-md border px-2 py-1 ${toolRiskRowClasses(risk)}`}
            >
              <span
                className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${toolRiskBadgeClasses(risk)}`}
              >
                {TOOL_RISK_META[risk].label}
              </span>
              <span className="text-neutral-600 dark:text-neutral-400">
                {TOOL_RISK_META[risk].hint}
              </span>
            </span>
          ))}
        </div>
        <div className="space-y-2">
          {TOOL_IDS.map((id) => {
            const def = TOOL_DEF_BY_ID.get(id);
            const risk = toolRiskForSettings(id);
            return (
              <label
                key={id}
                className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm transition-colors hover:opacity-95 ${toolRiskRowClasses(risk)}`}
              >
                <input
                  type="checkbox"
                  checked={enabledTools.includes(id)}
                  onChange={() => toggleTool(id)}
                  className="mt-1 rounded border-neutral-300"
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${toolRiskBadgeClasses(risk)}`}
                    >
                      {TOOL_RISK_META[risk].label}
                    </span>
                    <code className="text-[13px] font-medium text-neutral-900 dark:text-neutral-100">
                      {id}
                    </code>
                  </span>
                  {def?.description ? (
                    <p className="mt-1 text-xs leading-snug text-neutral-600 dark:text-neutral-400">
                      {def.description}
                    </p>
                  ) : null}
                </span>
              </label>
            );
          })}
        </div>
      </section>

      {/* Skills */}
      <section className="space-y-4">
        <div>
          <h2 className="text-base font-semibold">Skills</h2>
          <p className="mt-1 text-sm text-neutral-500">
            Playbooks que el agente puede activar según la intención del turno.
            Si desactivas uno, no será candidato para el selector.
          </p>
        </div>
        {skillCatalog.length === 0 ? (
          <p className="rounded-md border border-neutral-200 px-3 py-2 text-sm text-neutral-500 dark:border-neutral-800">
            No se encontró ningún skill global en el registry.
          </p>
        ) : (
          <div className="space-y-5">
            {SKILL_SCOPE_ORDER.map((scope) => {
              const skills = skillCatalog.filter((s) => s.scope === scope);
              if (skills.length === 0) return null;
              return (
                <div key={scope} className="space-y-2">
                  <h3 className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                    {SKILL_SCOPE_LABELS[scope]}
                  </h3>
                  <div className="space-y-2">
                    {skills.map((skill) => (
                      <label
                        key={skill.name}
                        className="block rounded-md border border-neutral-200 p-3 text-sm dark:border-neutral-800"
                      >
                        <div className="flex items-start gap-3">
                          <input
                            type="checkbox"
                            checked={enabledSkills.includes(skill.name)}
                            onChange={() => toggleSkill(skill.name)}
                            className="mt-1 rounded border-neutral-300"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-medium">{skill.name}</span>
                              {skill.requiresTenantContext && (
                                <span className="rounded bg-blue-50 px-1.5 py-0.5 text-[11px] text-blue-700 dark:bg-blue-950 dark:text-blue-300">
                                  tenant
                                </span>
                              )}
                            </div>
                            <p className="mt-1 text-xs text-neutral-500">
                              {skill.description}
                            </p>
                            {skill.allowedTools.length > 0 && (
                              <p className="mt-2 text-[11px] text-neutral-400">
                                Tools: {skill.allowedTools.join(", ")}
                              </p>
                            )}
                          </div>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Google Calendar */}
      <section className="space-y-4">
        <h2 className="text-base font-semibold">Google Calendar</h2>
        {gCalConnected ? (
          <div className="space-y-3">
            <p className="text-sm text-green-600">Calendario de Google conectado.</p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void createPublicBookingLink()}
                disabled={bookingBusy}
                className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
              >
                {bookingBusy ? "Generando…" : "Generar enlace de reserva pública"}
              </button>
              <button
                type="button"
                onClick={() => void disconnectGoogleCalendar()}
                disabled={disconnectingGCal}
                className="rounded-md border border-red-300 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950"
              >
                {disconnectingGCal ? "Desconectando…" : "Desconectar Google"}
              </button>
            </div>
            {bookingUrl && (
              <p className="text-xs text-neutral-600 break-all">
                Enlace (comparte por tu canal seguro):{" "}
                <a href={bookingUrl} className="text-blue-600 underline" target="_blank" rel="noreferrer">
                  {bookingUrl}
                </a>
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-neutral-500">
              Conecta Google Calendar para que el agente consulte eventos y cree citas (con tu confirmación).
              La reserva para terceros usa este calendario vía la app; el invitado no inicia sesión en Google.
            </p>
            <a
              href="/api/integrations/google/authorize"
              className="inline-block rounded-md bg-neutral-800 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-200 dark:text-neutral-900 dark:hover:bg-neutral-300"
            >
              Conectar Google Calendar
            </a>
          </div>
        )}
      </section>

      {/* GitHub */}
      <section className="space-y-4">
        <h2 className="text-base font-semibold">GitHub</h2>
        {ghConnected ? (
          <div className="space-y-2">
            <p className="text-sm text-green-600">Cuenta de GitHub conectada.</p>
            <button
              onClick={disconnectGitHub}
              disabled={disconnecting}
              className="rounded-md border border-red-300 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950"
            >
              {disconnecting ? "Desconectando..." : "Desconectar GitHub"}
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-neutral-500">
              Conecta tu cuenta de GitHub para que el agente pueda trabajar con tus repositorios e issues.
            </p>
            <a
              href="/api/integrations/github/authorize"
              className="inline-block rounded-md bg-neutral-800 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-200 dark:text-neutral-900 dark:hover:bg-neutral-300"
            >
              Conectar con GitHub
            </a>
          </div>
        )}
      </section>

      {/* Telegram */}
      <section className="space-y-4">
        <h2 className="text-base font-semibold">Telegram</h2>
        {telegramLinked ? (
          <p className="text-sm text-green-600">Cuenta de Telegram vinculada.</p>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-neutral-500">
              Vincula tu cuenta de Telegram para usar el agente desde allí.
            </p>
            {linkCode ? (
              <div className="rounded-md bg-neutral-50 p-4 dark:bg-neutral-900">
                <p className="text-sm">
                  Envía este código al bot en Telegram:{" "}
                  <code className="rounded bg-blue-100 px-2 py-0.5 text-sm font-mono font-bold text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
                    /link {linkCode}
                  </code>
                </p>
                <p className="text-xs text-neutral-400 mt-1">Expira en 10 minutos.</p>
              </div>
            ) : (
              <button
                onClick={generateTelegramCode}
                className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
              >
                Generar código de vinculación
              </button>
            )}
          </div>
        )}
      </section>

      {/* Save */}
      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={saving}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {saving ? "Guardando..." : "Guardar cambios"}
        </button>
        {saved && (
          <span className="text-sm text-green-600">Guardado correctamente.</span>
        )}
        {saveError && (
          <span className="text-sm text-red-600 dark:text-red-400">
            {saveError}
          </span>
        )}
      </div>
    </div>
  );
}
