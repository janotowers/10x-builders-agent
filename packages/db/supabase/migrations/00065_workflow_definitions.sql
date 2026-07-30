-- Slice 1.1 (flexible-workflows plan): versioned workflow definitions.
-- `graph_jsonb` is the executable artifact (deliberately NOT named
-- operational_flow_jsonb: that column is presentation/QA metadata).
-- Ownership mirrors account skills; customization is by explicit fork with
-- lineage, never a silent shadow of a published global (Technical Plan §5.1.1).

create table public.workflow_definitions (
  id uuid primary key default gen_random_uuid(),
  owner_scope text not null default 'global'
    check (owner_scope in ('global', 'user', 'organization')),
  user_id uuid references public.profiles(id) on delete cascade,
  organization_id uuid, -- reserved; unused until org-owned definitions ship
  case_type text not null,
  workflow_key text not null,
  version integer not null check (version >= 1),
  status text not null default 'draft'
    check (status in ('draft', 'validated', 'published', 'deprecated')),
  -- Catalog metadata only; never drives runtime semantics by itself.
  industry text,
  domain_tags text[] not null default '{}',
  business_spec_jsonb jsonb not null default '{}'::jsonb,
  implementation_spec_jsonb jsonb not null default '{}'::jsonb,
  graph_jsonb jsonb not null,
  definition_hash text not null,
  -- Explicit fork lineage.
  derived_from_definition_id uuid references public.workflow_definitions(id),
  derived_from_version integer,
  visibility text not null default 'private'
    check (visibility in ('private', 'shared_template')),
  published_at timestamptz,
  published_by uuid references public.profiles(id),
  provenance_jsonb jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (
    (owner_scope = 'global' and user_id is null) or
    (owner_scope = 'user' and user_id is not null) or
    (owner_scope = 'organization' and organization_id is not null)
  )
);

-- Postgres UNIQUE treats NULLs as distinct, so a single UNIQUE (user_id, ...)
-- would allow duplicate globals (§X finding 5). Partial unique indexes:
create unique index workflow_definitions_global_uniq
  on public.workflow_definitions (case_type, version)
  where user_id is null and owner_scope = 'global';

create unique index workflow_definitions_user_uniq
  on public.workflow_definitions (user_id, case_type, version)
  where user_id is not null;

create index workflow_definitions_case_type_status_idx
  on public.workflow_definitions (case_type, status, version desc);

create index workflow_definitions_user_case_type_idx
  on public.workflow_definitions (user_id, case_type)
  where user_id is not null;

-- Published definitions are immutable: evidence and case pins reference them
-- by (id, version, hash). The only allowed post-publication change is
-- deprecation (rollback = deprecate n+1, republish n as n+2 — §24).
create or replace function public.workflow_definitions_protect_published()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'published' then
    if new.status = 'deprecated'
      and new.id = old.id
      and new.owner_scope = old.owner_scope
      and new.user_id is not distinct from old.user_id
      and new.case_type = old.case_type
      and new.workflow_key = old.workflow_key
      and new.version = old.version
      and new.graph_jsonb = old.graph_jsonb
      and new.definition_hash = old.definition_hash
    then
      return new;
    end if;
    raise exception 'workflow_definitions rows with status=published are immutable (deprecate instead)';
  end if;
  return new;
end;
$$;

create trigger workflow_definitions_protect_published_trigger
  before update on public.workflow_definitions
  for each row execute function public.workflow_definitions_protect_published();

create or replace function public.workflow_definitions_reject_delete()
returns trigger
language plpgsql
as $$
begin
  if old.status in ('published', 'deprecated') then
    raise exception 'published/deprecated workflow_definitions rows cannot be deleted';
  end if;
  return old;
end;
$$;

create trigger workflow_definitions_reject_delete_trigger
  before delete on public.workflow_definitions
  for each row execute function public.workflow_definitions_reject_delete();

-- RLS: globals readable by any authenticated user; private rows only for the
-- owning user. All writes go through service-role paths in Phase 1 (authoring
-- UI arrives with the compiler in Phase 4).
alter table public.workflow_definitions enable row level security;

create policy "Users read visible workflow definitions"
  on public.workflow_definitions for select
  using (
    auth.role() = 'service_role'
    or owner_scope = 'global'
    or user_id = auth.uid()
  );

create policy "Service role manages workflow definitions"
  on public.workflow_definitions for all
  using (auth.role() = 'service_role');
