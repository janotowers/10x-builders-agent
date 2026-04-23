-- ============================================================
-- Migration 00006: match_memories — threshold mínimo de similitud
-- ============================================================
-- Motivación: el RPC original (00005) devolvía el top-K sin piso de
-- similitud. Con pocas memorias en la base (ej. 5-10), un query irrelevante
-- recuperaba igualmente toda la tabla porque "top-8 de 8" son las 8, sin
-- importar que el coseno sea 0.1. Eso ensuciaba el contexto inyectado.
--
-- Este reemplazo añade `p_match_threshold` (default 0.35). La función
-- filtra por `similarity >= p_match_threshold` antes del LIMIT. El ajuste
-- es conservador: 0.35 deja pasar matches "razonables" sin ser demasiado
-- exigente (cosenos con embeddings normalizados tienden a rondar 0.3-0.9
-- para pares semánticamente afines).
--
-- La firma nueva coexiste con la anterior (Postgres permite overloading).
-- Dejamos la versión antigua disponible por compat: si alguien llama sin
-- threshold obtiene el comportamiento v1. El código TS siempre pasará el
-- threshold.

create or replace function public.match_memories(
  p_user_id         uuid,
  p_query_embedding vector(1536),
  p_match_count     int default 8,
  p_match_threshold float default 0.35
)
returns table (
  id              uuid,
  type            text,
  content         text,
  retrieval_count int,
  similarity      float
)
language sql
stable
security definer
as $$
  select m.id,
         m.type,
         m.content,
         m.retrieval_count,
         1 - (m.embedding <=> p_query_embedding) as similarity
    from public.memories m
   where m.user_id = p_user_id
     and m.embedding is not null
     and 1 - (m.embedding <=> p_query_embedding) >= p_match_threshold
   order by m.embedding <=> p_query_embedding asc
   limit p_match_count;
$$;

revoke all on function public.match_memories(uuid, vector, int, float) from public;
grant execute on function public.match_memories(uuid, vector, int, float) to service_role;
