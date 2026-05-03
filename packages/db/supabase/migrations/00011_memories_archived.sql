-- ============================================================
-- Capa 2 de curación de memoria larga.
--
-- Cambios:
--   1. `memories.archived_at` (soft-delete reversible).
--   2. RPC `match_memories` ignora memorias archivadas (los hechos
--      archivados no deben volver a inyectarse aunque sean similares
--      al input del usuario).
--   3. `memory_audit_log` registra cambios manuales del usuario sobre
--      sus memorias (archivar / restaurar / borrar). Útil para que el
--      propio agente o la UI puedan mostrar el historial y para
--      auditoría.
--
-- Ver `docs/memory/memory_curation_plan.md` (Capa 2) para el contexto.
-- ============================================================

-- ============================================================
-- 1) memories.archived_at
-- ============================================================
alter table public.memories
  add column if not exists archived_at timestamptz;

-- Índice parcial: la mayoría de búsquedas son sobre memorias activas
-- (search_memories del injection node + UI Active tab). Filtrar con
-- WHERE archived_at IS NULL es lo común; este índice acelera ese path
-- sin inflar el ya-existente vector index.
create index if not exists memories_user_active_idx
  on public.memories (user_id, created_at desc)
  where archived_at is null;

-- ============================================================
-- 2) match_memories — excluir archivadas
--
-- La firma queda igual (mismos parámetros). Esto evita romper callers
-- existentes (`searchMemories` en TS) y permite que `archived_at` sea
-- transparente para el caller.
-- ============================================================
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
     and m.archived_at is null
     and 1 - (m.embedding <=> p_query_embedding) >= p_match_threshold
   order by m.embedding <=> p_query_embedding asc
   limit p_match_count;
$$;

revoke all on function public.match_memories(uuid, vector, int, float) from public;
grant execute on function public.match_memories(uuid, vector, int, float) to service_role;

-- ============================================================
-- 3) memory_audit_log
--
-- Cada acción de curación deja un renglón. `details` es JSONB para
-- preservar evidencia (snapshot del content al momento del borrado,
-- razón, canal: 'ui' | 'agent', etc.) sin atarse a un schema rígido.
-- `memory_id` puede quedar NULL si se borró la memoria por completo
-- (cascade de hard-delete) y aún queremos conservar el log.
-- ============================================================
create table if not exists public.memory_audit_log (
  id            uuid primary key default uuid_generate_v4(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  memory_id     uuid,                                   -- nullable: ver nota arriba.
  action        text not null check (action in ('archive', 'restore', 'delete', 'update')),
  details       jsonb,
  performed_at  timestamptz not null default now()
);

create index if not exists memory_audit_log_user_idx
  on public.memory_audit_log (user_id, performed_at desc);

alter table public.memory_audit_log enable row level security;

create policy "Users can read own memory audit log"
  on public.memory_audit_log for select
  using (auth.uid() = user_id);

-- Inserts solo desde el servidor (service_role); no abrir INSERT al
-- rol authenticated para que el log no se pueda falsificar desde el
-- cliente. La UI escribe vía endpoints que usan service role.

-- ============================================================
-- 4) Backfill de tools nuevas para usuarios existentes
--
-- Las tools `list_user_memories`, `search_user_memories`,
-- `archive_user_memory` y `delete_user_memory` (skill `memory-curate`)
-- se introducen junto con esta capa. Para que usuarios YA registrados
-- puedan invocarlas sin pasar antes por /settings, las habilitamos por
-- default. Las write-tools (archive/delete) siguen pasando por HITL
-- (definido en `catalog.ts` por `risk`).
-- ============================================================
insert into public.user_tool_settings (user_id, tool_id, enabled)
select p.id, t.tool_id, true
  from public.profiles p
  cross join (values
    ('list_user_memories'),
    ('search_user_memories'),
    ('archive_user_memory'),
    ('delete_user_memory')
  ) as t(tool_id)
on conflict (user_id, tool_id) do nothing;
