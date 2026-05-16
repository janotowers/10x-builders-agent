"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  OperationalCaseIntakeField,
  OperationalCaseReminderPolicy,
  OperationalCaseType,
  OperationalCaseTypeStatus,
  OperationalCaseTypeVisibility,
} from "@agents/types";

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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const authoringRequestSeq = useRef(0);
  const authoringAbortRef = useRef<AbortController | null>(null);
  const authoringLogRef = useRef<HTMLUListElement | null>(null);

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
  const authoringHasFail = authoringHasStatus(authoringResult, "FAIL");
  const authoringHasWarn = authoringHasStatus(authoringResult, "WARN");
  const saveBlockedByAuthoring =
    createPrivateSkill && generatedSkillBody.trim().length > 0 && authoringHasFail;

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
        const res = await fetch("/api/operational-case-types", {
          cache: "no-store",
        });
        const data = (await res.json()) as
          | { ok: true; caseTypes: OperationalCaseType[] }
          | { error: string };
        if (cancelled || !res.ok || !("ok" in data)) return;
        setCaseTypes(data.caseTypes);
        setSelectedCaseType((current) => {
          if (!current) return current;
          return data.caseTypes.find((row) => row.id === current.id) ?? null;
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

  function startEdit(row: OperationalCaseType) {
    const value = caseTypeToEditing(row);
    const editableDescription = descriptionForEditing(value.description);
    setSelectedCaseType(row);
    setEditing({ ...value, description: editableDescription });
    setSchemaText(JSON.stringify(value.intake_schema_jsonb, null, 2));
    setProcedureText(editableDescription);
    setFieldListText(
      value.intake_schema_jsonb.map((field) => field.label).join("\n")
    );
    setCreatePrivateSkill(false);
    setGeneratedSkillBody("");
    setAuthoringResult(null);
    setShowAdvanced(false);
    setError(null);
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
    setSelectedCaseType(row);
    setEditing({
      ...value,
      description: editableDescription,
      visibility: "private",
      isNew: true,
    });
    setSchemaText(JSON.stringify(value.intake_schema_jsonb, null, 2));
    setProcedureText(editableDescription);
    setFieldListText(
      value.intake_schema_jsonb.map((field) => field.label).join("\n")
    );
    setCreatePrivateSkill(true);
    setGeneratedSkillBody(skillBody);
    setAuthoringResult(null);
    setShowAdvanced(false);
    setError(null);
  }

  function startNew() {
    const value = newCaseType();
    setSelectedCaseType(null);
    setEditing(value);
    setSchemaText(JSON.stringify(value.intake_schema_jsonb, null, 2));
    setProcedureText("");
    setFieldListText("Título\nNotas iniciales");
    setCreatePrivateSkill(true);
    setGeneratedSkillBody("");
    setAuthoringResult(null);
    setShowAdvanced(false);
    setError(null);
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
              Editar caso de uso
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
                onClick={() => (isGlobal ? viewCaseType(row) : startEdit(row))}
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

      <aside className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
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
                Fallback local con heurísticas simples si solo quieres una
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
                  V1 genera una habilidad básica; luego podremos reemplazar esta
                  heurística por una generación con Gu.
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
                formulario JSON y habilidad generada
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
                <span className="font-medium">Borrador de habilidad</span>
                <textarea
                  value={generatedSkillBody}
                  onChange={(event) => setGeneratedSkillBody(event.target.value)}
                  className="mt-1 h-64 w-full rounded border border-gray-300 p-2 font-mono text-xs"
                  placeholder="Pulsa 'Generar borrador' para crear una habilidad privada básica."
                />
                <p className="mt-1 text-xs leading-relaxed text-gray-500">
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
                onClick={() => setEditing(null)}
                className="rounded border border-gray-300 px-4 py-2 text-sm hover:bg-gray-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={save}
                disabled={saving || saveBlockedByAuthoring}
                className="rounded bg-violet-700 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-800 disabled:opacity-50"
              >
                {saving ? "Guardando..." : "Guardar"}
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
