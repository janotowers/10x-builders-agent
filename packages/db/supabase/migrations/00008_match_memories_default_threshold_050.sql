-- Default de p_match_threshold: 0.35 → 0.50 (alineado con MEMORY_MATCH_THRESHOLD en app).
-- El caller TS siempre pasa el cuarto parámetro; el default afecta llamadas ad-hoc a la RPC.

create or replace function public.match_memories(
  p_user_id         uuid,
  p_query_embedding vector(1536),
  p_match_count     int default 8,
  p_match_threshold float default 0.50
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
