"use client";

/**
 * Formulario "Describir → compilar" del Studio (Slice 4.2-4).
 *
 * Maneja las rondas de aclaración del compilador (§14: acotadas a 3): cuando
 * el modelo devuelve preguntas en vez de draft, se muestran y el operador
 * responde en el mismo formulario; la descripción original viaja intacta.
 * El éxito redirige al detalle del draft (lo hace la server action).
 */

import { useActionState } from "react";
import {
  compileDescriptionAction,
  type CompileFormState,
} from "../actions";

const INITIAL_STATE: CompileFormState = {
  status: "idle",
  round: 0,
  description: "",
  caseType: "",
  answers: [],
};

export function CompileForm({ knownCaseTypes }: { knownCaseTypes: string[] }) {
  const [state, formAction, pending] = useActionState(
    compileDescriptionAction,
    INITIAL_STATE
  );
  const inClarification = state.status === "clarification";

  return (
    <form
      action={formAction}
      className="space-y-3 rounded-2xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900"
    >
      <div>
        <h3 className="text-sm font-semibold">Describir un flujo nuevo</h3>
        <p className="mt-0.5 text-xs text-neutral-500">
          Describe en tus palabras qué debe hacer el flujo. El compilador
          produce la especificación y un borrador que pasa por validación y
          simulación antes de poder publicarse.
        </p>
      </div>

      <label className="block text-xs">
        <span className="font-medium text-neutral-600 dark:text-neutral-300">
          Tipo de caso
        </span>
        <input
          key={`case-${state.round}`}
          name="case_type"
          list="known-case-types"
          defaultValue={state.caseType}
          placeholder="p. ej. property_optioning"
          className="mt-1 w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-xs dark:border-neutral-700 dark:bg-neutral-950"
          readOnly={inClarification}
        />
        <datalist id="known-case-types">
          {knownCaseTypes.map((caseType) => (
            <option key={caseType} value={caseType} />
          ))}
        </datalist>
      </label>

      <label className="block text-xs">
        <span className="font-medium text-neutral-600 dark:text-neutral-300">
          Descripción del flujo
        </span>
        <textarea
          key={`desc-${state.round}`}
          name="description"
          rows={5}
          defaultValue={state.description}
          placeholder="Cuando un propietario nos comparte una propiedad, hay que valuar, proponer precio, obtener su aprobación y publicar…"
          className="mt-1 w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-xs dark:border-neutral-700 dark:bg-neutral-950"
          readOnly={inClarification}
        />
      </label>

      {inClarification ? (
        <div className="space-y-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs dark:border-amber-700 dark:bg-amber-950/40">
          <p className="font-semibold text-amber-800 dark:text-amber-200">
            El compilador necesita aclarar (ronda {state.round} de 3):
          </p>
          <ul className="list-disc space-y-1 pl-4 text-amber-800 dark:text-amber-200">
            {state.questions?.map((question) => (
              <li key={question}>{question}</li>
            ))}
          </ul>
          <label className="block">
            <span className="font-medium">Tus respuestas</span>
            <textarea
              name="clarification_answer"
              rows={3}
              className="mt-1 w-full rounded-md border border-amber-300 bg-white px-2 py-1.5 dark:border-amber-700 dark:bg-neutral-950"
            />
          </label>
        </div>
      ) : null}

      {state.status === "error" ? (
        <p className="rounded-md bg-red-50 px-2 py-1.5 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">
          {state.error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-violet-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-800 disabled:opacity-50"
      >
        {pending
          ? "Compilando…"
          : inClarification
            ? "Responder y recompilar"
            : "Compilar borrador"}
      </button>
    </form>
  );
}
