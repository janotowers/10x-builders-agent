-- ============================================================
-- 00035_persistent_notifications.sql
--
-- Notificaciones persistentes:
--   1. internal_user_notifications: inbox/action items para usuarios internos.
--   2. external_contact_notifications: seguimiento de mensajes a contactos
--      externos asociados a casos operacionales.
-- ============================================================

create table public.internal_user_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  case_id uuid references public.operational_cases(id) on delete cascade,
  kind text not null default 'general',
  title text not null,
  body text not null,
  status text not null default 'unread'
    check (status in ('unread', 'read', 'actioned', 'dismissed')),
  priority text not null default 'normal'
    check (priority in ('low', 'normal', 'high')),
  action_url text,
  due_at timestamptz,
  delivered_channels_jsonb jsonb not null default '{}'::jsonb,
  metadata_jsonb jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  actioned_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint internal_user_notifications_title_not_empty check (btrim(title) <> ''),
  constraint internal_user_notifications_body_not_empty check (btrim(body) <> '')
);

comment on table public.internal_user_notifications is
  'Inbox persistente para notificaciones y pendientes de usuarios internos (asesores, inmobiliarios, admins). Web se considera almacenado aunque no haya presencia en vivo.';

create index idx_internal_user_notifications_user_status
  on public.internal_user_notifications (user_id, status, created_at desc);

create index idx_internal_user_notifications_due
  on public.internal_user_notifications (due_at)
  where status = 'unread' and due_at is not null;

create index idx_internal_user_notifications_case
  on public.internal_user_notifications (case_id, created_at desc)
  where case_id is not null;

alter table public.internal_user_notifications enable row level security;

create policy "Users read own internal notifications"
  on public.internal_user_notifications for select
  using (auth.uid() = user_id);

create policy "Users update own internal notifications"
  on public.internal_user_notifications for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Service role full access to internal notifications"
  on public.internal_user_notifications for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create table public.external_contact_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  case_id uuid not null references public.operational_cases(id) on delete cascade,
  contact_jsonb jsonb not null default '{}'::jsonb,
  channel text not null check (channel in ('telegram', 'whatsapp', 'email')),
  recipient_identifier text not null,
  message_body text not null,
  status text not null default 'pending'
    check (status in ('pending', 'sent', 'responded', 'failed', 'expired', 'cancelled')),
  attempt_count int not null default 0,
  max_attempts int not null default 3,
  last_sent_at timestamptz,
  next_reminder_at timestamptz,
  responded_at timestamptz,
  metadata_jsonb jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint external_contact_notifications_recipient_not_empty check (btrim(recipient_identifier) <> ''),
  constraint external_contact_notifications_message_not_empty check (btrim(message_body) <> ''),
  constraint external_contact_notifications_attempts_valid check (attempt_count >= 0 and max_attempts > 0)
);

comment on table public.external_contact_notifications is
  'Seguimiento de mensajes y recordatorios enviados a contactos externos de un caso operacional (propietario, lead, prospecto, proveedor).';

create index idx_external_contact_notifications_case_status
  on public.external_contact_notifications (case_id, status, created_at desc);

create index idx_external_contact_notifications_due
  on public.external_contact_notifications (next_reminder_at)
  where status in ('pending', 'sent') and next_reminder_at is not null;

create index idx_external_contact_notifications_user
  on public.external_contact_notifications (user_id, created_at desc);

alter table public.external_contact_notifications enable row level security;

create policy "Users read own external contact notifications"
  on public.external_contact_notifications for select
  using (auth.uid() = user_id);

create policy "Service role full access to external contact notifications"
  on public.external_contact_notifications for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
