/**
 * Identificador técnico uniforme (estado, habilidad, condición, etc.).
 * Misma tipografía/tamaño en todo el detalle del Studio.
 */
export function TechId({
  kind,
  value,
}: {
  /** Prefijo visible en español; omitir si solo se muestra el chip. */
  kind?:
    | "Estado"
    | "Habilidad"
    | "Condición"
    | "Verificación"
    | "Aprobación"
    | "Evidencia"
    | "Tipo"
    | "Hash";
  value: string;
}) {
  const wrapLong = kind === "Hash";
  return (
    <span className="inline-flex max-w-full flex-wrap items-baseline gap-1 align-baseline">
      {kind ? (
        <span className="text-[10px] font-medium uppercase tracking-wide text-neutral-400">
          {kind}
        </span>
      ) : null}
      <code
        className={`inline-block max-w-full rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-[10px] leading-4 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 ${
          wrapLong ? "break-all whitespace-normal" : "truncate"
        }`}
      >
        {value}
      </code>
    </span>
  );
}
