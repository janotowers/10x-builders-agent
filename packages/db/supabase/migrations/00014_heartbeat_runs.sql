-- ============================================================
-- 00014_heartbeat_runs.sql
--
-- V1-D phase foundation:
--   1) add 'heartbeat' to agent_sessions.channel CHECK
--   2) add heartbeat_runs audit table
-- ============================================================

-- Extend agent_sessions.channel to include heartbeat.
alter table public.agent_sessions
  drop constraint if exists agent_sessions_channel_check;

alter table public.agent_sessions
  add constraint agent_sessions_channel_check
    check (channel in ('web', 'telegram', 'cron', 'heartbeat'));

-- Heartbeat execution audit log.
create table if not exists public.heartbeat_runs (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  session_id uuid references public.agent_sessions(id) on delete set null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running'
    check (status in ('running', 'completed', 'error')),
  payload jsonb not null default '{}'::jsonb,
  error text
);

create index if not exists heartbeat_runs_user_started_idx
  on public.heartbeat_runs (user_id, started_at desc);

create index if not exists heartbeat_runs_status_started_idx
  on public.heartbeat_runs (status, started_at desc);

alter table public.heartbeat_runs enable row level security;

create policy "Users can view own heartbeat runs"
  on public.heartbeat_runs for select
  using (auth.uid() = user_id);

create policy "Service role full access to heartbeat_runs"
  on public.heartbeat_runs for all
  using (auth.role() = 'service_role');
