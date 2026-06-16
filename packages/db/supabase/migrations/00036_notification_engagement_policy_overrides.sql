-- ============================================================
-- 00036_notification_engagement_policy_overrides.sql
--
-- Adds configurable engagement policy overrides (cooldowns, escalation,
-- delivery windows/day-of-week/timezone) at user level.
-- ============================================================

alter table public.user_notification_preferences
  add column if not exists engagement_policy_overrides_jsonb jsonb not null default '{}'::jsonb;

comment on column public.user_notification_preferences.engagement_policy_overrides_jsonb is
  'Overrides for engagement policy resolution (by_audience/by_kind): cooldowns, escalation and delivery windows.';

