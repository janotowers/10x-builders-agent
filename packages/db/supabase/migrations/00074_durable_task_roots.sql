-- ============================================================
-- 00074_durable_task_roots.sql
--
-- Slice 5.1 (flexible-workflows plan / Technical Plan §7.0): durable task
-- roots + Studio authoring sessions. work_items may hang from an
-- operational_case OR a work_run (XOR) — no phantom cases for batch jobs.
--
-- Durable roots are a standard runtime capability. Rollback is a code
-- deployment rollback; persisted audit rows remain intact.
-- ============================================================

-- ============================================================
-- durable_tasks — independent durable work roots (not commercial cases)
-- ============================================================
create table public.durable_tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  title text not null,
  objective text not null,
  status text not null default 'draft'
    check (status in ('draft','active','paused','completed','cancelled','failed')),
  retention_policy_jsonb jsonb not null default '{}'::jsonb,
  input_contract_jsonb jsonb not null default '{}'::jsonb,
  result_jsonb jsonb,
  schedule_ref uuid,
  provenance_jsonb jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint durable_tasks_title_not_empty check (btrim(title) <> ''),
  constraint durable_tasks_objective_not_empty check (btrim(objective) <> '')
);

comment on table public.durable_tasks is
  'Raíz durable independiente de operational_cases (Technical Plan §7.0 / Phase 5). Caso = verdad comercial/expediente; tarea durable = ejecución/resultado de un trabajo (batch OCR, digests, análisis de inventario).';

create index idx_durable_tasks_user_status
  on public.durable_tasks (user_id, status);

create index idx_durable_tasks_user_created
  on public.durable_tasks (user_id, created_at desc);

alter table public.durable_tasks enable row level security;

create policy "Users view own durable tasks"
  on public.durable_tasks for select
  using (auth.uid() = user_id);

create policy "Service role manages durable tasks"
  on public.durable_tasks for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create or replace function public.durable_tasks_set_updated_at()
returns trigger
language plpgsql
as $fn$
begin
  new.updated_at = now();
  return new;
end;
$fn$;

create trigger trg_durable_tasks_updated_at
  before update on public.durable_tasks
  for each row execute function public.durable_tasks_set_updated_at();

-- ============================================================
-- work_runs — one execution instance of a durable_task
-- ============================================================
create table public.work_runs (
  id uuid primary key default gen_random_uuid(),
  durable_task_id uuid not null references public.durable_tasks(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending','running','succeeded','failed','cancelled')),
  started_at timestamptz,
  finished_at timestamptz,
  result_ref text,
  result_jsonb jsonb,
  error_jsonb jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.work_runs is
  'Corrida de una durable_task (Technical Plan §7.0). Los work_items cuelgan de work_run_id (XOR con case_id). La finalización cierra el run, no un paso de caso.';

create index idx_work_runs_task_created
  on public.work_runs (durable_task_id, created_at desc);

create index idx_work_runs_user_status
  on public.work_runs (user_id, status);

alter table public.work_runs enable row level security;

create policy "Users view own work runs"
  on public.work_runs for select
  using (auth.uid() = user_id);

create policy "Service role manages work runs"
  on public.work_runs for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create or replace function public.work_runs_set_updated_at()
returns trigger
language plpgsql
as $fn$
begin
  new.updated_at = now();
  return new;
end;
$fn$;

create trigger trg_work_runs_updated_at
  before update on public.work_runs
  for each row execute function public.work_runs_set_updated_at();

-- ============================================================
-- studio_authoring_sessions — NL → artifact router state (Slice 5.3 seam)
-- ============================================================
create table public.studio_authoring_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'active'
    check (status in ('active','clarifying','compiled','abandoned','redirected')),
  description_nl text not null,
  title text,
  suggested_slug text,
  router_kind text,
  router_output_jsonb jsonb not null default '{}'::jsonb,
  clarification_round integer not null default 0,
  messages_jsonb jsonb not null default '[]'::jsonb,
  progress_jsonb jsonb not null default '[]'::jsonb,
  artifact_kind text,
  artifact_ref jsonb not null default '{}'::jsonb,
  model_id text,
  provenance_jsonb jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint studio_authoring_sessions_description_nl_not_empty
    check (btrim(description_nl) <> '')
);

comment on table public.studio_authoring_sessions is
  'Sesión de autoría del Studio (Slice 5.3): estado del router NL→artefacto (case_workflow | durable_task | reusable_skill | schedule | clarify | redirect_to_chat).';

create index idx_studio_authoring_sessions_user_status
  on public.studio_authoring_sessions (user_id, status);

create index idx_studio_authoring_sessions_user_created
  on public.studio_authoring_sessions (user_id, created_at desc);

alter table public.studio_authoring_sessions enable row level security;

create policy "Users view own studio authoring sessions"
  on public.studio_authoring_sessions for select
  using (auth.uid() = user_id);

create policy "Service role manages studio authoring sessions"
  on public.studio_authoring_sessions for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create or replace function public.studio_authoring_sessions_set_updated_at()
returns trigger
language plpgsql
as $fn$
begin
  new.updated_at = now();
  return new;
end;
$fn$;

create trigger trg_studio_authoring_sessions_updated_at
  before update on public.studio_authoring_sessions
  for each row execute function public.studio_authoring_sessions_set_updated_at();

-- ============================================================
-- work_items — dual root: case_id XOR work_run_id
-- ============================================================
-- Existing rows keep case_id; work_run_id stays null. New durable-task rows
-- only through the durable runtime (no backfill).
alter table public.work_items
  alter column case_id drop not null;

alter table public.work_items
  add column work_run_id uuid references public.work_runs(id) on delete cascade;

-- Reemplazar unique (case_id, idempotency_key): con case_id nullable el unique
-- clásico no aísla bien las dos raíces; partial uniques por raíz.
alter table public.work_items
  drop constraint if exists work_items_case_id_idempotency_key_key;

create unique index work_items_case_idempotency_uidx
  on public.work_items (case_id, idempotency_key)
  where case_id is not null and idempotency_key is not null;

create unique index work_items_work_run_idempotency_uidx
  on public.work_items (work_run_id, idempotency_key)
  where work_run_id is not null and idempotency_key is not null;

alter table public.work_items
  add constraint work_items_root_xor check (
    (case_id is not null and work_run_id is null)
    or (case_id is null and work_run_id is not null)
  );

comment on column public.work_items.work_run_id is
  'Raíz durable (Phase 5): exactamente uno de case_id o work_run_id debe ser non-null (XOR).';

create index idx_work_items_work_run_status
  on public.work_items (work_run_id, status)
  where work_run_id is not null;
