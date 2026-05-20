"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  OperationalCaseIntakeField,
  OperationalCaseIntakeOption,
  OperationalCaseType,
} from "@agents/types";

type FormAction = (formData: FormData) => void | Promise<void>;

function intakeSchema(type: OperationalCaseType): OperationalCaseIntakeField[] {
  return Array.isArray(type.intake_schema_jsonb)
    ? type.intake_schema_jsonb
    : [];
}

function optionValue(option: string | OperationalCaseIntakeOption) {
  return typeof option === "string" ? option : option.value;
}

function optionLabel(option: string | OperationalCaseIntakeOption) {
  return typeof option === "string" ? option : (option.label ?? option.value);
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
            <option key={optionValue(option)} value={optionValue(option)}>
              {optionLabel(option)}
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

  if (field.type === "multi_select") {
    return (
      <>
        <div className="mt-1 flex flex-wrap gap-2 rounded-md border border-neutral-300 bg-neutral-50 p-2 dark:border-neutral-700 dark:bg-neutral-950">
          {(field.options ?? []).map((option) => {
            const value = optionValue(option);
            return (
              <label
                key={value}
                className="inline-flex items-center gap-1 rounded bg-white px-2 py-1 text-xs dark:bg-neutral-900"
              >
                <input
                  type="checkbox"
                  name={`context_${field.name}`}
                  value={value}
                  required={false}
                />
                {optionLabel(option)}
              </label>
            );
          })}
        </div>
        {helperText ? (
          <p className="mt-1 text-xs leading-relaxed text-neutral-500">
            {helperText}
          </p>
        ) : null}
      </>
    );
  }

  const isNumber = field.type === "number";
  return (
    <>
      <input
        name={`context_${field.name}`}
        type={isNumber ? "number" : "text"}
        inputMode={isNumber ? "decimal" : undefined}
        min={isNumber ? (field.min ?? 0) : field.min}
        max={field.max}
        step={isNumber ? (field.step ?? 1) : field.step}
        required={field.required}
        placeholder={placeholder}
        onWheel={
          isNumber ? (event) => event.currentTarget.blur() : undefined
        }
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
        Crea una instancia concreta del caso de uso. Estos datos pertenecen a
        este caso específico (no se guardan en el caso de uso como plantilla).
      </p>
      <p className="mt-2 text-xs leading-relaxed text-neutral-500">
        Vía recomendada para el día a día: arrancar el caso por chat o
        Telegram (por ejemplo &ldquo;necesito opcionar una propiedad&rdquo;) y
        el agente pide los datos en conversación. Esta pantalla sirve para
        validar el flujo o crear un caso manualmente cuando el canal
        conversacional no está disponible.
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
          fields.map((field) => {
            // multi_select renderiza <label> por cada checkbox, por lo que el
            // contenedor exterior debe ser <div> (anidar <label> es HTML inválido
            // y provoca toggles dobles al hacer click).
            const Wrapper = field.type === "multi_select" ? "div" : "label";
            return (
              <Wrapper key={field.name} className="block text-sm">
                <span className="font-medium">{field.label}</span>
                {fieldInput(field)}
              </Wrapper>
            );
          })
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
