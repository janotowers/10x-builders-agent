-- ============================================================
-- heartbeat_checklist_templates — user-authored Heartbeat templates
-- ============================================================

create table if not exists public.heartbeat_checklist_templates (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  name text not null,
  description text not null default '',
  markdown text not null,
  status text not null default 'validated'
    check (status in ('draft', 'validated')),
  validation_warnings jsonb not null default '[]'::jsonb,
  detected_skills jsonb not null default '[]'::jsonb,
  source_template_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.heartbeat_checklist_templates enable row level security;

drop policy if exists "Users can manage own heartbeat checklist templates"
  on public.heartbeat_checklist_templates;

create policy "Users can manage own heartbeat checklist templates"
  on public.heartbeat_checklist_templates for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists heartbeat_checklist_templates_user_updated_idx
  on public.heartbeat_checklist_templates (user_id, updated_at desc);

