-- ============================================================
-- user_skill_settings (per-user skill enable/config)
-- ============================================================

create table if not exists public.user_skill_settings (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  skill_id    text not null,
  enabled     boolean not null default true,
  config_json jsonb not null default '{}',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (user_id, skill_id)
);

alter table public.user_skill_settings enable row level security;

drop policy if exists "Users can manage own skill settings"
  on public.user_skill_settings;

create policy "Users can manage own skill settings"
  on public.user_skill_settings for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists user_skill_settings_user_id_idx
  on public.user_skill_settings (user_id);
