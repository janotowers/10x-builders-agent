"use client";

import { useFormStatus } from "react-dom";
import { forkDefinitionAction } from "./actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-xs font-semibold hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
    >
      {pending ? "Creando…" : "Crear versión propia"}
    </button>
  );
}

export function ForkButton({ definitionId }: { definitionId: string }) {
  return (
    <form
      action={forkDefinitionAction}
      onSubmit={(event) => {
        if (
          !window.confirm(
            "Se creará un borrador privado editable a partir de esta versión. ¿Continuar?"
          )
        ) {
          event.preventDefault();
        }
      }}
      className="inline-flex flex-wrap items-center gap-2"
    >
      <input type="hidden" name="definition_id" value={definitionId} />
      <SubmitButton />
      <span className="text-[10px] text-neutral-400">
        Copia esta versión como borrador editable en Diseño; nunca adopta
        cambios posteriores del original.
      </span>
    </form>
  );
}
