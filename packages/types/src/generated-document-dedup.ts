/**
 * Clave lógica para deduplicar renders de documento en el mismo turno.
 * No compara el objeto `data` completo: el modelo suele variar campos u orden.
 */

export type GeneratedDocumentDedupOptions = {
  /** Cuando el modelo omite `case_id` en args, usar el caso activo del turno. */
  caseIdFallback?: string | null;
};

export function normalizeGeneratedDocumentArgs(
  args: Record<string, unknown>,
  options?: GeneratedDocumentDedupOptions
): Record<string, unknown> {
  const caseId = String(args.case_id ?? options?.caseIdFallback ?? "").trim();
  return {
    ...args,
    ...(caseId ? { case_id: caseId } : {}),
  };
}

export function generatedDocumentDedupKey(
  args: Record<string, unknown>,
  options?: GeneratedDocumentDedupOptions
): string {
  const normalized = normalizeGeneratedDocumentArgs(args, options);
  const slug = String(normalized.template_slug ?? "")
    .trim()
    .toLowerCase();
  const format = normalized.format === "pdf" ? "pdf" : "docx";
  const caseId = String(normalized.case_id ?? "").trim();
  return `${slug}|${format}|${caseId}`;
}

export function generatedDocumentInputsMatch(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
  options?: GeneratedDocumentDedupOptions
): boolean {
  return (
    generatedDocumentDedupKey(left, options) ===
    generatedDocumentDedupKey(right, options)
  );
}
