/**
 * Queries del plano de impacto: case_facts (Slice 3.1; Technical Plan §11).
 *
 * Semántica de corrección (nunca update-in-place):
 *   1. insert de la fila nueva (valor + procedencia),
 *   2. update quirúrgico de la fila anterior: superseded_by null → id nuevo
 *      (única mutación que el trigger de la tabla permite).
 * La historia de correcciones queda estructural; "hecho vigente" =
 * superseded_by is null.
 */
import type { DbClient } from "../client";
import type { CaseFact, CaseFactSourceKind } from "@agents/types";

export interface InsertCaseFactInput {
  userId: string;
  caseId: string;
  factKey: string;
  value: unknown;
  sourceKind: CaseFactSourceKind;
  sourceRef?: string | null;
  confidence?: number | null;
}

export interface InsertCaseFactResult {
  fact: CaseFact;
  /** Fila anterior vigente para la misma fact_key, ya apuntando a la nueva. */
  superseded: CaseFact | null;
}

/**
 * Inserta un hecho y reemplaza el vigente anterior de la misma clave (si
 * existe). El insert va primero: si el proceso muere entre insert y
 * supersesión quedan dos filas "vigentes" momentáneamente y la más reciente
 * gana en lecturas (orden por recorded_at); un insert posterior repara el
 * puntero. Nunca hay pérdida de historia.
 */
export async function insertCaseFact(
  db: DbClient,
  input: InsertCaseFactInput
): Promise<InsertCaseFactResult> {
  const { data: priorData, error: priorError } = await db
    .from("case_facts")
    .select("*")
    .eq("user_id", input.userId)
    .eq("case_id", input.caseId)
    .eq("fact_key", input.factKey)
    .is("superseded_by", null)
    .order("recorded_at", { ascending: false });
  if (priorError) throw priorError;
  const priorRows = (priorData ?? []) as CaseFact[];

  const { data, error } = await db
    .from("case_facts")
    .insert({
      case_id: input.caseId,
      user_id: input.userId,
      fact_key: input.factKey,
      value_jsonb: input.value,
      source_kind: input.sourceKind,
      source_ref: input.sourceRef ?? null,
      confidence: input.confidence ?? null,
    })
    .select("*")
    .single();
  if (error) throw error;
  const fact = data as CaseFact;

  let superseded: CaseFact | null = null;
  for (const prior of priorRows) {
    const { data: supersededData, error: supersedeError } = await db
      .from("case_facts")
      .update({ superseded_by: fact.id })
      .eq("id", prior.id)
      .eq("user_id", input.userId)
      .is("superseded_by", null)
      .select("*");
    if (supersedeError) throw supersedeError;
    const rows = (supersededData ?? []) as CaseFact[];
    // La primera (más reciente) es la relevante para el caller; el resto son
    // punteros huérfanos de una corrida interrumpida que quedan reparados.
    if (rows.length === 1 && !superseded) superseded = rows[0];
  }

  return { fact, superseded };
}

export async function getCaseFactById(
  db: DbClient,
  userId: string,
  factId: string
): Promise<CaseFact | null> {
  const { data, error } = await db
    .from("case_facts")
    .select("*")
    .eq("user_id", userId)
    .eq("id", factId)
    .maybeSingle();
  if (error) throw error;
  return (data as CaseFact | null) ?? null;
}

export interface ListCaseFactsOptions {
  factKey?: string;
  /** Incluir filas reemplazadas (historia completa). Default: false. */
  includeSuperseded?: boolean;
  limit?: number;
}

export async function listCaseFacts(
  db: DbClient,
  userId: string,
  caseId: string,
  opts: ListCaseFactsOptions = {}
): Promise<CaseFact[]> {
  let query = db
    .from("case_facts")
    .select("*")
    .eq("user_id", userId)
    .eq("case_id", caseId)
    .order("recorded_at", { ascending: false })
    .limit(Math.max(1, Math.min(opts.limit ?? 500, 1000)));
  if (opts.factKey) query = query.eq("fact_key", opts.factKey);
  if (!opts.includeSuperseded) query = query.is("superseded_by", null);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as CaseFact[];
}

/**
 * Hechos vigentes del caso, uno por fact_key (el más reciente gana si una
 * corrida interrumpida dejó dos filas sin supersesión).
 */
export async function getCurrentCaseFacts(
  db: DbClient,
  userId: string,
  caseId: string
): Promise<Map<string, CaseFact>> {
  const rows = await listCaseFacts(db, userId, caseId);
  const byKey = new Map<string, CaseFact>();
  for (const row of rows) {
    // rows viene ordenado recorded_at desc: la primera por clave es la vigente.
    if (!byKey.has(row.fact_key)) byKey.set(row.fact_key, row);
  }
  return byKey;
}
