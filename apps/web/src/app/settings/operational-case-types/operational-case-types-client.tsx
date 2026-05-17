"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AccountSkill,
  OperationalCase,
  OperationalCaseEvent,
  OperationalCaseIntakeField,
  OperationalCaseReminderPolicy,
  OperationalCaseType,
  OperationalCaseTypeStatus,
  OperationalCaseTypeVisibility,
  ToolCall,
} from "@agents/types";
import { AccountToolConnectionForm } from "@/components/account-tool-connection-form";

const DEFAULT_INTAKE_SCHEMA: OperationalCaseIntakeField[] = [
  {
    name: "title",
    label: "Título",
    type: "text",
    required: true,
    placeholder: "Ej. Seguimiento de lead Mariana",
  },
  {
    name: "notes",
    label: "Notas iniciales",
    type: "textarea",
    required: false,
    placeholder: "Contexto que el agente debe considerar",
  },
];

type EditingCaseType = {
  case_type: string;
  display_name: string;
  default_skill_slug: string;
  description: string;
  status: OperationalCaseTypeStatus;
  visibility: Exclude<OperationalCaseTypeVisibility, "global">;
  intake_schema_jsonb: OperationalCaseIntakeField[];
  default_reminder_policy_jsonb: OperationalCaseReminderPolicy;
  isNew: boolean;
};

type SkillSummary = {
  slug: string;
  description: string;
  scope: string;
  allowedTools: string[];
  includes: string[];
  kind: string;
};

type SkillAuthoringResult = {
  skillDraft: string;
  validationRubric: Array<{
    item?: string;
    status?: "PASS" | "WARN" | "FAIL" | "N/A" | string;
    note?: string;
  }>;
  suggestedEvals: Record<string, unknown>;
  activationRecommendation: string;
  attemptsUsed?: number;
  elapsedMs?: number;
  metadataTruncated?: boolean;
};

type AuthoringProgressEvent = {
  type: "stage" | "error";
  stage?: string;
  message?: string;
  attempt?: number;
  error?: string;
  details?: string;
  ts?: number;
};

type ToolReadinessStatus =
  | "ready"
  | "needs_config"
  | "stub"
  | "missing"
  | "unknown";
type ToolReadinessCategory =
  | "product_integration"
  | "account_config"
  | "tenant_asset"
  | "technical_stub"
  | "skill_definition"
  | "ready";
type ToolReadinessActionKind =
  | "connect_integration"
  | "configure_account"
  | "request_global"
  | "edit_skill"
  | "none";

type ToolReadinessRequestKind =
  | "incorporate_to_catalog"
  | "enable_account_config"
  | "provide_tenant_asset";

type ToolAccountSecretStatus =
  | "pending_test"
  | "active"
  | "invalid"
  | "disconnected";

type ToolReadinessToolItem = {
  tool_id: string;
  status: ToolReadinessStatus;
  category: ToolReadinessCategory;
  blocking: boolean;
  action_kind: ToolReadinessActionKind;
  action_label: string | null;
  action_available: boolean;
  action_message: string;
  action_url: string | null;
  action_anchor: string | null;
  request_kind: ToolReadinessRequestKind | null;
  /** Si la tool admite conexión per-account, qué provider corresponde. */
  account_provider: string | null;
  account_secret_status: ToolAccountSecretStatus | null;
  exists_in_catalog: boolean;
  adapter_available: boolean;
  risk?: string;
  requires_integration?: string;
  notes: string[];
};

type ToolReadinessResult = {
  summary: "ready" | "has_stubs" | "needs_config";
  skill: {
    root: string;
    composedFrom: string[];
    allowedTools: string[];
  };
  tools: ToolReadinessToolItem[];
};

type ToolReadinessRequestStatus =
  | "requested"
  | "in_review"
  | "in_progress"
  | "shipped"
  | "rejected";

type ToolReadinessRequestRecord = {
  id: string;
  tool_id: string;
  request_kind: ToolReadinessRequestKind;
  status: ToolReadinessRequestStatus;
  created_at: string;
};

type OperationalCaseTestResult = {
  case: OperationalCase | null;
  events: OperationalCaseEvent[];
  toolCalls: ToolCall[];
};

type EditingSnapshot = {
  editing: EditingCaseType;
  schemaText: string;
  procedureText: string;
  fieldListText: string;
  createPrivateSkill: boolean;
  generatedSkillBody: string;
};

function caseTypeToEditing(row: OperationalCaseType): EditingCaseType {
  return {
    case_type: row.case_type,
    display_name: row.display_name,
    default_skill_slug: row.default_skill_slug,
    description: row.description ?? "",
    status: row.status ?? "active",
    visibility:
      row.visibility === "shared" || row.visibility === "private"
        ? row.visibility
        : "private",
    intake_schema_jsonb: Array.isArray(row.intake_schema_jsonb)
      ? row.intake_schema_jsonb
      : [],
    default_reminder_policy_jsonb: row.default_reminder_policy_jsonb ?? {},
    isNew: false,
  };
}

function newCaseType(): EditingCaseType {
  return {
    case_type: "",
    display_name: "",
    default_skill_slug: "",
    description: "",
    status: "active",
    visibility: "private",
    intake_schema_jsonb: DEFAULT_INTAKE_SCHEMA,
    default_reminder_policy_jsonb: {},
    isNew: true,
  };
}

function toSlug(value: string, separator: "-" | "_") {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, separator)
    .replace(new RegExp(`${separator}+`, "g"), separator)
    .replace(new RegExp(`^${separator}|${separator}$`, "g"), "");
}

function labelFromFieldName(value: string) {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\w/, (letter) => letter.toUpperCase());
}

function inferFieldType(label: string): OperationalCaseIntakeField["type"] {
  const normalized = label.toLowerCase();
  if (
    normalized.includes("nota") ||
    normalized.includes("descrip") ||
    normalized.includes("context") ||
    normalized.includes("interés") ||
    normalized.includes("interes")
  ) {
    return "textarea";
  }
  if (normalized.includes("canal") || normalized.includes("medio")) {
    return "select";
  }
  return "text";
}

function parseFieldList(value: string): OperationalCaseIntakeField[] {
  const parts = value
    .split(/\n|,|;/)
    .map((part) => part.trim())
    .filter(Boolean);

  const fields = parts.map((part, index) => {
    const name = toSlug(part, "_") || `campo_${index + 1}`;
    const type = inferFieldType(part);
    return {
      name,
      label: labelFromFieldName(part),
      type,
      required: index === 0,
      placeholder:
        type === "textarea"
          ? "Contexto relevante"
          : type === "select"
            ? undefined
            : `Ej. ${labelFromFieldName(part)}`,
      options:
        type === "select"
          ? ["telegram", "whatsapp", "email", "phone"]
          : undefined,
    } satisfies OperationalCaseIntakeField;
  });

  return fields.length > 0 ? fields : DEFAULT_INTAKE_SCHEMA;
}

function yamlString(value: string) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').slice(0, 900)}"`;
}

/**
 * YAML scalar para `description`. Si el texto tiene saltos de línea (típico
 * cuando el usuario lo escribe con bullets), un string entre comillas dobles
 * "fold" colapsa los saltos a espacios y junta los bullets en una sola línea
 * — eso rompe la legibilidad y la semántica. Usamos bloque literal `|` para
 * preservar las líneas tal cual.
 */
function yamlDescription(value: string, indent: number): string {
  const trimmed = value.trim();
  if (!trimmed) return yamlString("");
  if (!trimmed.includes("\n")) return yamlString(trimmed);
  const pad = " ".repeat(indent);
  const lines = trimmed
    .split("\n")
    .map((line) => `${pad}${line}`)
    .join("\n");
  return `|\n${lines}`;
}

function buildSkillBody(params: {
  slug: string;
  displayName: string;
  description: string;
  procedureText: string;
  fields: OperationalCaseIntakeField[];
  allowedTools?: string[];
  includes?: string[];
}) {
  const procedure =
    params.procedureText.trim() ||
    "Describe el procedimiento operativo que debe seguir Gu para este caso de uso.";
  const fieldLines = params.fields
    .map((field) => `- ${field.label} (${field.name})`)
    .join("\n");
  const toolLines =
    params.allowedTools && params.allowedTools.length > 0
      ? params.allowedTools.map((tool) => `  - ${tool}`).join("\n")
      : "[]";
  const includeLines =
    params.includes && params.includes.length > 0
      ? params.includes.map((slug) => `  - ${slug}`).join("\n")
      : "[]";

  return `---
name: ${params.slug}
description: ${yamlDescription(params.description || `Guía operativa para ${params.displayName}.`, 2)}
scope: business
allowed_tools:${toolLines === "[]" ? " []" : `\n${toolLines}`}
includes:${includeLines === "[]" ? " []" : `\n${includeLines}`}
requires_tenant_context: false
memory_extraction: ephemeral
heartbeat: blocked
guardrails: |
  Sigue el procedimiento definido por la cuenta. Si falta información crítica, pide aclaración antes de avanzar. No ejecutes acciones externas sin confirmación cuando impliquen riesgo comercial, legal o reputacional.
---

# ${params.displayName}

## Procedimiento operativo

${procedure}

## Datos iniciales esperados

${fieldLines || "- Sin campos iniciales configurados."}

## Criterio de operación

Usa esta habilidad cuando exista un caso en operación de este tipo. Lee el contexto del caso, identifica el paso actual, decide la siguiente acción y registra avances mediante las herramientas operativas disponibles.
`;
}

function scopeLabel(row: OperationalCaseType) {
  if (row.visibility === "global" || !row.user_id) return "global";
  return row.visibility ?? "private";
}

/** Colores y etiquetas para distinguir plantilla de producto vs de cuenta a simple vista. */
function templateScopePresentation(isGlobal: boolean) {
  if (isGlobal) {
    return {
      badge:
        "bg-amber-100 text-amber-950 ring-1 ring-amber-300/80 dark:bg-amber-950/45 dark:text-amber-100 dark:ring-amber-700/50",
      listBadge: "Producto global",
      detailBadge: "Plantilla de producto (global)",
      hint: "Incluida con el producto; solo lectura.",
    };
  }
  return {
    badge:
      "bg-emerald-100 text-emerald-950 ring-1 ring-emerald-300/80 dark:bg-emerald-950/45 dark:text-emerald-100 dark:ring-emerald-700/50",
    listBadge: "Cuenta",
    detailBadge: "Plantilla de esta cuenta",
    hint: "Propia de tu cuenta; editable.",
  };
}

function skillKindLabel(kind: string) {
  if (kind === "composite") return "compuesta";
  if (kind === "atomic") return "atómica";
  return kind;
}

function scopeText(scope: string) {
  if (scope === "business") return "negocio";
  if (scope === "personal") return "personal";
  if (scope === "shared") return "compartido";
  return scope;
}

function descriptionParts(description: string) {
  const [intro, rest] = description.split(/:\s*/, 2);
  const steps = rest
    ?.split(/,\s*|;\s*/)
    .map((step) => step.trim())
    .filter(Boolean);

  if (!rest || !steps || steps.length < 2) {
    return { intro: description, steps: [] };
  }

  return { intro: `${intro}:`, steps };
}

function descriptionForEditing(description: string) {
  const { intro, steps } = descriptionParts(description);
  if (steps.length === 0) return description;
  return [intro, "", ...steps.map((step) => `- ${step}`)].join("\n");
}

function authoringHasStatus(
  result: SkillAuthoringResult | null,
  status: "WARN" | "FAIL"
) {
  return (
    result?.validationRubric.some(
      (item) => String(item.status ?? "").toUpperCase() === status
    ) ?? false
  );
}

function formatElapsed(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function fallbackAuthoringMessage(elapsedMs: number) {
  if (elapsedMs > 120000) {
    return "Sigue trabajando; si hay reintentos, aparecerán abajo en detalles.";
  }
  if (elapsedMs > 60000) {
    return "Validando y compactando el borrador. Puede tardar un poco más.";
  }
  if (elapsedMs > 30000) {
    return "El modelo está componiendo el SKILL.md optimizado.";
  }
  return "Preparando contexto y ejecutando skill-authoring.";
}

function toolReadinessLabel(status: ToolReadinessStatus) {
  if (status === "ready") return "Lista";
  if (status === "needs_config") return "Configurar";
  if (status === "stub") return "Stub";
  if (status === "missing") return "Falta";
  return "Desconocida";
}

function toolReadinessClass(status: ToolReadinessStatus) {
  if (status === "ready") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (status === "needs_config") return "border-amber-200 bg-amber-50 text-amber-800";
  if (status === "stub") return "border-sky-200 bg-sky-50 text-sky-800";
  if (status === "missing") return "border-red-200 bg-red-50 text-red-800";
  return "border-neutral-200 bg-neutral-50 text-neutral-700";
}

function toolReadinessSummaryLabel(summary?: ToolReadinessResult["summary"]) {
  if (summary === "ready") return "Preparación completa";
  if (summary === "has_stubs") return "Pendientes técnicos";
  if (summary === "needs_config") return "Preparación incompleta";
  return "Sin diagnóstico";
}

function toolReadinessCounts(result: ToolReadinessResult | null) {
  const counts = {
    ready: 0,
    needs_config: 0,
    stub: 0,
    missing: 0,
    unknown: 0,
    blocking: 0,
  };
  for (const tool of result?.tools ?? []) {
    counts[tool.status] += 1;
    if (tool.blocking) counts.blocking += 1;
  }
  return counts;
}

function toolReadinessCategoryLabel(category: ToolReadinessCategory) {
  if (category === "product_integration") return "Integración del producto";
  if (category === "account_config") return "Configuración de cuenta";
  if (category === "tenant_asset") return "Recurso de cuenta";
  if (category === "technical_stub") return "Pendiente técnico";
  if (category === "skill_definition") return "Definición de skill";
  return "Lista";
}

function readinessRequestStatusLabel(status: ToolReadinessRequestStatus) {
  if (status === "requested") return "Solicitada";
  if (status === "in_review") return "En revisión";
  if (status === "in_progress") return "En desarrollo";
  if (status === "shipped") return "Lista";
  if (status === "rejected") return "No se incorporará";
  return status;
}

function activationToolsDescription(params: {
  toolReadiness: ToolReadinessResult | null;
  toolsHaveBlocks: boolean;
  toolsPass: boolean;
}) {
  if (params.toolsPass) {
    return "Tools listas: readiness sin bloqueos críticos.";
  }
  if (params.toolsHaveBlocks) {
    return "Tools pendientes: resuelve las herramientas bloqueantes antes de activar.";
  }
  if (!params.toolReadiness) {
    return "Tools pendientes: revisa preparación operativa para detectar bloqueos.";
  }
  return "Tools pendientes: hay advertencias no bloqueantes por revisar antes de operar en producción.";
}

function readinessActionUrl(item: ToolReadinessToolItem): string | null {
  if (!item.action_url) return null;
  if (item.action_anchor) {
    return `${item.action_url}#${item.action_anchor}`;
  }
  return item.action_url;
}

function renderReadinessActions(params: {
  item: ToolReadinessToolItem;
  row: OperationalCaseType;
  expanded: boolean;
  existingRequest: ToolReadinessRequestRecord | undefined;
  submitting: boolean;
  onEditSkill: () => void;
  onToggleExpand: () => void;
  onRequestGlobal: () => void;
}) {
  const { item, expanded, existingRequest, submitting } = params;
  const detailsToggle = (
    <button
      type="button"
      onClick={params.onToggleExpand}
      aria-expanded={expanded}
      className="rounded border border-current/40 bg-white/70 px-2 py-1 text-[11px] font-semibold hover:bg-white"
    >
      {expanded ? "Ocultar detalles" : "Detalles"}
    </button>
  );

  if (item.action_kind === "edit_skill") {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={params.onEditSkill}
          className="rounded bg-violet-700 px-2 py-1 text-[11px] font-semibold text-white hover:bg-violet-800"
        >
          {item.action_label ?? "Editar skill"}
        </button>
        {detailsToggle}
      </div>
    );
  }

  // configure_account con provider per-cuenta → expandimos el form inline.
  // El botón principal hace el toggle del bloque expandido, donde el form
  // se renderiza junto al action_message.
  if (
    item.action_kind === "configure_account" &&
    item.account_provider
  ) {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={params.onToggleExpand}
          aria-expanded={expanded}
          className="rounded bg-violet-700 px-2 py-1 text-[11px] font-semibold text-white hover:bg-violet-800"
        >
          {expanded
            ? "Cerrar"
            : (item.action_label ?? `Conectar ${item.account_provider}`)}
        </button>
        {!expanded && detailsToggle}
      </div>
    );
  }

  if (
    (item.action_kind === "connect_integration" ||
      item.action_kind === "configure_account") &&
    readinessActionUrl(item)
  ) {
    const href = readinessActionUrl(item)!;
    const sameOrigin = href.startsWith("/");
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <a
          href={href}
          target={sameOrigin ? undefined : "_blank"}
          rel={sameOrigin ? undefined : "noopener noreferrer"}
          className="rounded bg-violet-700 px-2 py-1 text-[11px] font-semibold text-white hover:bg-violet-800"
        >
          {item.action_label ?? "Conectar"}
        </a>
        {detailsToggle}
      </div>
    );
  }

  if (item.action_kind === "request_global" && item.request_kind) {
    if (existingRequest) {
      return (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="rounded border border-violet-300 bg-violet-50 px-2 py-1 text-[11px] font-semibold text-violet-800">
            Solicitud {readinessRequestStatusLabel(existingRequest.status)}
          </span>
          {detailsToggle}
        </div>
      );
    }
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={params.onRequestGlobal}
          disabled={submitting}
          className="rounded bg-violet-700 px-2 py-1 text-[11px] font-semibold text-white hover:bg-violet-800 disabled:opacity-60"
        >
          {submitting ? "Enviando..." : (item.action_label ?? "Solicitar incorporación")}
        </button>
        {detailsToggle}
      </div>
    );
  }

  return null;
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "Sin fecha";
  return new Intl.DateTimeFormat("es-MX", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function activationStatusBadge(
  status: "ready" | "pending" | "attention",
  label: string
) {
  const className =
    status === "ready"
      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
      : status === "attention"
        ? "border-amber-200 bg-amber-50 text-amber-800"
        : "border-neutral-200 bg-neutral-50 text-neutral-600";
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${className}`}
    >
      {label}
    </span>
  );
}

function serializeEditingSnapshot(snapshot: EditingSnapshot | null) {
  if (!snapshot) return "";
  return JSON.stringify({
    editing: snapshot.editing,
    schemaText: snapshot.schemaText,
    procedureText: snapshot.procedureText,
    fieldListText: snapshot.fieldListText,
    createPrivateSkill: snapshot.createPrivateSkill,
    generatedSkillBody: snapshot.generatedSkillBody,
  });
}

export function OperationalCaseTypesClient({
  initialCaseTypes,
  initialSkillSummaries,
}: {
  initialCaseTypes: OperationalCaseType[];
  initialSkillSummaries: SkillSummary[];
}) {
  const [caseTypes, setCaseTypes] =
    useState<OperationalCaseType[]>(initialCaseTypes);
  const [selectedCaseType, setSelectedCaseType] =
    useState<OperationalCaseType | null>(null);
  const [editing, setEditing] = useState<EditingCaseType | null>(null);
  const [schemaText, setSchemaText] = useState("");
  const [procedureText, setProcedureText] = useState("");
  const [fieldListText, setFieldListText] = useState("");
  const [createPrivateSkill, setCreatePrivateSkill] = useState(true);
  const [generatedSkillBody, setGeneratedSkillBody] = useState("");
  const [accountSkills, setAccountSkills] = useState<AccountSkill[]>([]);
  const [authoringResult, setAuthoringResult] =
    useState<SkillAuthoringResult | null>(null);
  const [authoring, setAuthoring] = useState(false);
  const [authoringStartedAt, setAuthoringStartedAt] = useState<number | null>(
    null
  );
  const [authoringElapsedMs, setAuthoringElapsedMs] = useState(0);
  const [authoringProgress, setAuthoringProgress] = useState<
    AuthoringProgressEvent[]
  >([]);
  const [showAuthoringLog, setShowAuthoringLog] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [toolReadiness, setToolReadiness] =
    useState<ToolReadinessResult | null>(null);
  const [toolReadinessError, setToolReadinessError] = useState<string | null>(
    null
  );
  const [expandedReadinessTools, setExpandedReadinessTools] = useState<
    Set<string>
  >(new Set());
  const [toolRequests, setToolRequests] = useState<ToolReadinessRequestRecord[]>(
    []
  );
  const [toolRequestSubmitting, setToolRequestSubmitting] = useState<
    string | null
  >(null);
  const [toolRequestError, setToolRequestError] = useState<string | null>(null);
  const [toolReadinessLoading, setToolReadinessLoading] = useState(false);
  const [testCaseResult, setTestCaseResult] =
    useState<OperationalCaseTestResult | null>(null);
  const [testCaseLoading, setTestCaseLoading] = useState(false);
  const [testCaseRunning, setTestCaseRunning] = useState(false);
  const [editingBaseline, setEditingBaseline] =
    useState<EditingSnapshot | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const authoringRequestSeq = useRef(0);
  const authoringAbortRef = useRef<AbortController | null>(null);
  const authoringLogRef = useRef<HTMLUListElement | null>(null);
  const editorPanelRef = useRef<HTMLElement | null>(null);

  const sortedCaseTypes = useMemo(
    () =>
      [...caseTypes].sort((a, b) => {
        const aGlobal = scopeLabel(a) === "global" ? 1 : 0;
        const bGlobal = scopeLabel(b) === "global" ? 1 : 0;
        return aGlobal - bGlobal || a.display_name.localeCompare(b.display_name);
      }),
    [caseTypes]
  );
  const skillMap = useMemo(
    () => new Map(initialSkillSummaries.map((skill) => [skill.slug, skill])),
    [initialSkillSummaries]
  );
  const accountSkillMap = useMemo(
    () => new Map(accountSkills.map((skill) => [skill.slug, skill])),
    [accountSkills]
  );
  const authoringHasFail = authoringHasStatus(authoringResult, "FAIL");
  const authoringHasWarn = authoringHasStatus(authoringResult, "WARN");
  const saveBlockedByAuthoring =
    createPrivateSkill && generatedSkillBody.trim().length > 0 && authoringHasFail;
  const selectedSavedSkillBody = selectedCaseType
    ? accountSkillMap.get(selectedCaseType.default_skill_slug)?.body_md ?? ""
    : "";
  const selectedIsPrivate =
    selectedCaseType !== null && scopeLabel(selectedCaseType) !== "global";
  const selectedIsActive = (selectedCaseType?.status ?? "active") === "active";
  const skillLooksValid =
    (generatedSkillBody.trim().length > 0 ||
      selectedSavedSkillBody.trim().length > 0) &&
    !authoringHasFail &&
    (!authoringResult || !authoringHasWarn);
  const readinessCounts = toolReadinessCounts(toolReadiness);
  const toolsPass =
    Boolean(toolReadiness) && readinessCounts.blocking === 0;
  const toolsHaveBlocks = readinessCounts.blocking > 0;
  const shouldReviewTools = selectedIsPrivate && !toolReadiness && !toolReadinessLoading;
  const canCreateTestCase =
    selectedIsPrivate &&
    selectedIsActive &&
    Boolean(toolReadiness) &&
    !toolsHaveBlocks;
  const testPassed =
    testCaseResult?.case?.context_jsonb?.controlled_test_status ===
    "passed_safe_checks";
  const currentEditingSnapshot = editing
    ? {
        editing,
        schemaText,
        procedureText,
        fieldListText,
        createPrivateSkill,
        generatedSkillBody,
      }
    : null;
  const editingHasChanges =
    Boolean(editing?.isNew) ||
    serializeEditingSnapshot(currentEditingSnapshot) !==
      serializeEditingSnapshot(editingBaseline);

  useEffect(() => {
    if (!authoring || !authoringStartedAt) return undefined;
    setAuthoringElapsedMs(Date.now() - authoringStartedAt);
    const timer = window.setInterval(() => {
      setAuthoringElapsedMs(Date.now() - authoringStartedAt);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [authoring, authoringStartedAt]);

  useEffect(() => {
    if (!showAuthoringLog) return;
    const element = authoringLogRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [authoringProgress, showAuthoringLog]);

  useEffect(() => {
    let cancelled = false;
    async function refreshCaseTypes() {
      try {
        const [caseTypesRes, accountSkillsRes] = await Promise.all([
          fetch("/api/operational-case-types", {
            cache: "no-store",
          }),
          fetch("/api/account-skills", {
            cache: "no-store",
          }),
        ]);
        const caseTypesData = (await caseTypesRes.json()) as
          | { ok: true; caseTypes: OperationalCaseType[] }
          | { error: string };
        const accountSkillsData = (await accountSkillsRes.json()) as
          | { ok: true; skills: AccountSkill[] }
          | { error: string };
        if (cancelled) return;
        if (caseTypesRes.ok && "ok" in caseTypesData) {
          setCaseTypes(caseTypesData.caseTypes);
        }
        if (accountSkillsRes.ok && "ok" in accountSkillsData) {
          setAccountSkills(accountSkillsData.skills);
        }
        setSelectedCaseType((current) => {
          if (!current) return current;
          return caseTypesRes.ok && "ok" in caseTypesData
            ? caseTypesData.caseTypes.find((row) => row.id === current.id) ?? null
            : current;
        });
      } catch (err) {
        console.warn("[operational-case-types] refresh failed:", err);
      }
    }
    void refreshCaseTypes();
    return () => {
      cancelled = true;
    };
  }, []);

  async function loadAccountSkillsFromApi() {
    const res = await fetch("/api/account-skills", { cache: "no-store" });
    const data = (await res.json()) as
      | { ok: true; skills: AccountSkill[] }
      | { error: string };
    if (!res.ok || !("ok" in data)) return [];
    setAccountSkills(data.skills);
    return data.skills;
  }

  async function refreshToolReadiness(row: OperationalCaseType) {
    if (scopeLabel(row) === "global") {
      setToolReadiness(null);
      setToolReadinessError(null);
      setExpandedReadinessTools(new Set());
      setToolRequests([]);
      setToolRequestError(null);
      setToolRequestSubmitting(null);
      return;
    }
    setToolReadinessLoading(true);
    setToolReadinessError(null);
    setExpandedReadinessTools(new Set());
    setToolRequests([]);
    setToolRequestError(null);
    setToolRequestSubmitting(null);
    try {
      const res = await fetch(
        `/api/tool-readiness?case_type_id=${encodeURIComponent(row.id)}`,
        { cache: "no-store" }
      );
      const data = (await res.json()) as
        | ({ ok: true } & ToolReadinessResult)
        | { error: string };
      if (!res.ok || !("ok" in data)) {
        setToolReadiness(null);
        setToolReadinessError(
          "error" in data ? data.error : "No se pudo revisar la preparación operativa."
        );
        return;
      }
      setToolReadiness({
        summary: data.summary,
        skill: data.skill,
        tools: data.tools,
      });
      void refreshToolRequests(row);
    } catch (err) {
      console.warn("[operational-case-types] tool readiness failed:", err);
      setToolReadiness(null);
      setToolReadinessError((err as Error).message ?? String(err));
    } finally {
      setToolReadinessLoading(false);
    }
  }

  async function refreshToolRequests(row: OperationalCaseType) {
    try {
      const res = await fetch(
        `/api/global-tool-requests?case_type_id=${encodeURIComponent(row.id)}&status=requested,in_review,in_progress`,
        { cache: "no-store" }
      );
      const data = (await res.json()) as
        | { ok: true; requests: ToolReadinessRequestRecord[] }
        | { error: string };
      if (!res.ok || !("ok" in data)) {
        setToolRequests([]);
        return;
      }
      setToolRequests(data.requests ?? []);
    } catch (err) {
      console.warn("[operational-case-types] tool requests load failed:", err);
      setToolRequests([]);
    }
  }

  async function createToolRequest(
    row: OperationalCaseType,
    tool: ToolReadinessToolItem
  ) {
    if (!tool.request_kind) return;
    setToolRequestSubmitting(tool.tool_id);
    setToolRequestError(null);
    try {
      const res = await fetch("/api/global-tool-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tool_id: tool.tool_id,
          request_kind: tool.request_kind,
          case_type_id: row.id,
        }),
      });
      const data = (await res.json()) as
        | { ok: true; request: ToolReadinessRequestRecord; duplicate: boolean }
        | { error: string };
      if (!res.ok || !("ok" in data)) {
        setToolRequestError(
          "error" in data ? data.error : "No se pudo crear la solicitud."
        );
        return;
      }
      setToolRequests((prev) => {
        const without = prev.filter(
          (item) =>
            item.tool_id !== data.request.tool_id || item.id === data.request.id
        );
        return [data.request, ...without];
      });
    } catch (err) {
      setToolRequestError((err as Error).message ?? String(err));
    } finally {
      setToolRequestSubmitting(null);
    }
  }

  async function refreshTestCase(row: OperationalCaseType) {
    if (scopeLabel(row) === "global") {
      setTestCaseResult(null);
      return;
    }
    setTestCaseLoading(true);
    try {
      const res = await fetch(
        `/api/operational-case-tests?case_type_id=${encodeURIComponent(row.id)}`,
        { cache: "no-store" }
      );
      const data = (await res.json()) as
        | ({ ok: true } & OperationalCaseTestResult)
        | { error: string };
      if (!res.ok || !("ok" in data)) {
        setTestCaseResult(null);
        return;
      }
      setTestCaseResult({
        case: data.case,
        events: data.events ?? [],
        toolCalls: data.toolCalls ?? [],
      });
    } catch (err) {
      console.warn("[operational-case-types] test case load failed:", err);
      setTestCaseResult(null);
    } finally {
      setTestCaseLoading(false);
    }
  }

  async function createTestCase() {
    if (!selectedCaseType) return;
    setTestCaseLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/operational-case-tests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ case_type_id: selectedCaseType.id }),
      });
      const data = (await res.json()) as
        | ({ ok: true } & OperationalCaseTestResult)
        | { error: string };
      if (!res.ok || !("ok" in data)) {
        setError("error" in data ? data.error : "test_case_create_failed");
        return;
      }
      setTestCaseResult({
        case: data.case,
        events: data.events ?? [],
        toolCalls: data.toolCalls ?? [],
      });
    } catch (err) {
      setError((err as Error).message ?? String(err));
    } finally {
      setTestCaseLoading(false);
    }
  }

  async function runControlledTest() {
    const caseId = testCaseResult?.case?.id;
    if (!caseId) return;
    setTestCaseRunning(true);
    setError(null);
    try {
      const res = await fetch("/api/operational-case-tests/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ case_id: caseId }),
      });
      const data = (await res.json()) as
        | ({ ok: true } & OperationalCaseTestResult)
        | { error: string };
      if (!res.ok || !("ok" in data)) {
        setError("error" in data ? data.error : "controlled_test_failed");
        return;
      }
      setTestCaseResult({
        case: data.case,
        events: data.events ?? [],
        toolCalls: data.toolCalls ?? [],
      });
    } catch (err) {
      setError((err as Error).message ?? String(err));
    } finally {
      setTestCaseRunning(false);
    }
  }

  function scrollEditorPanelToTop() {
    window.requestAnimationFrame(() => {
      editorPanelRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    });
  }

  async function startEdit(row: OperationalCaseType) {
    const value = caseTypeToEditing(row);
    const editableDescription = descriptionForEditing(value.description);
    let savedSkillBody =
      accountSkillMap.get(value.default_skill_slug)?.body_md ?? "";
    if (!savedSkillBody) {
      try {
        const skills = await loadAccountSkillsFromApi();
        savedSkillBody =
          skills.find((skill) => skill.slug === value.default_skill_slug)
            ?.body_md ?? "";
      } catch (err) {
        console.warn("[operational-case-types] account skill load failed:", err);
      }
    }
    setSelectedCaseType(row);
    const nextEditing = { ...value, description: editableDescription };
    const nextSchemaText = JSON.stringify(value.intake_schema_jsonb, null, 2);
    const nextFieldListText = value.intake_schema_jsonb
      .map((field) => field.label)
      .join("\n");
    const nextCreatePrivateSkill = Boolean(savedSkillBody);
    setEditing(nextEditing);
    setSchemaText(nextSchemaText);
    setProcedureText(editableDescription);
    setFieldListText(nextFieldListText);
    setCreatePrivateSkill(nextCreatePrivateSkill);
    setGeneratedSkillBody(savedSkillBody);
    setEditingBaseline({
      editing: nextEditing,
      schemaText: nextSchemaText,
      procedureText: editableDescription,
      fieldListText: nextFieldListText,
      createPrivateSkill: nextCreatePrivateSkill,
      generatedSkillBody: savedSkillBody,
    });
    setAuthoringResult(null);
    setShowAdvanced(Boolean(savedSkillBody));
    setToolReadiness(null);
    setToolReadinessError(null);
    setExpandedReadinessTools(new Set());
    setToolRequests([]);
    setToolRequestError(null);
    setToolRequestSubmitting(null);
    setTestCaseResult(null);
    void refreshToolReadiness(row);
    void refreshTestCase(row);
    setError(null);
    scrollEditorPanelToTop();
  }

  function viewCaseType(row: OperationalCaseType) {
    setSelectedCaseType(row);
    setEditing(null);
    setSchemaText("");
    setProcedureText("");
    setFieldListText("");
    setGeneratedSkillBody("");
    setAuthoringResult(null);
    setShowAdvanced(false);
    setToolReadiness(null);
    setToolReadinessError(null);
    setExpandedReadinessTools(new Set());
    setToolRequests([]);
    setToolRequestError(null);
    setToolRequestSubmitting(null);
    setTestCaseResult(null);
    setEditingBaseline(null);
    if (scopeLabel(row) !== "global") {
      void refreshToolReadiness(row);
      void refreshTestCase(row);
    }
    setError(null);
  }

  function startPrivateVersion(row: OperationalCaseType) {
    const value = caseTypeToEditing(row);
    const editableDescription = descriptionForEditing(value.description);
    const existingSkill = skillMap.get(value.default_skill_slug);
    const skillBody = buildSkillBody({
      slug: value.default_skill_slug,
      displayName: value.display_name,
      description: editableDescription,
      procedureText: editableDescription,
      fields: value.intake_schema_jsonb,
      allowedTools: existingSkill?.allowedTools,
      includes: existingSkill?.includes,
    });
    const nextEditing = {
      ...value,
      description: editableDescription,
      visibility: "private" as const,
      isNew: true,
    };
    const nextSchemaText = JSON.stringify(value.intake_schema_jsonb, null, 2);
    const nextFieldListText = value.intake_schema_jsonb
      .map((field) => field.label)
      .join("\n");
    setSelectedCaseType(row);
    setEditing(nextEditing);
    setSchemaText(nextSchemaText);
    setProcedureText(editableDescription);
    setFieldListText(nextFieldListText);
    setCreatePrivateSkill(true);
    setGeneratedSkillBody(skillBody);
    setEditingBaseline({
      editing: nextEditing,
      schemaText: nextSchemaText,
      procedureText: editableDescription,
      fieldListText: nextFieldListText,
      createPrivateSkill: true,
      generatedSkillBody: skillBody,
    });
    setAuthoringResult(null);
    setShowAdvanced(false);
    setToolReadiness(null);
    setToolReadinessError(null);
    setExpandedReadinessTools(new Set());
    setToolRequests([]);
    setToolRequestError(null);
    setToolRequestSubmitting(null);
    setTestCaseResult(null);
    setError(null);
    scrollEditorPanelToTop();
  }

  function startNew() {
    const value = newCaseType();
    setSelectedCaseType(null);
    setEditing(value);
    const nextSchemaText = JSON.stringify(value.intake_schema_jsonb, null, 2);
    const nextFieldListText = "Título\nNotas iniciales";
    setSchemaText(nextSchemaText);
    setProcedureText("");
    setFieldListText(nextFieldListText);
    setCreatePrivateSkill(true);
    setGeneratedSkillBody("");
    setEditingBaseline({
      editing: value,
      schemaText: nextSchemaText,
      procedureText: "",
      fieldListText: nextFieldListText,
      createPrivateSkill: true,
      generatedSkillBody: "",
    });
    setAuthoringResult(null);
    setShowAdvanced(false);
    setToolReadiness(null);
    setToolReadinessError(null);
    setExpandedReadinessTools(new Set());
    setToolRequests([]);
    setToolRequestError(null);
    setToolRequestSubmitting(null);
    setTestCaseResult(null);
    setError(null);
    scrollEditorPanelToTop();
  }

  function generateDraft() {
    if (!editing) return;
    const displayName = editing.display_name.trim() || "Nuevo caso de uso";
    const caseType = editing.case_type.trim() || toSlug(displayName, "_");
    const skillSlug =
      editing.default_skill_slug.trim() || `${toSlug(displayName, "-")}-coach`;
    const fields = parseFieldList(fieldListText);
    const existingSkill = skillMap.get(skillSlug);
    const description =
      editing.description.trim() ||
      procedureText.trim().split(/\n\n|\. /)[0]?.trim() ||
      `Procedimiento operativo para ${displayName}.`;
    const next = {
      ...editing,
      case_type: caseType,
      display_name: displayName,
      default_skill_slug: skillSlug,
      description,
      intake_schema_jsonb: fields,
    };
    setEditing(next);
    setSchemaText(JSON.stringify(fields, null, 2));
    setGeneratedSkillBody(
      buildSkillBody({
        slug: skillSlug,
        displayName,
        description,
        procedureText,
        fields,
        allowedTools: existingSkill?.allowedTools,
        includes: existingSkill?.includes,
      })
    );
    setShowAdvanced(true);
    setAuthoringResult(null);
    setError(null);
  }

  function cancelAuthoring() {
    authoringRequestSeq.current += 1;
    authoringAbortRef.current?.abort();
    authoringAbortRef.current = null;
    setAuthoring(false);
    setAuthoringStartedAt(null);
    setAuthoringProgress((prev) => [
      ...prev,
      {
        type: "stage",
        stage: "cancelled",
        message: "Generación cancelada por el usuario.",
        ts: Date.now(),
      },
    ]);
  }

  function applyAuthoringResult(data: { ok: true } & SkillAuthoringResult) {
    setGeneratedSkillBody(data.skillDraft);
    setAuthoringResult({
      skillDraft: data.skillDraft,
      validationRubric: data.validationRubric ?? [],
      suggestedEvals: data.suggestedEvals ?? {},
      activationRecommendation: data.activationRecommendation ?? "",
      attemptsUsed: data.attemptsUsed,
      elapsedMs: data.elapsedMs,
      metadataTruncated: data.metadataTruncated,
    });
    setCreatePrivateSkill(true);
    setShowAdvanced(true);
  }

  async function generateOptimizedDraft() {
    if (!editing) return;
    const requestId = authoringRequestSeq.current + 1;
    authoringRequestSeq.current = requestId;
    authoringAbortRef.current?.abort();
    const abortController = new AbortController();
    authoringAbortRef.current = abortController;
    setAuthoring(true);
    setAuthoringStartedAt(Date.now());
    setAuthoringElapsedMs(0);
    setAuthoringProgress([]);
    setShowAuthoringLog(true);
    setError(null);
    try {
      const res = await fetch("/api/skill-authoring", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortController.signal,
        body: JSON.stringify({
          caseType: editing.case_type,
          displayName: editing.display_name,
          description: procedureText || editing.description,
          fieldList: fieldListText,
          intakeSchema: editing.intake_schema_jsonb,
          skillSlug: editing.default_skill_slug,
          baseSkillSlug: selectedCaseType?.default_skill_slug ?? editing.default_skill_slug,
        }),
      });
      const contentType = res.headers.get("content-type") ?? "";
      if (!res.ok && !contentType.includes("application/x-ndjson")) {
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
          raw?: string;
        };
        if (requestId !== authoringRequestSeq.current) return;
        setError(data.raw ? `${data.error}\n\n${data.raw}` : data.error ?? "skill_authoring_failed");
        return;
      }

      if (!res.body || !contentType.includes("application/x-ndjson")) {
        const data = (await res.json()) as
          | ({ ok: true } & SkillAuthoringResult)
          | { error: string; raw?: string };
        if (requestId !== authoringRequestSeq.current) return;
        if (!("ok" in data)) {
          setError(
            "raw" in data && data.raw
              ? `${data.error}\n\n${data.raw}`
              : "error" in data
                ? data.error
                : "skill_authoring_failed"
          );
          return;
        }
        applyAuthoringResult(data);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let gotResult = false;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const event = JSON.parse(trimmed) as
            | AuthoringProgressEvent
            | {
                type: "result";
                payload: { ok: true } & SkillAuthoringResult;
                ts?: number;
              };
          if (requestId !== authoringRequestSeq.current) return;
          if (event.type === "stage" || event.type === "error") {
            setAuthoringProgress((prev) => [...prev, event]);
          }
          if (event.type === "error") {
            setError(
              event.details ? `${event.error}: ${event.details}` : event.error ?? "skill_authoring_failed"
            );
            return;
          }
          if (event.type === "result") {
            gotResult = true;
            applyAuthoringResult(event.payload);
          }
        }
      }
      if (buffer.trim()) {
        const event = JSON.parse(buffer.trim()) as
          | AuthoringProgressEvent
          | {
              type: "result";
              payload: { ok: true } & SkillAuthoringResult;
              ts?: number;
            };
        if (requestId === authoringRequestSeq.current) {
          if (event.type === "stage" || event.type === "error") {
            setAuthoringProgress((prev) => [...prev, event]);
          }
          if (event.type === "error") {
            setError(
              event.details ? `${event.error}: ${event.details}` : event.error ?? "skill_authoring_failed"
            );
            return;
          }
          if (event.type === "result") {
            gotResult = true;
            applyAuthoringResult(event.payload);
          }
        }
      }
      if (!gotResult && requestId === authoringRequestSeq.current) {
        setError("skill_authoring_stream_finished_without_result");
      }
    } catch (err) {
      if (requestId !== authoringRequestSeq.current) return;
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError((err as Error).message ?? String(err));
    } finally {
      if (requestId === authoringRequestSeq.current) {
        setAuthoring(false);
        setAuthoringStartedAt(null);
        authoringAbortRef.current = null;
      }
    }
  }

  async function save() {
    if (!editing) return;
    setSaving(true);
    setError(null);
    try {
      let intakeSchema: unknown;
      try {
        intakeSchema = JSON.parse(schemaText);
      } catch (err) {
        setError(`intake_schema_jsonb inválido: ${(err as Error).message}`);
        return;
      }

      if (createPrivateSkill) {
        const skillBody =
          generatedSkillBody ||
          buildSkillBody({
            slug: editing.default_skill_slug,
            displayName: editing.display_name,
            description: editing.description,
            procedureText,
            fields: Array.isArray(intakeSchema)
              ? (intakeSchema as OperationalCaseIntakeField[])
              : [],
          });
        const skillRes = await fetch("/api/account-skills", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            slug: editing.default_skill_slug,
            body_md: skillBody,
            status: "active",
          }),
        });
        const skillData = (await skillRes.json()) as
          | { ok: true }
          | { error: string; details?: string };
        if (!skillRes.ok || !("ok" in skillData)) {
          setError(
            "details" in skillData && skillData.details
              ? `${skillData.error}: ${skillData.details}`
              : "error" in skillData
                ? skillData.error
                : "skill_save_failed"
          );
          return;
        }
      }

      const res = await fetch("/api/operational-case-types", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...editing,
          intake_schema_jsonb: intakeSchema,
          default_reminder_policy_jsonb: editing.default_reminder_policy_jsonb,
        }),
      });
      const data = (await res.json()) as
        | { ok: true; caseType: OperationalCaseType }
        | { error: string };
      if (!res.ok || !("ok" in data)) {
        setError("error" in data ? data.error : "save_failed");
        return;
      }

      setCaseTypes((prev) => {
        const without = prev.filter((row) => row.id !== data.caseType.id);
        return [data.caseType, ...without];
      });
      setSelectedCaseType(data.caseType);
      setToolReadiness(null);
      setToolReadinessError(null);
      setExpandedReadinessTools(new Set());
    setToolRequests([]);
    setToolRequestError(null);
    setToolRequestSubmitting(null);
      setTestCaseResult(null);
      void refreshToolReadiness(data.caseType);
      void refreshTestCase(data.caseType);
      setEditingBaseline(null);
      setEditing(null);
    } catch (err) {
      setError((err as Error).message ?? String(err));
    } finally {
      setSaving(false);
    }
  }

  function renderCaseTypeDetail(row: OperationalCaseType) {
    const skill = skillMap.get(row.default_skill_slug);
    const isGlobal = scopeLabel(row) === "global";
    const scopeUi = templateScopePresentation(isGlobal);
    const fields = Array.isArray(row.intake_schema_jsonb)
      ? row.intake_schema_jsonb
      : [];

    return (
      <div className="space-y-4">
        <div>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2 className="text-base font-semibold">{row.display_name}</h2>
              <p className="mt-1 font-mono text-xs text-neutral-500">
                {row.case_type}
              </p>
            </div>
            <span
              className={`rounded-md px-2 py-1 text-xs font-medium ${scopeUi.badge}`}
              title={scopeUi.hint}
            >
              {scopeUi.detailBadge}
            </span>
          </div>
          {isGlobal ? (
            <p className="mt-2 text-sm text-neutral-500">
              Esta plantilla global es solo de lectura. Puedes crear una versión
              privada para adaptarla a esta cuenta sin modificar la plantilla de
              producto.
            </p>
          ) : (
            <p className="mt-2 text-sm text-neutral-500">
              Esta plantilla pertenece a la cuenta y puede editarse directamente.
            </p>
          )}
        </div>

        {row.description ? (
          <div className="rounded-xl border border-neutral-200 p-3 text-sm dark:border-neutral-800">
            <div className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
              Descripción
            </div>
            {(() => {
              const { intro, steps } = descriptionParts(row.description ?? "");
              return (
                <div className="mt-2 text-neutral-700 dark:text-neutral-200">
                  <p>{intro}</p>
                  {steps.length > 0 ? (
                    <ul className="mt-2 list-disc space-y-1 pl-5">
                      {steps.map((step) => (
                        <li key={step}>{step}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              );
            })()}
          </div>
        ) : null}

        <div className="rounded-xl border border-neutral-200 p-3 text-sm dark:border-neutral-800">
          <div className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
            Formulario inicial
          </div>
          {fields.length > 0 ? (
            <ul className="mt-2 space-y-2">
              {fields.map((field) => (
                <li key={field.name} className="text-sm">
                  <span className="font-medium">{field.label}</span>{" "}
                  <span className="text-xs text-neutral-500">
                    ({field.type}
                    {field.required ? ", requerido" : ", opcional"})
                  </span>
                  <div className="font-mono text-xs text-neutral-500">
                    {field.name}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-neutral-500">
              Sin campos iniciales configurados.
            </p>
          )}
        </div>

        <div className="rounded-xl border border-neutral-200 p-3 text-sm dark:border-neutral-800">
          <div className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
            Habilidad asociada
          </div>
          <div className="mt-2 flex flex-wrap gap-2 text-xs">
            <span className="rounded bg-violet-50 px-2 py-1 font-mono text-violet-700">
              {row.default_skill_slug}
            </span>
            {skill ? (
              <>
                <span className="rounded bg-gray-100 px-2 py-1 text-gray-600">
                  {skillKindLabel(skill.kind)}
                </span>
                <span className="rounded bg-gray-100 px-2 py-1 text-gray-600">
                  Ámbito: {scopeText(skill.scope)}
                </span>
              </>
            ) : (
              <span className="rounded bg-red-50 px-2 py-1 text-red-700">
                habilidad no encontrada
              </span>
            )}
          </div>
          {skill?.description ? (
            <p className="mt-2 text-xs text-neutral-500">{skill.description}</p>
          ) : null}
          {skill && skill.includes.length > 0 ? (
            <div className="mt-3">
              <div className="text-xs font-semibold text-neutral-600">
                Skills atómicas incluidas
              </div>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {skill.includes.map((slug) => (
                  <span
                    key={slug}
                    className="rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-[11px] text-neutral-600"
                  >
                    {slug}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
          {skill && skill.allowedTools.length > 0 ? (
            <div className="mt-3">
              <div className="text-xs font-semibold text-neutral-600">
                Herramientas permitidas
              </div>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {skill.allowedTools.map((tool) => (
                  <span
                    key={tool}
                    className="rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-[11px] text-neutral-600"
                  >
                    {tool}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        {!isGlobal ? (
          <div className="space-y-3 rounded-xl border border-neutral-200 p-3 text-sm dark:border-neutral-800">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                  Preparación operativa
                </div>
                <p className="mt-1 text-xs text-neutral-500">
                  Revisa si las herramientas de la habilidad privada existen,
                  tienen adapter y están configuradas antes de probarla.
                </p>
              </div>
              <button
                type="button"
                onClick={() => refreshToolReadiness(row)}
                disabled={toolReadinessLoading}
                className={`shrink-0 rounded px-2 py-1 text-xs font-semibold disabled:opacity-60 ${
                  shouldReviewTools
                    ? "bg-violet-700 text-white hover:bg-violet-800"
                    : "border border-neutral-300 hover:bg-neutral-50"
                }`}
              >
                {toolReadinessLoading
                  ? "Revisando..."
                  : toolReadiness
                    ? "Volver a revisar"
                    : "Revisar"}
              </button>
            </div>
            <div className="text-sm font-semibold">
              {toolReadinessSummaryLabel(toolReadiness?.summary)}
            </div>
            {toolReadiness ? (
              <div className="flex flex-wrap gap-1.5 text-[11px]">
                <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-800">
                  {readinessCounts.ready} listas
                </span>
                {readinessCounts.needs_config > 0 ? (
                  <span className="rounded bg-amber-50 px-1.5 py-0.5 text-amber-800">
                    {readinessCounts.needs_config} por configurar
                  </span>
                ) : null}
                {readinessCounts.stub > 0 ? (
                  <span className="rounded bg-sky-50 px-1.5 py-0.5 text-sky-800">
                    {readinessCounts.stub} stubs
                  </span>
                ) : null}
                {readinessCounts.missing + readinessCounts.unknown > 0 ? (
                  <span className="rounded bg-red-50 px-1.5 py-0.5 text-red-800">
                    {readinessCounts.missing + readinessCounts.unknown} pendientes técnicos
                  </span>
                ) : null}
              </div>
            ) : null}
            {toolsHaveBlocks ? (
              <p className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
                Resuelve las tools bloqueantes antes de crear una prueba
                end-to-end. Los stubs no bloqueantes pueden quedar como
                advertencia para una prueba parcial.
              </p>
            ) : null}
            {toolReadinessError ? (
              <p className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-800">
                No se pudo revisar la preparación operativa: {toolReadinessError}
              </p>
            ) : toolReadiness?.tools.length ? (
              <ul className="space-y-2">
                {toolReadiness.tools.map((item) => {
                  const expanded = expandedReadinessTools.has(item.tool_id);
                  const existingRequest = toolRequests.find(
                    (req) => req.tool_id === item.tool_id
                  );
                  const submitting = toolRequestSubmitting === item.tool_id;
                  return (
                    <li
                      key={item.tool_id}
                      className={`rounded border p-2 ${toolReadinessClass(item.status)}`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-mono text-xs">{item.tool_id}</span>
                        <span className="rounded bg-white/70 px-1.5 py-0.5 text-[11px] font-semibold">
                          {toolReadinessLabel(item.status)}
                        </span>
                      </div>
                      <div className="mt-1 text-[11px]">
                        Riesgo: {item.risk ?? "n/d"}
                        {item.requires_integration
                          ? ` · integración: ${item.requires_integration}`
                          : ""}
                        {` · ${toolReadinessCategoryLabel(item.category)}`}
                      </div>
                      {item.blocking ? (
                        <p className="mt-1 text-xs font-semibold">
                          Bloquea la prueba end-to-end.
                        </p>
                      ) : item.status !== "ready" ? (
                        <p className="mt-1 text-xs font-semibold">
                          No bloquea la prueba segura, pero debe resolverse antes
                          de operación real.
                        </p>
                      ) : null}
                      {item.notes.length > 0 ? (
                        <p className="mt-1 text-xs">{item.notes.join(" ")}</p>
                      ) : null}
                      {renderReadinessActions({
                        item,
                        row,
                        expanded,
                        existingRequest,
                        submitting,
                        onEditSkill: () => startEdit(row),
                        onToggleExpand: () =>
                          setExpandedReadinessTools((prev) => {
                            const next = new Set(prev);
                            if (next.has(item.tool_id)) {
                              next.delete(item.tool_id);
                            } else {
                              next.add(item.tool_id);
                            }
                            return next;
                          }),
                        onRequestGlobal: () => createToolRequest(row, item),
                      })}
                      {expanded ? (
                        <div className="mt-2 space-y-2">
                          {item.action_message ? (
                            <p className="rounded border border-white/70 bg-white/70 p-2 text-[11px] leading-snug">
                              {item.action_message}
                            </p>
                          ) : null}
                          {item.account_provider &&
                          item.action_kind === "configure_account" ? (
                            <div className="rounded border border-white/70 bg-white/85 p-3">
                              <AccountToolConnectionForm
                                provider={item.account_provider}
                                compact
                                onChanged={() => {
                                  void refreshToolReadiness(row);
                                }}
                              />
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
                {toolRequestError ? (
                  <li className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-800">
                    {toolRequestError}
                  </li>
                ) : null}
              </ul>
            ) : toolReadiness ? (
              <p className="rounded border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-800">
                No se requieren herramientas para esta habilidad. Puedes seguir
                con el caso de prueba.
              </p>
            ) : (
              <p className="text-xs text-neutral-500">
                {toolReadinessLoading
                  ? "Calculando herramientas requeridas..."
                  : "Pendiente: revisa herramientas antes de crear un caso de prueba."}
              </p>
            )}
          </div>
        ) : null}

        {!isGlobal ? (
          <div className="space-y-3 rounded-xl border border-neutral-200 p-3 text-sm dark:border-neutral-800">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                Caso de prueba
              </div>
              <p className="mt-1 text-xs text-neutral-500">
                Crea un caso marcado como prueba para validar esta plantilla sin
                mezclarlo con la operación real.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={createTestCase}
                disabled={!canCreateTestCase || testCaseLoading}
                className={`rounded px-3 py-2 text-xs font-semibold disabled:opacity-60 ${
                  canCreateTestCase && !testCaseResult?.case
                    ? "bg-violet-700 text-white hover:bg-violet-800"
                    : "border border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-50"
                }`}
              >
                {testCaseLoading ? "Creando..." : "Crear caso de prueba"}
              </button>
              <button
                type="button"
                onClick={runControlledTest}
                disabled={
                  !testCaseResult?.case || testCaseRunning || toolsHaveBlocks
                }
                className="rounded border border-violet-300 bg-violet-50 px-3 py-2 text-xs font-semibold text-violet-800 hover:bg-violet-100 disabled:opacity-60"
                title={
                  toolsHaveBlocks
                    ? "Resuelve las tools bloqueantes antes de ejecutar la prueba end-to-end."
                    : undefined
                }
              >
                {testCaseRunning ? "Ejecutando..." : "Ejecutar prueba controlada"}
              </button>
            </div>
            {toolsHaveBlocks && testCaseResult?.case ? (
              <p className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
                Hay un caso de prueba creado previamente, pero la ejecución
                quedó bloqueada hasta resolver las tools marcadas como
                bloqueantes en Preparación operativa.
              </p>
            ) : null}
            {testCaseResult?.case ? (
              <div className="rounded border border-neutral-200 bg-neutral-50 p-2 text-xs dark:border-neutral-800 dark:bg-neutral-950">
                <div className="font-semibold">
                  {String(
                    testCaseResult.case.context_jsonb?.title ??
                      testCaseResult.case.id
                  )}
                </div>
                <div className="mt-1 text-neutral-500">
                  Estado: {testCaseResult.case.status} · Paso:{" "}
                  {testCaseResult.case.current_step ?? "sin paso"} · Creado:{" "}
                  {formatDateTime(testCaseResult.case.created_at)}
                </div>
                <a
                  href={`/operational-cases?case=${testCaseResult.case.id}`}
                  className="mt-1 inline-block font-semibold text-violet-700 hover:underline"
                >
                  Abrir en Casos operacionales
                </a>
              </div>
            ) : (
              <p className="text-xs text-neutral-500">
                {testCaseLoading
                  ? "Buscando el caso de prueba más reciente..."
                  : !toolReadiness
                    ? "Primero revisa la preparación operativa."
                    : toolsHaveBlocks
                      ? "Resuelve las tools bloqueantes antes de crear una prueba end-to-end."
                      : "Aún no hay caso de prueba para esta plantilla."}
              </p>
            )}
          </div>
        ) : null}

        {!isGlobal && testCaseResult?.case ? (
          <div className="space-y-3 rounded-xl border border-neutral-200 p-3 text-sm dark:border-neutral-800">
            <div className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
              Resultado de prueba
            </div>
            <div>
              <div className="text-xs font-semibold text-neutral-600">
                Timeline
              </div>
              {testCaseResult.events.length > 0 ? (
                <ul className="mt-2 space-y-2">
                  {testCaseResult.events.map((event) => (
                    <li
                      key={event.id}
                      className="rounded border border-neutral-200 bg-white p-2 text-xs dark:border-neutral-800 dark:bg-neutral-900"
                    >
                      <div className="font-semibold">
                        {event.event_type} · {event.actor}
                      </div>
                      <div className="text-neutral-500">
                        {formatDateTime(event.created_at)}
                      </div>
                      <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap rounded bg-neutral-50 p-2 font-mono text-[11px] dark:bg-neutral-950">
                        {JSON.stringify(event.payload_jsonb, null, 2)}
                      </pre>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-xs text-neutral-500">
                  Sin eventos registrados todavía.
                </p>
              )}
            </div>
            <div>
              <div className="text-xs font-semibold text-neutral-600">
                Tool calls
              </div>
              {testCaseResult.toolCalls.length > 0 ? (
                <ul className="mt-2 space-y-2">
                  {testCaseResult.toolCalls.map((call) => (
                    <li
                      key={call.id}
                      className="rounded border border-neutral-200 bg-white p-2 text-xs dark:border-neutral-800 dark:bg-neutral-900"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-mono">{call.tool_name}</span>
                        <span>{call.status}</span>
                      </div>
                      <div className="text-neutral-500">
                        {formatDateTime(call.created_at)}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-xs text-neutral-500">
                  Sin llamadas de tools. Las tools de envío/escritura/publicación
                  no se ejecutan automáticamente en esta prueba inicial.
                </p>
              )}
            </div>
          </div>
        ) : null}

        {!isGlobal ? (
          <div className="space-y-2 rounded-xl border border-neutral-200 p-3 text-sm dark:border-neutral-800">
            <div className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
              Checks de activación
            </div>
            <ul className="space-y-2 text-xs">
              <li className="flex items-start gap-2">
                {activationStatusBadge(
                  skillLooksValid ? "ready" : "pending",
                  skillLooksValid ? "✓ Listo" : "Pendiente"
                )}
                <span>Skill válida: parser/rúbrica sin bloqueos.</span>
              </li>
              <li className="flex items-start gap-2">
                {activationStatusBadge(
                  toolsPass ? "ready" : toolsHaveBlocks ? "attention" : "pending",
                  toolsPass
                    ? "✓ Listo"
                    : toolsHaveBlocks
                      ? "Resolver bloqueos"
                      : "Pendiente"
                )}
                <span>
                  {activationToolsDescription({
                    toolReadiness,
                    toolsHaveBlocks,
                    toolsPass,
                  })}
                </span>
              </li>
              <li className="flex items-start gap-2">
                {activationStatusBadge(
                  testPassed ? "ready" : "pending",
                  testPassed ? "✓ Listo" : "Pendiente"
                )}
                <span>
                  Prueba end-to-end pasada: caso de prueba avanzó por el flujo
                  seguro inicial.
                </span>
              </li>
              <li className="flex items-start gap-2">
                {activationStatusBadge(
                  selectedIsActive && skillLooksValid && toolsPass && testPassed
                    ? "ready"
                    : "pending",
                  selectedIsActive && skillLooksValid && toolsPass && testPassed
                    ? "✓ Listo"
                    : "Pendiente"
                )}
                <span>
                  Activo para operación: listo para usarse normalmente desde
                  Casos operacionales.
                </span>
              </li>
            </ul>
          </div>
        ) : null}

        <div className="flex justify-end gap-2">
          {isGlobal ? (
            <button
              type="button"
              onClick={() => startPrivateVersion(row)}
              className="rounded bg-violet-700 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-800"
            >
              Crear versión privada
            </button>
          ) : (
            <button
              type="button"
              onClick={() => startEdit(row)}
              className="rounded bg-violet-700 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-800"
            >
              Editar configuración
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <section className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_420px] xl:grid-cols-[minmax(0,1fr)_460px]">
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Disponibles</h2>
          <button
            type="button"
            onClick={startNew}
            className="rounded bg-black px-4 py-2 text-sm font-semibold text-white hover:bg-gray-800"
          >
            + Nuevo caso de uso
          </button>
        </div>

        <div className="divide-y divide-gray-200 rounded border border-gray-200 bg-white dark:divide-neutral-800 dark:border-neutral-800 dark:bg-neutral-900">
          {sortedCaseTypes.map((row) => {
            const isGlobal = scopeLabel(row) === "global";
            const scopeUi = templateScopePresentation(isGlobal);
            const selected = selectedCaseType?.id === row.id;
            return (
              <button
                key={row.id}
                type="button"
                onClick={() => viewCaseType(row)}
                aria-current={selected ? "true" : undefined}
                className={`w-full border-l-4 p-4 text-left text-sm transition-colors ${
                  selected
                    ? "border-violet-600 bg-violet-50 shadow-[inset_0_0_0_1px_rgba(124,58,237,0.2)] hover:bg-violet-100/80 dark:border-violet-400 dark:bg-violet-950/35 dark:shadow-[inset_0_0_0_1px_rgba(167,139,250,0.25)] dark:hover:bg-violet-950/50"
                    : "border-transparent hover:bg-gray-50 dark:hover:bg-neutral-800/50"
                } cursor-pointer`}
              >
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-x-2">
                    <span className="shrink-0 whitespace-nowrap font-semibold">
                      {row.display_name}
                    </span>
                    <div className="flex min-w-0 flex-1 items-center gap-1.5 text-[11px]">
                      <span
                        className={`shrink-0 whitespace-nowrap rounded-md px-1.5 py-0.5 font-medium ${scopeUi.badge}`}
                        title={scopeUi.hint}
                      >
                        {scopeUi.listBadge}
                      </span>
                      <span
                        className="min-w-0 truncate rounded bg-violet-50 px-1.5 py-0.5 font-mono text-violet-700"
                        title={row.default_skill_slug}
                      >
                        {row.default_skill_slug}
                      </span>
                      <span className="shrink-0 whitespace-nowrap rounded bg-slate-100 px-1.5 py-0.5 text-slate-700 dark:bg-neutral-800 dark:text-neutral-300">
                        {row.status ?? "active"}
                      </span>
                    </div>
                  </div>
                  <div className="mt-1 font-mono text-xs text-gray-500">
                    {row.case_type}
                  </div>
                </div>
                <p className="mt-2 line-clamp-2 text-xs text-gray-500">
                  {row.description}
                </p>
              </button>
            );
          })}
        </div>
      </div>

      <aside
        ref={editorPanelRef}
        className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-900"
      >
        {editing ? (
          <div className="space-y-3">
            <div>
              <h2 className="text-base font-semibold">
                {editing.isNew
                  ? selectedCaseType
                    ? "Crear versión privada"
                    : "Nuevo caso de uso"
                  : "Editar caso de uso"}
              </h2>
              <p className="mt-1 text-sm text-neutral-500">
                {editing.isNew && selectedCaseType
                  ? "Parte de la plantilla global seleccionada y guarda una versión privada para esta cuenta."
                  : "Describe el proceso en lenguaje natural. Gu genera un borrador de formulario y una habilidad privada; puedes ajustar lo avanzado antes de guardar."}
              </p>
            </div>

            <label className="block text-sm">
              <span className="font-medium">Identificador</span>
              <input
                value={editing.case_type}
                onChange={(event) =>
                  setEditing({ ...editing, case_type: event.target.value })
                }
                disabled={!editing.isNew || Boolean(selectedCaseType)}
                placeholder="seguimiento_post_visita"
                className="mt-1 w-full rounded border border-gray-300 px-3 py-2 font-mono text-sm disabled:bg-gray-100"
              />
              {editing.isNew && selectedCaseType ? (
                <p className="mt-1 text-xs leading-relaxed text-gray-500">
                  La versión privada conserva el identificador técnico de la
                  plantilla base. Así esta cuenta puede personalizarla sin
                  modificar la versión global de producto.
                </p>
              ) : null}
            </label>

            <label className="block text-sm">
              <span className="font-medium">Nombre visible</span>
              <input
                value={editing.display_name}
                onChange={(event) =>
                  setEditing({ ...editing, display_name: event.target.value })
                }
                placeholder="Seguimiento post-visita"
                className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm"
              />
            </label>

            <label className="block text-sm">
              <span className="font-medium">Descripción y procedimiento</span>
              <textarea
                value={procedureText}
                onChange={(event) => {
                  setProcedureText(event.target.value);
                  setEditing({ ...editing, description: event.target.value });
                }}
                placeholder="Ej. Cuando un lead visita una propiedad, Gu debe registrar el interés, preparar un mensaje de seguimiento, recordar al asesor si no hay respuesta y escalar si el lead muestra intención de compra."
                className="mt-1 min-h-28 w-full rounded border border-gray-300 px-3 py-2 text-sm"
              />
              <p className="mt-1 text-xs leading-relaxed text-gray-500">
                Puedes escribirla como resumen, pasos o bullets; el sistema la
                usará como base para generar/validar la habilidad.
              </p>
            </label>

            <label className="block text-sm">
              <span className="font-medium">
                Campos iniciales al poner en operación
              </span>
              <textarea
                value={fieldListText}
                onChange={(event) => setFieldListText(event.target.value)}
                placeholder="Uno por línea o separados por coma: nombre del lead, propiedad visitada, interés, canal preferido"
                className="mt-1 min-h-20 w-full rounded border border-gray-300 px-3 py-2 text-sm"
              />
              <p className="mt-1 text-xs leading-relaxed text-gray-500">
                Esto genera el formulario inicial que verás en Casos
                operacionales al poner un caso de uso en operación.
              </p>
            </label>

            <div className="space-y-2">
              <button
                type="button"
                onClick={generateOptimizedDraft}
                disabled={authoring}
                className="w-full rounded border border-violet-700 bg-violet-700 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-800 disabled:cursor-wait disabled:opacity-60"
              >
                {authoring ? "Generando con skill-authoring..." : "Generar con skill-authoring"}
              </button>
              <p className="text-xs leading-relaxed text-gray-500">
                Usa la skill <code className="font-mono">skill-authoring</code>{" "}
                para proponer un SKILL.md optimizado, con rúbrica y evals para
                revisión humana.
              </p>
              {authoring || authoringProgress.length > 0 || authoringResult ? (
                <div className="rounded border border-violet-200 bg-violet-50 p-3 text-xs text-violet-950">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="font-semibold">
                        {authoring
                          ? `Generando con skill-authoring · ${formatElapsed(authoringElapsedMs)}`
                          : authoringResult
                            ? "Generación completada"
                            : "Proceso de generación"}
                      </div>
                      <p className="mt-1 text-violet-800">
                        {authoring
                          ? authoringProgress.at(-1)?.message ??
                            fallbackAuthoringMessage(authoringElapsedMs)
                          : authoringResult?.elapsedMs
                            ? `Listo en ${formatElapsed(authoringResult.elapsedMs)}.`
                            : "Sin proceso activo."}
                      </p>
                      {authoringResult ? (
                        <p className="mt-1 text-violet-800">
                          Intentos usados: {authoringResult.attemptsUsed ?? 1}
                          {authoringResult.metadataTruncated
                            ? " · metadata recuperada parcialmente"
                            : ""}
                        </p>
                      ) : null}
                    </div>
                    {authoring ? (
                      <button
                        type="button"
                        onClick={cancelAuthoring}
                        className="shrink-0 rounded border border-violet-300 bg-white px-2 py-1 font-semibold text-violet-800 hover:bg-violet-100"
                      >
                        Cancelar
                      </button>
                    ) : null}
                  </div>
                  <details
                    open={showAuthoringLog}
                    onToggle={(event) =>
                      setShowAuthoringLog(event.currentTarget.open)
                    }
                    className="mt-2"
                  >
                    <summary className="cursor-pointer font-semibold">
                      Detalle de ejecución
                    </summary>
                    {authoringProgress.length > 0 ? (
                      <ul
                        ref={authoringLogRef}
                        className="mt-2 max-h-44 space-y-1 overflow-auto rounded bg-white/70 p-2 font-mono text-[11px] text-violet-900"
                      >
                        {authoringProgress.map((event, index) => (
                          <li key={`${event.stage ?? event.type}-${index}`}>
                            <span className="text-violet-500">
                              {event.ts
                                ? new Date(event.ts).toLocaleTimeString()
                                : "--:--"}
                            </span>{" "}
                            {event.attempt ? `[intento ${event.attempt}] ` : ""}
                            {event.message ??
                              event.details ??
                              event.error ??
                              event.stage ??
                              event.type}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-2 text-violet-800">
                        Aún no hay eventos técnicos. El timer seguirá corriendo
                        aunque el navegador o proxy no entregue eventos parciales.
                      </p>
                    )}
                  </details>
                </div>
              ) : null}
              <button
                type="button"
                onClick={generateDraft}
                disabled={authoring}
                className="w-full rounded border border-violet-300 bg-violet-50 px-4 py-2 text-sm font-semibold text-violet-800 hover:bg-violet-100"
              >
                Generar borrador básico
              </button>
              <p className="text-xs leading-relaxed text-gray-500">
                Fallback local con heurísticas simples si necesitas una
                estructura inicial rápida o si la generación asistida falla.
              </p>
            </div>

            <label className="block text-sm">
              <span className="font-medium">Skill asociada</span>
              <input
                value={editing.default_skill_slug}
                onChange={(event) =>
                  setEditing({
                    ...editing,
                    default_skill_slug: event.target.value,
                  })
                }
                placeholder="lead-follow-up-draft"
                className="mt-1 w-full rounded border border-gray-300 px-3 py-2 font-mono text-sm"
              />
              <p className="mt-1 text-xs leading-relaxed text-gray-500">
                La habilidad privada se crea/actualiza con este slug si dejas
                activada la opción de abajo. Si reutilizas una existente, debe
                cumplir el formato de skill del sistema.
              </p>
            </label>

            <label className="flex items-start gap-2 rounded border border-gray-200 p-3 text-sm">
              <input
                type="checkbox"
                checked={createPrivateSkill}
                onChange={(event) =>
                  setCreatePrivateSkill(event.target.checked)
                }
                className="mt-1"
              />
              <span>
                Crear o actualizar habilidad privada de la cuenta al guardar.
                <span className="block text-xs text-gray-500">
                  Si ya existe una habilidad privada con este slug, se carga en
                  la caja Habilidad y se actualiza al guardar.
                </span>
              </span>
            </label>

            <div className="grid grid-cols-2 gap-3">
              <label className="block text-sm">
                <span className="font-medium">Estado</span>
                <select
                  value={editing.status}
                  onChange={(event) =>
                    setEditing({
                      ...editing,
                      status: event.target.value as OperationalCaseTypeStatus,
                    })
                  }
                  className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm"
                >
                  <option value="draft">Borrador</option>
                  <option value="active">Activo</option>
                  <option value="archived">Archivado</option>
                </select>
                <p className="mt-1 text-xs leading-relaxed text-gray-500">
                  Activo aparece para poner en operación. Borrador permite
                  guardar sin publicarlo todavía. Archivado lo oculta del flujo
                  normal sin borrar la definición.
                </p>
              </label>

              <label className="block text-sm">
                <span className="font-medium">Visibilidad</span>
                <select
                  value={editing.visibility}
                  onChange={() =>
                    setEditing({ ...editing, visibility: "private" })
                  }
                  className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm"
                >
                  <option value="private">private</option>
                </select>
                <p className="mt-1 text-xs leading-relaxed text-gray-500">
                  V1 crea casos de uso privados. Compartir con usuarios
                  específicos o publicar como global requiere un flujo de
                  permisos separado.
                </p>
              </label>
            </div>

            <details
              open={showAdvanced}
              onToggle={(event) =>
                setShowAdvanced(event.currentTarget.open)
              }
              className="rounded border border-gray-200 p-3"
            >
              <summary className="cursor-pointer text-sm font-semibold">
                {showAdvanced ? "Ocultar avanzado" : "Mostrar avanzado"}:
                formulario JSON y habilidad
              </summary>
              <p className="mt-2 text-xs leading-relaxed text-gray-500">
                Usa esta sección para revisar o ajustar la definición exacta que
                guardará el sistema. El formulario JSON y la habilidad se validan
                al guardar.
              </p>
              <label className="mt-3 block text-sm">
                <span className="font-medium">Formulario inicial JSON</span>
                <textarea
                  value={schemaText}
                  onChange={(event) => setSchemaText(event.target.value)}
                  className="mt-1 h-56 w-full rounded border border-gray-300 p-2 font-mono text-xs"
                />
              </label>
              <label className="mt-3 block text-sm">
                <span className="font-medium">Habilidad</span>
                <textarea
                  value={generatedSkillBody}
                  onChange={(event) => setGeneratedSkillBody(event.target.value)}
                  className="mt-1 h-64 w-full rounded border border-gray-300 p-2 font-mono text-xs"
                  placeholder="La habilidad guardada o generada aparecerá aquí."
                />
                <p className="mt-1 text-xs leading-relaxed text-gray-500">
                  Muestra el SKILL.md privado guardado para esta cuenta o el
                  contenido recién generado antes de guardar.{" "}
                  `includes` lista skills reutilizadas por esta habilidad
                  compuesta. `allowed_tools` lista herramientas directas de esta
                  habilidad; si todo se delega a skills incluidas, puede quedar
                  vacío. `guardrails` son reglas operativas que siempre se
                  aplican al ejecutar la habilidad.
                </p>
              </label>
              {authoringResult ? (
                <div className="mt-3 space-y-3 rounded border border-violet-200 bg-violet-50 p-3 text-xs text-violet-950">
                  <div>
                    <div className="font-semibold">Rúbrica de validación</div>
                    {authoringResult.validationRubric.length > 0 ? (
                      <ul className="mt-1 list-disc space-y-1 pl-5">
                        {authoringResult.validationRubric.map((item, index) => (
                          <li key={`${item.item ?? "item"}-${index}`}>
                            <span className="font-semibold">
                              {item.status ?? "WARN"}
                            </span>
                            {item.item ? ` · ${item.item}` : ""}
                            {item.note ? `: ${item.note}` : ""}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-1">Sin rúbrica estructurada.</p>
                    )}
                  </div>
                  {authoringResult.activationRecommendation ? (
                    <div>
                      <div className="font-semibold">
                        Recomendación de activación
                      </div>
                      <p className="mt-1">
                        {authoringResult.activationRecommendation}
                      </p>
                    </div>
                  ) : null}
                  {saveBlockedByAuthoring ? (
                    <p className="rounded border border-red-200 bg-red-50 p-2 text-red-800">
                      No se puede guardar una habilidad activa mientras la
                      rúbrica tenga FAIL. Corrige el borrador y vuelve a
                      generarlo/validarlo.
                    </p>
                  ) : authoringHasWarn ? (
                    <p className="rounded border border-amber-200 bg-amber-50 p-2 text-amber-800">
                      Hay advertencias en la rúbrica. Puedes guardar, pero
                      conviene revisarlas antes de activar este caso de uso.
                    </p>
                  ) : null}
                </div>
              ) : null}
            </details>

            {error ? (
              <pre className="whitespace-pre-wrap rounded bg-red-50 p-3 text-xs text-red-800">
                {error}
              </pre>
            ) : null}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setEditing(null);
                  setEditingBaseline(null);
                }}
                className="rounded border border-gray-300 px-4 py-2 text-sm hover:bg-gray-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={save}
                disabled={saving || saveBlockedByAuthoring || !editingHasChanges}
                className="rounded bg-violet-700 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-800 disabled:opacity-50"
              >
                {saving
                  ? "Guardando..."
                  : editingHasChanges
                    ? "Guardar"
                    : "Sin cambios"}
              </button>
            </div>
          </div>
        ) : selectedCaseType ? (
          renderCaseTypeDetail(selectedCaseType)
        ) : (
          <div className="text-sm text-neutral-500">
            Selecciona un caso de uso para ver su detalle o crea uno nuevo. Las
            plantillas globales son solo de lectura, pero puedes crear una
            versión privada para esta cuenta.
          </div>
        )}
      </aside>
    </section>
  );
}
