/**
 * Tools cuyo handler LangChain crea y finaliza su propia fila en tool_calls.
 * El grafo NO debe crear una fila previa (approved) antes de invoke() — eso
 * duplicaba la auditoría en pruebas N3 con auto_execute (p. ej.
 * generate_document_from_template aparecía dos veces: executed + deduplicated).
 */
const TOOLS_WITHOUT_INTERNAL_AUDIT = new Set([
  "get_user_preferences",
  "list_enabled_tools",
]);

export function toolOwnsAuditTrail(toolId: string): boolean {
  return !TOOLS_WITHOUT_INTERNAL_AUDIT.has(toolId);
}
