"use client";

import { useMemo, useState } from "react";
import type {
  OperationalCaseIntakeField,
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
  isNew: boolean;
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

function buildSkillBody(params: {
  slug: string;
  displayName: string;
  description: string;
  procedureText: string;
  fields: OperationalCaseIntakeField[];
}) {
  const procedure =
    params.procedureText.trim() ||
    "Describe el procedimiento operativo que debe seguir Gu para este caso de uso.";
  const fieldLines = params.fields
    .map((field) => `- ${field.label} (${field.name})`)
    .join("\n");

  return `---
name: ${params.slug}
description: ${yamlString(params.description || `Guía operativa para ${params.displayName}.`)}
scope: business
allowed_tools: []
includes: []
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

export function OperationalCaseTypesClient({
  initialCaseTypes,
}: {
  initialCaseTypes: OperationalCaseType[];
}) {
  const [caseTypes, setCaseTypes] =
    useState<OperationalCaseType[]>(initialCaseTypes);
  const [editing, setEditing] = useState<EditingCaseType | null>(null);
  const [schemaText, setSchemaText] = useState("");
  const [procedureText, setProcedureText] = useState("");
  const [fieldListText, setFieldListText] = useState("");
  const [createPrivateSkill, setCreatePrivateSkill] = useState(true);
  const [generatedSkillBody, setGeneratedSkillBody] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sortedCaseTypes = useMemo(
    () =>
      [...caseTypes].sort((a, b) => {
        const aGlobal = scopeLabel(a) === "global" ? 1 : 0;
        const bGlobal = scopeLabel(b) === "global" ? 1 : 0;
        return aGlobal - bGlobal || a.display_name.localeCompare(b.display_name);
      }),
    [caseTypes]
  );

  function startEdit(row: OperationalCaseType) {
    const value = caseTypeToEditing(row);
    setEditing(value);
    setSchemaText(JSON.stringify(value.intake_schema_jsonb, null, 2));
    setProcedureText(row.description ?? "");
    setFieldListText(
      value.intake_schema_jsonb.map((field) => field.label).join("\n")
    );
    setCreatePrivateSkill(false);
    setGeneratedSkillBody("");
    setShowAdvanced(false);
    setError(null);
  }

  function startNew() {
    const value = newCaseType();
    setEditing(value);
    setSchemaText(JSON.stringify(value.intake_schema_jsonb, null, 2));
    setProcedureText("");
    setFieldListText("Título\nNotas iniciales");
    setCreatePrivateSkill(true);
    setGeneratedSkillBody("");
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
      })
    );
    setShowAdvanced(true);
    setError(null);
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
      setEditing(null);
    } catch (err) {
      setError((err as Error).message ?? String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_420px]">
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
            return (
              <div key={row.id} className="p-4 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="font-semibold">{row.display_name}</div>
                    <div className="mt-1 font-mono text-xs text-gray-500">
                      {row.case_type}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5 text-[11px]">
                    <span className="rounded bg-violet-50 px-1.5 py-0.5 font-mono text-violet-700">
                      {row.default_skill_slug}
                    </span>
                    <span className="rounded bg-gray-100 px-1.5 py-0.5 text-gray-600">
                      plantilla: {scopeLabel(row) === "global" ? "producto" : "cuenta"}
                    </span>
                    <span className="rounded bg-gray-100 px-1.5 py-0.5 text-gray-600">
                      {row.status ?? "active"}
                    </span>
                  </div>
                </div>
                <p className="mt-2 line-clamp-2 text-xs text-gray-500">
                  {row.description}
                </p>
                <div className="mt-3 flex justify-end">
                  <button
                    type="button"
                    onClick={() => startEdit(row)}
                    disabled={isGlobal}
                    className="rounded border border-gray-300 px-3 py-1 text-xs hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                    title={
                      isGlobal
                        ? "Las plantillas globales se duplicarán en una versión posterior."
                        : undefined
                    }
                  >
                    {isGlobal ? "Global (solo lectura)" : "Editar"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <aside className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
        {editing ? (
          <div className="space-y-3">
            <div>
              <h2 className="text-base font-semibold">
                {editing.isNew ? "Nuevo caso de uso" : "Editar caso de uso"}
              </h2>
              <p className="mt-1 text-sm text-neutral-500">
                Describe el proceso en lenguaje natural. Gu genera un borrador
                de formulario y una habilidad privada; puedes ajustar lo
                avanzado antes de guardar.
              </p>
            </div>

            <label className="block text-sm">
              <span className="font-medium">Identificador</span>
              <input
                value={editing.case_type}
                onChange={(event) =>
                  setEditing({ ...editing, case_type: event.target.value })
                }
                disabled={!editing.isNew}
                placeholder="seguimiento_post_visita"
                className="mt-1 w-full rounded border border-gray-300 px-3 py-2 font-mono text-sm disabled:bg-gray-100"
              />
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
              <span className="font-medium">Describe el procedimiento</span>
              <textarea
                value={procedureText}
                onChange={(event) => setProcedureText(event.target.value)}
                placeholder="Ej. Cuando un lead visita una propiedad, Gu debe registrar el interés, preparar un mensaje de seguimiento, recordar al asesor si no hay respuesta y escalar si el lead muestra intención de compra."
                className="mt-1 min-h-28 w-full rounded border border-gray-300 px-3 py-2 text-sm"
              />
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

            <button
              type="button"
              onClick={generateDraft}
              className="w-full rounded border border-violet-300 bg-violet-50 px-4 py-2 text-sm font-semibold text-violet-800 hover:bg-violet-100"
            >
              Generar borrador desde la descripción
            </button>

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
                activada la opción de abajo.
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
                  <option value="draft">draft</option>
                  <option value="active">active</option>
                  <option value="archived">archived</option>
                </select>
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

            <label className="block text-sm">
              <span className="font-medium">Descripción</span>
              <textarea
                value={editing.description}
                onChange={(event) =>
                  setEditing({ ...editing, description: event.target.value })
                }
                className="mt-1 min-h-20 w-full rounded border border-gray-300 px-3 py-2 text-sm"
              />
            </label>

            <details
              open={showAdvanced}
              onToggle={(event) =>
                setShowAdvanced(event.currentTarget.open)
              }
              className="rounded border border-gray-200 p-3"
            >
              <summary className="cursor-pointer text-sm font-semibold">
                Avanzado: formulario JSON y habilidad generada
              </summary>
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
              </label>
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
                disabled={saving}
                className="rounded bg-violet-700 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-800 disabled:opacity-50"
              >
                {saving ? "Guardando..." : "Guardar"}
              </button>
            </div>
          </div>
        ) : (
          <div className="text-sm text-neutral-500">
            Selecciona un caso de uso propio para editarlo o crea uno nuevo. Las
            plantillas globales aparecen como solo lectura por ahora.
          </div>
        )}
      </aside>
    </section>
  );
}
