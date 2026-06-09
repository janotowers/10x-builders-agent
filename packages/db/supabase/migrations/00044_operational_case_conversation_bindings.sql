-- ============================================================
-- 00044_operational_case_conversation_bindings.sql
--
-- Binding durable entre conversación de canal (ej. Telegram)
-- y casos operacionales en intake/seguimiento.
-- ============================================================

create table if not exists public.operational_case_conversation_bindings (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  case_id uuid not null references public.operational_cases(id) on delete cascade,
  case_type text not null,
  channel text not null check (channel in ('telegram', 'web')),
  chat_id bigint,
  session_id uuid references public.agent_sessions(id) on delete set null,
  status text not null default 'awaiting_user'
    check (
      status in (
        'awaiting_user',
        'clarification_needed',
        'resolved',
        'expired',
        'cancelled'
      )
    ),
  awaiting_fields_jsonb jsonb not null default '[]'::jsonb,
  last_agent_prompt text,
  last_prompt_at timestamptz,
  last_user_message_at timestamptz,
  pending_message_jsonb jsonb not null default '{}'::jsonb,
  candidate_routes_jsonb jsonb not null default '[]'::jsonb,
  metadata_jsonb jsonb not null default '{}'::jsonb,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.operational_case_conversation_bindings is
  'Vínculo durable entre conversación y caso operacional para enrutar respuestas tardías, permitir interrupciones y resolver ambigüedad.';

create index if not exists operational_case_conversation_bindings_user_channel_status_idx
  on public.operational_case_conversation_bindings (user_id, channel, status, updated_at desc);

create index if not exists operational_case_conversation_bindings_case_idx
  on public.operational_case_conversation_bindings (case_id, updated_at desc);

create index if not exists operational_case_conversation_bindings_chat_idx
  on public.operational_case_conversation_bindings (channel, chat_id, status, updated_at desc)
  where chat_id is not null;

create unique index if not exists operational_case_conversation_bindings_active_case_unique
  on public.operational_case_conversation_bindings (case_id, channel)
  where status in ('awaiting_user', 'clarification_needed');

alter table public.operational_case_conversation_bindings enable row level security;

create policy "Users view own conversation bindings"
  on public.operational_case_conversation_bindings for select
  using (auth.uid() = user_id);

create policy "Service role full access to conversation bindings"
  on public.operational_case_conversation_bindings for all
  using (auth.role() = 'service_role');
