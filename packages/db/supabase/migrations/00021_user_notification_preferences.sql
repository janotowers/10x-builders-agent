-- ============================================================
-- 00021_user_notification_preferences.sql
--
-- Preferencias de notificación al humano interno (el inmobiliario).
-- Usado por notify(user_id, payload, urgency): elige canal según
-- prioridad declarada + presencia + urgencia.
--
-- channels_priority_jsonb: array ordenado de canales preferidos.
--   Ej. ["web", "telegram"] = intentar web primero (si la sesión está activa
--   en los últimos N minutos), si no hay presencia, mandar a Telegram.
--
-- case_reminder_overrides_jsonb: overrides al policy default del case_type,
-- a nivel cuenta o a nivel instancia. Ej:
--   {
--     "by_case_type": {
--       "property_optioning": {
--         "remind_after_h": [48],
--         "escalate_after_h": 240
--       }
--     },
--     "by_case_id": {
--       "<uuid>": { "remind_after_h": [120] }
--     }
--   }
-- ============================================================

create table public.user_notification_preferences (
  user_id                          uuid primary key references public.profiles(id) on delete cascade,
  channels_priority_jsonb          jsonb not null default '["web","telegram"]'::jsonb,
  case_reminder_overrides_jsonb    jsonb not null default '{}'::jsonb,
  created_at                       timestamptz not null default now(),
  updated_at                       timestamptz not null default now()
);

comment on table public.user_notification_preferences is
  'Preferencias del inmobiliario para recibir notificaciones del agente (recordatorios, aprobaciones pendientes, escalaciones). Usado por notify().';

alter table public.user_notification_preferences enable row level security;

create policy "Users manage own notification preferences"
  on public.user_notification_preferences for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Service role full access to user_notification_preferences"
  on public.user_notification_preferences for all
  using (auth.role() = 'service_role');
