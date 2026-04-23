-- ============================================================
-- Long-term memory — tabla `memories`, watermark en `agent_sessions`
-- y RPC `match_memories` para búsqueda por cosine similarity.
--
-- Ver `docs/memory/long_term_memory_plan.md` (Diseño vigente) para el
-- detalle del pipeline de extracción/inyección y los triggers.
-- ============================================================
create extension if not exists vector;

-- ============================================================
-- memories
-- ============================================================
create table public.memories (
  id                uuid primary key default uuid_generate_v4(),
  user_id           uuid not null references public.profiles(id) on delete cascade,
  type              text not null check (type in ('episodic', 'semantic', 'procedural')),
  content           text not null,
  -- Hash determinista del contenido normalizado para deduplicación.
  -- Se calcula en TypeScript (`sha1(type + ':' + normalize(content))`).
  content_hash      text not null,
  embedding         vector(1536),
  embedding_model   text not null default 'google/gemini-embedding-001',
  embedding_dim     int  not null default 1536,
  retrieval_count   int  not null default 0,
  created_at        timestamptz not null default now(),
  last_retrieved_at timestamptz,
  unique (user_id, content_hash)
);

alter table public.memories enable row level security;

create policy "Users can manage own memories"
  on public.memories for all
  using (auth.uid() = user_id);

-- Índice vectorial. Lists bajo al arranque; recalibrar a ≈ sqrt(rows)
-- o migrar a HNSW cuando el volumen crezca.
create index memories_embedding_ivfflat
  on public.memories
  using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

create index memories_user_created_idx
  on public.memories (user_id, created_at desc);

-- ============================================================
-- agent_sessions — watermark de flush + estado para topic-shift
-- ============================================================
alter table public.agent_sessions
  add column if not exists last_message_at           timestamptz,
  add column if not exists last_flushed_at           timestamptz,
  add column if not exists last_flushed_message_id   uuid,
  add column if not exists last_user_input_embedding vector(1536);

-- Trigger para mantener `last_message_at` al día al insertar en agent_messages.
-- El helper `maybeCatchUpFlush` compara `last_message_at - last_flushed_at`
-- contra `CATCHUP_IDLE_MIN` para decidir si awaitea un flush pre-turn.
create or replace function public.touch_session_last_message_at()
returns trigger as $$
begin
  update public.agent_sessions
     set last_message_at = new.created_at,
         updated_at      = now()
   where id = new.session_id;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_agent_message_touch_session on public.agent_messages;
create trigger on_agent_message_touch_session
  after insert on public.agent_messages
  for each row execute procedure public.touch_session_last_message_at();

-- Backfill inicial: rellenar `last_message_at` con el created_at del último
-- mensaje existente para sesiones ya creadas (no rompe si aún no hay datos).
update public.agent_sessions s
   set last_message_at = (
     select max(created_at)
       from public.agent_messages m
      where m.session_id = s.id
   )
 where s.last_message_at is null;

-- ============================================================
-- RPC: match_memories — búsqueda por cosine similarity con filtro por user
-- ============================================================
create or replace function public.match_memories(
  p_user_id         uuid,
  p_query_embedding vector(1536),
  p_match_count     int default 8
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
   order by m.embedding <=> p_query_embedding asc
   limit p_match_count;
$$;

-- La función ya filtra por user_id; el servidor (service_role) pasa siempre
-- el user_id resuelto. No se expone al rol `public` para evitar enumeración
-- accidental si algún día se llama desde el cliente sin service_role.
revoke all on function public.match_memories(uuid, vector, int) from public;
grant execute on function public.match_memories(uuid, vector, int) to service_role;
