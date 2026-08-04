"use client";

import { useId, useState, type ReactNode } from "react";

/**
 * Fila expandible accesible para el detalle del Studio.
 * Preferida sobre tooltips: funciona en móvil, teclado y lectores de pantalla.
 */
export function ExpandableItem({
  summary,
  details,
  defaultOpen = false,
}: {
  summary: ReactNode;
  details: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();

  return (
    <div className="rounded-md border border-transparent hover:border-neutral-200 dark:hover:border-neutral-700">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-start gap-2 rounded-md px-1.5 py-1 text-left text-xs hover:bg-neutral-50 dark:hover:bg-neutral-800/60"
      >
        <span
          aria-hidden
          className={`mt-0.5 shrink-0 text-[10px] text-neutral-400 transition ${
            open ? "rotate-90" : ""
          }`}
        >
          ▸
        </span>
        <span className="min-w-0 flex-1">{summary}</span>
      </button>
      {open ? (
        <div
          id={panelId}
          className="mt-0.5 space-y-1 border-l border-neutral-200 pb-1.5 pl-4 ml-3 text-[11px] leading-relaxed text-neutral-600 dark:border-neutral-700 dark:text-neutral-300"
        >
          {details}
        </div>
      ) : null}
    </div>
  );
}
