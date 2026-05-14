"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  OperationalCaseIntakeField,
  OperationalCaseType,
} from "@agents/types";

type FormAction = (formData: FormData) => void | Promise<void>;

function intakeSchema(type: OperationalCaseType): OperationalCaseIntakeField[] {
  return Array.isArray(type.intake_schema_jsonb)
    ? type.intake_schema_jsonb
    : [];
}

function fieldInput(field: OperationalCaseIntakeField) {
  const baseClass =
    "mt-1 w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950";
  const helperText =
    field.help_text ??
    (field.placeholder && field.placeholder.length > 42
      ? field.placeholder
      : undefined);
  const placeholder =
    field.placeholder && field.placeholder.length > 42
      ? undefined
      : field.placeholder;

  if (field.type === "textarea") {
    return (
      <>
        <textarea
          name={`context_${field.name}`}
          required={field.required}
          placeholder={placeholder}
          className={`${baseClass} min-h-24`}
        />
        {helperText ? (
          <p className="mt-1 text-xs leading-relaxed text-neutral-500">
            {helperText}
          </p>
        ) : null}
      </>
    );
  }

  if (field.type === "select") {
    return (
      <>
        <select
          name={`context_${field.name}`}
          required={field.required}
          className={baseClass}
          defaultValue=""
        >
          <option value="">Selecciona una opción</option>
          {(field.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        {helperText ? (
          <p className="mt-1 text-xs leading-relaxed text-neutral-500">
            {helperText}
          </p>
        ) : null}
      </>
    );
  }

  return (
    <>
      <input
        name={`context_${field.name}`}
        type="text"
        inputMode={field.type === "number" ? "numeric" : undefined}
        required={field.required}
        placeholder={placeholder}
        className={baseClass}
      />
      {helperText ? (
        <p className="mt-1 text-xs leading-relaxed text-neutral-500">
          {helperText}
        </p>
      ) : null}
    </>
  );
}

export function CreateCasePanel({
  caseTypes,
  action,
}: {
  caseTypes: OperationalCaseType[];
  action: FormAction;
}) {
  const activeTypes = useMemo(
    () => caseTypes.filter((type) => (type.status ?? "active") === "active"),
    [caseTypes]
  );
  const [selectedCaseTypeId, setSelectedCaseTypeId] = useState(
    activeTypes[0]?.id ?? ""
  );
  const selected = activeTypes.find(
    (type) => type.id === selectedCaseTypeId
  );
  const fields = selected ? intakeSchema(selected) : [];
  const formRef = useRef<HTMLFormElement>(null);
  const [canSubmit, setCanSubmit] = useState(false);

  function refreshValidity() {
    const form = formRef.current;
    setCanSubmit(Boolean(form?.checkValidity()));
  }

  useEffect(() => {
    const id = requestAnimationFrame(refreshValidity);
    return () => cancelAnimationFrame(id);
  }, [selectedCaseTypeId, fields.length]);

  return (
    <section className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
      <h2 className="text-base font-semibold">
        Poner caso de uso en operación
      </h2>
      <p className="mt-1 text-sm text-neutral-500">
        Elige un caso de uso y captura su información inicial. El formulario se
        genera desde el schema del caso de uso.
      </p>
      <form
        ref={formRef}
        action={action}
        className="mt-4 space-y-3"
        onInput={refreshValidity}
        onChange={refreshValidity}
      >
        <label className="block text-sm">
          <span className="font-medium">Caso de uso</span>
          <select
            name="case_type_id"
            required
            value={selectedCaseTypeId}
            onChange={(event) => setSelectedCaseTypeId(event.target.value)}
            className="mt-1 w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950"
          >
            {activeTypes.map((type) => (
              <option key={type.id} value={type.id}>
                {type.display_name}
                {type.user_id ? " (cuenta)" : ""}
              </option>
            ))}
          </select>
        </label>

        <input name="current_step" type="hidden" value="intake" />
        <input
          name="intake_field_names"
          type="hidden"
          value={fields.map((field) => field.name).join(",")}
        />

        {fields.length === 0 ? (
          <p className="rounded-lg border border-dashed border-neutral-300 p-3 text-sm text-neutral-500 dark:border-neutral-700">
            Este caso de uso no tiene formulario inicial configurado.
          </p>
        ) : (
          fields.map((field) => (
            <label key={field.name} className="block text-sm">
              <span className="font-medium">{field.label}</span>
              {fieldInput(field)}
            </label>
          ))
        )}

        <button
          type="submit"
          disabled={!selected || !canSubmit}
          className="w-full rounded-md bg-violet-700 px-3 py-2 text-sm font-semibold text-white hover:bg-violet-800 disabled:cursor-not-allowed disabled:opacity-60"
        >
          Poner en operación
        </button>
      </form>
    </section>
  );
}
