-- ============================================================
-- 00075_durable_task_runtime.sql
--
-- Completa Phase 5.2: spec ejecutable, inputs separados de account_assets,
-- relación schedule→durable_task y perfil main-agent para trabajo durable.
-- ============================================================

alter table public.durable_tasks
  add column if not exists spec_jsonb jsonb not null default '{}'::jsonb,
  add column if not exists acceptance_criteria_jsonb jsonb not null default '[]'::jsonb,
  add column if not exists work_templates_jsonb jsonb not null default '[]'::jsonb,
  add column if not exists result_contract_jsonb jsonb not null default '{}'::jsonb,
  add column if not exists version integer not null default 1;

comment on column public.durable_tasks.spec_jsonb is
  'DurableTaskSpec compilado: objetivo, requisitos tipados, templates, resultado y retención. No contiene case_type ni grafo comercial.';

alter table public.work_runs
  add column if not exists input_jsonb jsonb not null default '{}'::jsonb,
  add column if not exists retention_expires_at timestamptz,
  add column if not exists scheduled_task_id uuid references public.scheduled_tasks(id) on delete set null;

alter table public.scheduled_tasks
  add column if not exists durable_task_id uuid references public.durable_tasks(id) on delete set null;

create index if not exists idx_scheduled_tasks_durable_task
  on public.scheduled_tasks (durable_task_id)
  where durable_task_id is not null;

-- Inputs por tarea/run. No son account_assets: su ciclo de vida y scope son
-- de una ejecución durable, con retención propia.
create table if not exists public.durable_task_inputs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  durable_task_id uuid not null references public.durable_tasks(id) on delete cascade,
  work_run_id uuid references public.work_runs(id) on delete cascade,
  input_key text not null,
  display_name text not null,
  value_jsonb jsonb,
  storage_bucket text,
  storage_path text,
  content_type text,
  file_size_bytes bigint,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  constraint durable_task_inputs_key_not_empty check (btrim(input_key) <> ''),
  constraint durable_task_inputs_value_or_file check (
    value_jsonb is not null
    or (storage_bucket is not null and storage_path is not null)
  )
);

create index if not exists idx_durable_task_inputs_task
  on public.durable_task_inputs (durable_task_id, created_at desc);

create index if not exists idx_durable_task_inputs_run
  on public.durable_task_inputs (work_run_id, created_at desc)
  where work_run_id is not null;

alter table public.durable_task_inputs enable row level security;

create policy "Users manage own durable task inputs"
  on public.durable_task_inputs for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Service role manages durable task inputs"
  on public.durable_task_inputs for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

insert into storage.buckets (id, name, public, file_size_limit)
values ('durable-task-inputs', 'durable-task-inputs', false, 52428800)
on conflict (id) do update set file_size_limit = excluded.file_size_limit;

create policy "Users manage own durable task input files"
  on storage.objects for all
  using (
    bucket_id = 'durable-task-inputs'
    and auth.uid()::text = (storage.foldername(name))[1]
  )
  with check (
    bucket_id = 'durable-task-inputs'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy "Service role manages durable task input files"
  on storage.objects for all
  using (
    bucket_id = 'durable-task-inputs'
    and auth.role() = 'service_role'
  )
  with check (
    bucket_id = 'durable-task-inputs'
    and auth.role() = 'service_role'
  );

-- Perfil global deliberadamente estrecho: ejecuta objetivos generales del
-- work plane y solo permite la lectura warehouse usada por el batch piloto.
insert into public.worker_profiles
  (user_id, slug, capabilities, execution_mode, allowed_tools,
   allowed_data_scopes, model_policy_jsonb, approval_policy_jsonb,
   verification_contract_jsonb, timeout_seconds, max_concurrency)
values
  (null, 'durable_task_generalist', array['durable_task_execution'],
   'main_agent', array['bigquery_run_query'],
   array['warehouse:read','durable_task_inputs:read'],
   '{"role":"main_agent","model_alias":"reasoning_standard","max_output_tokens":6000,"temperature":0}'::jsonb,
   '{}'::jsonb,
   '{"output":"result_contract"}'::jsonb,
   900, 2)
on conflict (slug) where user_id is null do update set
  capabilities = excluded.capabilities,
  execution_mode = excluded.execution_mode,
  allowed_tools = excluded.allowed_tools,
  allowed_data_scopes = excluded.allowed_data_scopes,
  model_policy_jsonb = excluded.model_policy_jsonb,
  verification_contract_jsonb = excluded.verification_contract_jsonb,
  timeout_seconds = excluded.timeout_seconds,
  max_concurrency = excluded.max_concurrency;
