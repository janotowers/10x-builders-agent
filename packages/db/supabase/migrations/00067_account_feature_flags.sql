-- Slice 1.4 / §X finding 7: per-tenant feature flags. Service-role writes,
-- user reads own rows (00037 child-table tenancy pattern). Env vars remain
-- global kill-switches only. `value_text` extends the boolean decision for
-- enum-valued flags (first consumer: workflow_enforcement_mode).

create table public.account_feature_flags (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  flag_key text not null,
  enabled boolean not null default false,
  value_text text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (user_id, flag_key)
);

create index account_feature_flags_user_idx
  on public.account_feature_flags (user_id, flag_key);

alter table public.account_feature_flags enable row level security;

create policy "Users read own feature flags"
  on public.account_feature_flags for select
  using (auth.uid() = user_id);

create policy "Service role manages feature flags"
  on public.account_feature_flags for all
  using (auth.role() = 'service_role');
