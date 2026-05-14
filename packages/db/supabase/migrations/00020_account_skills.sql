-- ============================================================
-- 00020_account_skills.sql
--
-- account_skills V1 (Opción B): skills propias de una cuenta de usuario,
-- texto completo del SKILL.md viviendo en Postgres.
--
-- El runtime de skills (packages/agent/src/skills/runtime.ts) compone el
-- registry así:
--   account_skills(user_id=auth.uid, status='active') ∪ skills/global/*
-- Cuando coinciden por slug, gana account_skills.
--
-- V1 es deliberadamente mínimo: una tabla, RLS por user_id, status simple.
-- Versionado completo, draft/review/active/archived con rollback, QA pre-
-- publicación, organization-level skills → V2/V3 (ver
-- docs/operational-cases/future-considerations.md sección 6).
-- ============================================================

create table public.account_skills (
  id              uuid primary key default uuid_generate_v4(),
  user_id         uuid not null references public.profiles(id) on delete cascade,
  slug            text not null,
  body_md         text not null,
  metadata_jsonb  jsonb not null default '{}'::jsonb,
  status          text not null default 'draft'
                    check (status in ('draft','active','archived')),
  version         int not null default 1,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (user_id, slug)
);

comment on table public.account_skills is
  'Skills propias por cuenta de usuario (V1 Opción B). El cuerpo completo del SKILL.md vive en body_md; metadata_jsonb cachea el frontmatter parseado para no re-parsear en cada turno. Cuando coincide por slug con una global, account gana.';

comment on column public.account_skills.metadata_jsonb is
  'Cache parseada del frontmatter: { name, description, scope, allowed_tools, includes, requires_tenant_context, memory_extraction, heartbeat?, heartbeat_signals? }. Se actualiza cada vez que cambia body_md.';

-- Índice para el runtime: cargar todas las activas de un usuario.
create index idx_account_skills_user_active
  on public.account_skills (user_id, status, updated_at desc)
  where status = 'active';

alter table public.account_skills enable row level security;

create policy "Users manage own account skills"
  on public.account_skills for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Service role full access to account_skills"
  on public.account_skills for all
  using (auth.role() = 'service_role');
