-- ============================================================
-- 00040_operational_case_test_runs.sql
--
-- Ejecuciones durables de pruebas de Preparación operativa (N3/N4).
-- Permite que pruebas largas no bloqueen el request del navegador:
-- la UI crea un run, muestra progreso y consulta el resultado por polling.
-- ============================================================

create table if not exists public.operational_case_test_runs (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  case_id uuid not null references public.operational_cases(id) on delete cascade,
  case_type_id uuid not null references public.operational_case_types(id) on delete cascade,
  level text not null check (level in ('n3', 'n4')),
  status text not null default 'queued'
    check (status in ('queued', 'running', 'completed', 'failed', 'timed_out')),
  step_key text,
  skill_slug text,
  scenario_id text,
  root_skill_slug text,
  turn_id uuid,
  request_jsonb jsonb not null default '{}'::jsonb,
  result_jsonb jsonb not null default '{}'::jsonb,
  error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.operational_case_test_runs is
  'Runs durables de pruebas N3/N4 en Preparación operativa. La UI los consulta por polling para evitar requests largos y timeouts.';

create index if not exists operational_case_test_runs_user_created_idx
  on public.operational_case_test_runs (user_id, created_at desc);

create index if not exists operational_case_test_runs_case_created_idx
  on public.operational_case_test_runs (case_id, created_at desc);

create index if not exists operational_case_test_runs_status_created_idx
  on public.operational_case_test_runs (status, created_at asc);

alter table public.operational_case_test_runs enable row level security;

create policy "Users view own operational case test runs"
  on public.operational_case_test_runs for select
  using (auth.uid() = user_id);

create policy "Service role full access to operational_case_test_runs"
  on public.operational_case_test_runs for all
  using (auth.role() = 'service_role');
