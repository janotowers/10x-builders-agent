-- Correlate messages and tool calls that belong to the same agent turn.
-- Nullable for historical rows; new application writes should provide a UUID.

alter table public.agent_messages
  add column if not exists turn_id uuid;

alter table public.tool_calls
  add column if not exists turn_id uuid;

create index if not exists agent_messages_session_turn_idx
  on public.agent_messages(session_id, turn_id, created_at);

create index if not exists tool_calls_session_turn_idx
  on public.tool_calls(session_id, turn_id, created_at);
