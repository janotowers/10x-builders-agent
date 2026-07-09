/**
 * Estilos de jerarquía visual del laboratorio (paso → habilidad → tool).
 * Los niveles N0–N4 son nomenclatura de documentación/API; la UI usa color y
 * rótulos («HABILIDAD», «Herramientas / acciones»), no chips N1/N3.
 * Doc: docs/operational-cases/testing-framework.md § UI v1.1
 */

export const READINESS_LAB_STEP_SHELL =
  "rounded-xl border-2 border-indigo-100/90 bg-neutral-50/90 p-3 shadow-sm dark:border-indigo-900/50 dark:bg-neutral-950";

export const READINESS_LAB_STEP_BADGE =
  "inline-flex rounded-full bg-indigo-100 px-2 py-0.5 text-[11px] font-semibold text-indigo-900 dark:bg-indigo-950/60 dark:text-indigo-200";

export const READINESS_LAB_STEP_BODY =
  "mt-3 space-y-3 border-t border-indigo-100/70 pt-3 dark:border-indigo-900/40";

export const READINESS_LAB_SKILL_SHELL =
  "rounded-lg border border-violet-100 bg-white p-3 border-l-4 border-l-violet-300 dark:border-violet-900/40 dark:border-l-violet-600 dark:bg-neutral-900";

export const READINESS_LAB_SKILL_LABEL =
  "text-[11px] font-semibold uppercase tracking-wide text-violet-700 dark:text-violet-300";

export const READINESS_LAB_TOOLS_SECTION =
  "mt-4 space-y-2 border-t border-violet-50 pt-3 pl-3 border-l-2 border-violet-100 dark:border-violet-900/30";

export const READINESS_LAB_STEP_TOOLS_SECTION =
  "space-y-2 rounded-lg border border-neutral-200 bg-white p-3 pl-4 border-l-4 border-l-slate-300 dark:border-neutral-700 dark:border-l-slate-600 dark:bg-neutral-900";

export const READINESS_LAB_TOOLS_LABEL =
  "text-[11px] font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-400";

export const READINESS_LAB_TOOL_CARD_WRAP = "space-y-1";

export type ReadinessLabToolShellStatus =
  | "ready"
  | "needs_config"
  | "stub"
  | "missing"
  | string;

/** Tarjeta N1: fondo neutro; el acento de color va en el borde izquierdo y pills. */
export function readinessLabToolShellClass(
  status: ReadinessLabToolShellStatus
): string {
  const base =
    "rounded border border-neutral-200 bg-white p-2 text-neutral-800 border-l-4 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100";
  if (status === "ready") {
    return `${base} border-l-emerald-400 dark:border-l-emerald-600`;
  }
  if (status === "needs_config") {
    return `${base} border-l-amber-400 dark:border-l-amber-600`;
  }
  if (status === "stub") {
    return `${base} border-l-sky-400 dark:border-l-sky-600`;
  }
  if (status === "missing") {
    return `${base} border-l-red-400 dark:border-l-red-600`;
  }
  return `${base} border-l-neutral-300 dark:border-l-neutral-600`;
}

export const READINESS_LAB_TOOL_TEST_TOGGLE =
  "flex w-full cursor-pointer items-start gap-1.5 rounded border border-slate-200/90 bg-slate-50/80 p-1.5 text-left text-[11px] text-slate-950 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900/50 dark:text-slate-100";

export const READINESS_LAB_TOOL_TEST_TOGGLE_TITLE =
  "font-semibold text-slate-900 dark:text-slate-100";

export const READINESS_LAB_TOOL_TEST_TOGGLE_HINT =
  "mt-0.5 block font-normal text-slate-600 dark:text-slate-400";
