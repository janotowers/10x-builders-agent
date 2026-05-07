-- ============================================================
-- scheduled_tasks — skill binding + per-tool approval policy
-- ============================================================
-- `skill_id` stores the playbook selected when the task was scheduled.
-- `tool_approval_policy` stores per-tool/per-operation automation permissions:
--   auto_execute | request_approval | deny
--
-- Example keys:
--   calendar_list_events
--   manage_scheduled_tasks:list
alter table public.scheduled_tasks
  add column if not exists skill_id text;

alter table public.scheduled_tasks
  add column if not exists tool_approval_policy jsonb not null default '{}'::jsonb;

alter table public.scheduled_tasks
  add column if not exists approval_policy_version int not null default 1;

