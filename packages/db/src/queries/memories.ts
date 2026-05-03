import { createHash } from "node:crypto";
import type { DbClient } from "../client";

/**
 * Tipos de memoria soportados. La clasificación viene del prompt de extracción
 * de `memory_flush.ts` (ver `docs/memory/long_term_memory_plan.md`).
 */
export type MemoryType = "episodic" | "semantic" | "procedural";

export interface MemoryRow {
  id: string;
  user_id: string;
  type: MemoryType;
  content: string;
  content_hash: string;
  embedding: number[] | null;
  embedding_model: string;
  embedding_dim: number;
  retrieval_count: number;
  created_at: string;
  last_retrieved_at: string | null;
  archived_at: string | null;
}

/** Subset de columnas que la UI/agente realmente necesitan (excluye
 *  embedding bruto, hash y campos de modelo). */
export interface MemorySummary {
  id: string;
  type: MemoryType;
  content: string;
  retrieval_count: number;
  created_at: string;
  last_retrieved_at: string | null;
  archived_at: string | null;
}

export type MemoryAuditAction = "archive" | "restore" | "delete" | "update";

export interface MemoryAuditLogRow {
  id: string;
  user_id: string;
  memory_id: string | null;
  action: MemoryAuditAction;
  details: Record<string, unknown> | null;
  performed_at: string;
}

export interface MemoryMatch {
  id: string;
  type: MemoryType;
  content: string;
  retrieval_count: number;
  /** 1 - cosine distance ∈ [-1, 1]; cuanto mayor, más parecido. */
  similarity: number;
}

export interface SaveMemoryInput {
  userId: string;
  type: MemoryType;
  content: string;
  embedding: number[];
  embeddingModel?: string;
  embeddingDim?: number;
}

/** Normaliza el texto para el hash: trim + lowercase + colapso de espacios.
 *  Pensado para que `"Le gusta React.  "` y `"le gusta react."` coincidan. */
function normalizeForHash(content: string): string {
  return content.trim().toLowerCase().replace(/\s+/g, " ");
}

/** `sha1(type + ':' + normalize(content))` en hex. */
export function computeContentHash(type: MemoryType, content: string): string {
  const payload = `${type}:${normalizeForHash(content)}`;
  return createHash("sha1").update(payload, "utf8").digest("hex");
}

/**
 * Inserta una memoria. Idempotente vía `UNIQUE (user_id, content_hash)`:
 * si ya existe el mismo hecho para el mismo usuario, no se duplica ni se
 * sobrescribe. Devuelve `true` si se insertó un renglón nuevo.
 */
export async function saveMemory(
  db: DbClient,
  input: SaveMemoryInput
): Promise<boolean> {
  const contentHash = computeContentHash(input.type, input.content);
  const { data, error } = await db
    .from("memories")
    .upsert(
      {
        user_id: input.userId,
        type: input.type,
        content: input.content,
        content_hash: contentHash,
        embedding: input.embedding,
        embedding_model:
          input.embeddingModel ?? "google/gemini-embedding-001",
        embedding_dim: input.embeddingDim ?? 1536,
      },
      { onConflict: "user_id,content_hash", ignoreDuplicates: true }
    )
    .select("id");
  if (error) throw error;
  return (data ?? []).length > 0;
}

export interface SearchMemoriesInput {
  userId: string;
  embedding: number[];
  limit?: number;
  /**
   * Similitud mínima (coseno ∈ [-1, 1]) para que un match cuente. El RPC
   * filtra con `similarity >= threshold` antes del LIMIT. Default `0.5`
   * (migraciones 00006/00008). El caller puede ajustarlo vía
   * `MEMORY_MATCH_THRESHOLD`.
   */
  matchThreshold?: number;
}

/**
 * Busca memorias cercanas semánticamente al `embedding` dado. Llama al RPC
 * `match_memories` (migración 00005 + threshold en 00006), que devuelve ya
 * ordenado por similitud descendente y filtrado por piso de similitud.
 */
export async function searchMemories(
  db: DbClient,
  input: SearchMemoriesInput
): Promise<MemoryMatch[]> {
  const { data, error } = await db.rpc("match_memories", {
    p_user_id: input.userId,
    p_query_embedding: input.embedding,
    p_match_count: input.limit ?? 8,
    p_match_threshold: input.matchThreshold ?? 0.5,
  });
  if (error) throw error;
  return (data ?? []) as MemoryMatch[];
}

/**
 * Incrementa `retrieval_count` y refresca `last_retrieved_at` para las
 * memorias que efectivamente se inyectaron al agente. Se llama fire-and-forget
 * desde el nodo de inyección para no bloquear el turno si Supabase tarda.
 */
export async function incrementRetrievalCount(
  db: DbClient,
  ids: string[]
): Promise<void> {
  if (ids.length === 0) return;
  const nowIso = new Date().toISOString();
  // Supabase-js no soporta `col = col + 1` directo; usamos SELECT + UPDATE.
  const { data, error } = await db
    .from("memories")
    .select("id, retrieval_count")
    .in("id", ids);
  if (error) throw error;
  await Promise.all(
    (data ?? []).map((row: { id: string; retrieval_count: number }) =>
      db
        .from("memories")
        .update({
          retrieval_count: (row.retrieval_count ?? 0) + 1,
          last_retrieved_at: nowIso,
        })
        .eq("id", row.id)
    )
  );
}

/* ──────────────────── Capa 2 — curación manual ─────────────────────── */
/* Ver `docs/memory/memory_curation_plan.md` (Capa 2). Estas queries dan
 * soporte tanto a la UI (`/memory`) como a la skill `memory-curate`. */

export interface ListMemoriesInput {
  userId: string;
  /** Filtra por tipo si se especifica. */
  type?: MemoryType;
  /** "active" → archived_at IS NULL, "archived" → archived_at IS NOT NULL,
   *  "all" → sin filtro. Default: "active". */
  status?: "active" | "archived" | "all";
  /** Substring (ILIKE %q%) sobre `content`. */
  q?: string;
  /** Default 50, hard cap 200. */
  limit?: number;
  /** Default 0. */
  offset?: number;
  /**
   * Columna de ordenación. `archived_at` solo aplica cuando `status` es
   * `archived` o `all`; si `status` es `active`, se usa `created_at`.
   */
  sortBy?: "created_at" | "archived_at";
  /** Default `desc` (más reciente primero para fechas). */
  sortDir?: "asc" | "desc";
}

export interface ListMemoriesResult {
  rows: MemorySummary[];
  total: number;
}

const LIST_MEMORIES_HARD_CAP = 200;

/**
 * Lista paginada de memorias del usuario para curación. Pensada para
 * RLS: el caller debe usar un cliente con la auth del usuario o pasar
 * un `user_id` que ya validó. Devuelve solo columnas seguras (no
 * embeddings ni hash).
 */
export async function listMemories(
  db: DbClient,
  input: ListMemoriesInput
): Promise<ListMemoriesResult> {
  const limit = Math.min(
    Math.max(1, Math.floor(input.limit ?? 50)),
    LIST_MEMORIES_HARD_CAP
  );
  const offset = Math.max(0, Math.floor(input.offset ?? 0));
  const status = input.status ?? "active";
  const ascending = (input.sortDir ?? "desc") === "asc";
  const requestedSort = input.sortBy ?? "created_at";
  const orderColumn: "created_at" | "archived_at" =
    requestedSort === "archived_at" && status !== "active"
      ? "archived_at"
      : "created_at";

  let query = db
    .from("memories")
    .select(
      "id, type, content, retrieval_count, created_at, last_retrieved_at, archived_at",
      { count: "exact" }
    )
    .eq("user_id", input.userId)
    .order(orderColumn, { ascending })
    .range(offset, offset + limit - 1);

  if (status === "active") query = query.is("archived_at", null);
  if (status === "archived") query = query.not("archived_at", "is", null);
  if (input.type) query = query.eq("type", input.type);
  if (input.q && input.q.trim().length > 0) {
    // ILIKE-style con escape mínimo de '%' y '_'.
    const safe = input.q.trim().replace(/[%_]/g, (c) => `\\${c}`);
    query = query.ilike("content", `%${safe}%`);
  }

  const { data, error, count } = await query;
  if (error) throw error;
  return {
    rows: (data ?? []) as MemorySummary[],
    total: typeof count === "number" ? count : (data ?? []).length,
  };
}

/** Recupera una memoria por id, validando ownership por user_id.
 *  Devuelve null si no existe o no pertenece al usuario. */
export async function getMemoryById(
  db: DbClient,
  input: { userId: string; memoryId: string }
): Promise<MemorySummary | null> {
  const { data, error } = await db
    .from("memories")
    .select(
      "id, type, content, retrieval_count, created_at, last_retrieved_at, archived_at"
    )
    .eq("id", input.memoryId)
    .eq("user_id", input.userId)
    .maybeSingle();
  if (error) throw error;
  return (data as MemorySummary | null) ?? null;
}

/**
 * Soft-delete reversible: marca `archived_at = NOW()`. Idempotente
 * (ejecutar dos veces no rompe ni hace nada útil la segunda vez).
 * Devuelve `true` si efectivamente archivó (cambió de NULL → fecha).
 */
export async function archiveMemory(
  db: DbClient,
  input: { userId: string; memoryId: string }
): Promise<boolean> {
  const nowIso = new Date().toISOString();
  const { data, error } = await db
    .from("memories")
    .update({ archived_at: nowIso })
    .eq("id", input.memoryId)
    .eq("user_id", input.userId)
    .is("archived_at", null)
    .select("id");
  if (error) throw error;
  return (data ?? []).length > 0;
}

/** Restaura: setea `archived_at = NULL`. Devuelve `true` si efectivamente
 *  restauró (estaba archivada antes). */
export async function restoreMemory(
  db: DbClient,
  input: { userId: string; memoryId: string }
): Promise<boolean> {
  const { data, error } = await db
    .from("memories")
    .update({ archived_at: null })
    .eq("id", input.memoryId)
    .eq("user_id", input.userId)
    .not("archived_at", "is", null)
    .select("id");
  if (error) throw error;
  return (data ?? []).length > 0;
}

/** Hard-delete: borra el renglón definitivamente. Para que la auditoría
 *  sobreviva, el caller DEBE haber llamado antes a `logMemoryAction`
 *  con un snapshot del content. */
export async function deleteMemory(
  db: DbClient,
  input: { userId: string; memoryId: string }
): Promise<boolean> {
  const { data, error } = await db
    .from("memories")
    .delete()
    .eq("id", input.memoryId)
    .eq("user_id", input.userId)
    .select("id");
  if (error) throw error;
  return (data ?? []).length > 0;
}

export interface LogMemoryActionInput {
  userId: string;
  /** null cuando la memoria ya fue borrada. */
  memoryId: string | null;
  action: MemoryAuditAction;
  /** Snapshot del content / razón / canal (ui|agent) / etc. */
  details?: Record<string, unknown> | null;
}

/** Inserta un renglón en `memory_audit_log`. No-op silencioso si la
 *  tabla aún no existe (errores de catálogo se loguean y devuelven
 *  null para no bloquear el flujo principal). */
export async function logMemoryAction(
  db: DbClient,
  input: LogMemoryActionInput
): Promise<MemoryAuditLogRow | null> {
  const { data, error } = await db
    .from("memory_audit_log")
    .insert({
      user_id: input.userId,
      memory_id: input.memoryId,
      action: input.action,
      details: input.details ?? null,
    })
    .select("id, user_id, memory_id, action, details, performed_at")
    .single();
  if (error) {
    console.warn("[memory_audit_log] insert failed:", error.message);
    return null;
  }
  return data as MemoryAuditLogRow;
}
