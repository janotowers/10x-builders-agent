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
