/**
 * Repara confirmaciones HITL huérfanas de una sesión web al rehidratar.
 * No borra filas: marca como rejected con razón auditable.
 */

export type SessionPendingToolCallRow = {
  id: string;
  tool_name: string;
  arguments_json?: Record<string, unknown> | null;
  metadata_jsonb?: Record<string, unknown> | null;
  created_at: string;
  turn_id?: string | null;
};

export function caseIdFromPendingToolCall(
  row: SessionPendingToolCallRow
): string | null {
  const args = row.arguments_json;
  const meta = row.metadata_jsonb;
  if (args && typeof args.case_id === "string" && args.case_id.trim()) {
    return args.case_id.trim();
  }
  if (meta && typeof meta.case_id === "string" && meta.case_id.trim()) {
    return meta.case_id.trim();
  }
  return null;
}

/**
 * Entre varios pending de la sesión, conserva solo el más reciente y devuelve
 * los ids antiguos a marcar como superados. Una sola tarjeta activa en UI.
 */
export function selectStaleSessionPendingIds(
  rows: SessionPendingToolCallRow[]
): { keepId: string | null; staleIds: string[] } {
  if (rows.length === 0) return { keepId: null, staleIds: [] };
  const sorted = [...rows].sort((a, b) => {
    const aMs = new Date(a.created_at).getTime();
    const bMs = new Date(b.created_at).getTime();
    return (Number.isFinite(bMs) ? bMs : 0) - (Number.isFinite(aMs) ? aMs : 0);
  });
  const keep = sorted[0]!;
  return {
    keepId: keep.id,
    staleIds: sorted.slice(1).map((row) => row.id),
  };
}

export function uniqueCaseIdsFromPendingRows(
  rows: SessionPendingToolCallRow[]
): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    const caseId = caseIdFromPendingToolCall(row);
    if (caseId) ids.add(caseId);
  }
  return [...ids];
}
