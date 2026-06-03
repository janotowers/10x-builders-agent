-- Persist operational context on tool_calls for lab observability and prod audit.
-- Stable fields: case_id, operational_step_key, skill_slug, source, channel.

alter table public.tool_calls
  add column if not exists metadata_jsonb jsonb not null default '{}'::jsonb;

create index if not exists tool_calls_metadata_case_id_idx
  on public.tool_calls ((metadata_jsonb ->> 'case_id'))
  where (metadata_jsonb ->> 'case_id') is not null;

create index if not exists tool_calls_metadata_step_key_idx
  on public.tool_calls ((metadata_jsonb ->> 'operational_step_key'))
  where (metadata_jsonb ->> 'operational_step_key') is not null;
