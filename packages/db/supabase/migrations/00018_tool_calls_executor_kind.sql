-- Mark each tool_call by who issued it: the LLM ("agent") or the system itself
-- ("deterministic", e.g. Heartbeat prefetchers reading Google Calendar/Tasks
-- before the model runs). Lets the chat panel show a "Determinístico" vs "IA"
-- badge alongside existing tool calls without changing legacy flows.

alter table public.tool_calls
  add column if not exists executor_kind text not null default 'agent'
    check (executor_kind in ('agent', 'deterministic'));

create index if not exists tool_calls_session_executor_idx
  on public.tool_calls(session_id, executor_kind, created_at);
