-- Human-friendly display fields for scheduled tasks.
--
-- `prompt` remains the executable instruction generated for the agent.
-- `user_request` keeps the user's original wording when available.
-- `display_title` is a short UI label for lists/cards.
alter table public.scheduled_tasks
  add column if not exists user_request text,
  add column if not exists display_title text;

