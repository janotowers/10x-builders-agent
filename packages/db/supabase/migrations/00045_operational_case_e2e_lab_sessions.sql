-- ============================================================
-- 00045_operational_case_e2e_lab_sessions.sql
--
-- Modo explícito de laboratorio E2E para casos operacionales.
-- Permite que la UI active una ventana controlada antes de que exista case_id.
-- ============================================================

create table if not exists public.operational_case_e2e_lab_sessions (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  case_type text not null,
  case_id uuid references public.operational_cases(id) on delete set null,
  status text not null default 'active'
    check (status in ('active', 'expired', 'cancelled', 'completed')),
  metadata_jsonb jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.operational_case_e2e_lab_sessions is
  'Ventana explícita de laboratorio E2E por usuario y case_type. El webhook la usa para marcar casos conversacionales como controlados sin inferirlo del texto.';

create index if not exists operational_case_e2e_lab_sessions_user_case_type_status_idx
  on public.operational_case_e2e_lab_sessions (user_id, case_type, status, expires_at desc);

create index if not exists operational_case_e2e_lab_sessions_case_idx
  on public.operational_case_e2e_lab_sessions (case_id, updated_at desc)
  where case_id is not null;

create unique index if not exists operational_case_e2e_lab_sessions_active_unique
  on public.operational_case_e2e_lab_sessions (user_id, case_type)
  where status = 'active';

alter table public.operational_case_e2e_lab_sessions enable row level security;

create policy "Users view own e2e lab sessions"
  on public.operational_case_e2e_lab_sessions for select
  using (auth.uid() = user_id);

create policy "Service role full access to e2e lab sessions"
  on public.operational_case_e2e_lab_sessions for all
  using (auth.role() = 'service_role');
