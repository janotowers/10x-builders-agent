"use client";

import { useFormStatus } from "react-dom";
import { discardDraftDefinitionAction } from "./actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:bg-neutral-900 dark:text-red-300 dark:hover:bg-red-950/40"
    >
      {pending ? "Descartando…" : "Descartar borrador"}
    </button>
  );
}

export function DiscardButton({ definitionId }: { definitionId: string }) {
  return (
    <form
      action={discardDraftDefinitionAction}
      onSubmit={(event) => {
        if (
          !window.confirm(
            "Se eliminará este borrador de forma permanente. Esta acción no se puede deshacer. ¿Continuar?"
          )
        ) {
          event.preventDefault();
        }
      }}
      className="inline-flex"
    >
      <input type="hidden" name="definition_id" value={definitionId} />
      <SubmitButton />
    </form>
  );
}
