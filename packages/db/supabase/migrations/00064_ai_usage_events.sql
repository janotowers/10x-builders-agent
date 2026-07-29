-- ============================================================
-- 00064 — ai_usage_events (flexible-workflows plan, Slice 0.4;
-- Technical Plan §23.1)
--
-- Append-only, tenant-scoped ledger of AI-model calls. One row per model
-- call; retries append NEW rows with retry_ordinal+1 and never overwrite the
-- first event. INTERNAL observability only — explicitly NOT billing (no
-- customer prices, credits, quotas, balances, invoices).
--
-- Correlation ids for future planes (workflow definitions / work items) are
-- plain nullable uuids WITHOUT foreign keys: those tables do not exist yet
-- and this ledger must never block their evolution.
-- ============================================================

create table public.ai_usage_events (
  id                        uuid primary key default uuid_generate_v4(),
  user_id                   uuid not null references auth.users(id) on delete cascade,
  occurred_at               timestamptz not null default now(),

  provider                  text not null default 'openrouter',
  resource_type             text not null default 'ai_model'
                              check (resource_type in ('ai_model')),
  operation                 text not null
                              check (operation in (
                                'chat_completion',
                                'embedding',
                                'vision',
                                'extraction',
                                'classification'
                              )),
  -- Requested model id (OpenRouter slug). The RESOLVED id when a policy
  -- resolver exists (Phase 3+).
  model_id                  text not null,
  -- Logical role (main_agent, skill_selector, compaction, classifier roles,
  -- embeddings, vision, listing_copy, …). Open vocabulary.
  model_role                text not null,
  channel                   text,

  -- Token categories. NULL = provider did not report that category.
  input_tokens              integer,
  output_tokens             integer,
  total_tokens              integer,
  cached_input_tokens       integer,
  reasoning_tokens          integer,

  -- Costs in integer micro-USD (1 USD = 1,000,000). Reported = provider
  -- billed; estimated = versioned local price catalog. Kept separately.
  reported_cost_micro_usd   bigint,
  estimated_cost_micro_usd  bigint,
  currency                  text not null default 'USD',
  pricing_version           text,

  latency_ms                integer,
  status                    text not null default 'ok'
                              check (status in ('ok','error')),
  error_code                text,
  retry_ordinal             integer not null default 0 check (retry_ordinal >= 0),
  provider_request_id       text,

  -- Correlation (nullable; no FKs to future tables).
  session_id                uuid,
  turn_id                   text,
  operational_case_id       uuid,
  workflow_definition_id    uuid,
  work_item_id              uuid,
  work_item_attempt_id      uuid,

  -- Allowlisted, non-content metadata. NEVER prompts/responses/tool args.
  metadata_jsonb            jsonb not null default '{}'::jsonb,
  created_at                timestamptz not null default now()
);

comment on table public.ai_usage_events is
  'Append-only AI-model usage ledger (internal observability, not billing). One row per model call; retries append new rows (retry_ordinal). metadata_jsonb is allowlisted and must never contain prompts, responses, tool arguments or secrets.';

create index idx_ai_usage_events_user_occurred
  on public.ai_usage_events (user_id, occurred_at desc);
create index idx_ai_usage_events_user_turn
  on public.ai_usage_events (user_id, turn_id)
  where turn_id is not null;
create index idx_ai_usage_events_user_case
  on public.ai_usage_events (user_id, operational_case_id)
  where operational_case_id is not null;
-- Future attempt correlation (work plane, Phase 2+).
create index idx_ai_usage_events_attempt
  on public.ai_usage_events (work_item_attempt_id)
  where work_item_attempt_id is not null;

alter table public.ai_usage_events enable row level security;

-- Escritura: SOLO service_role (el metering corre en rutas server / crons).
create policy "Service role inserts ai usage events"
  on public.ai_usage_events for insert
  with check (auth.role() = 'service_role');

-- Lectura: SOLO service_role. Los rollups internos/admin se sirven desde
-- rutas server que verifican profiles.is_ungga_admin antes de consultar
-- (mismo patrón que el resto de superficies admin). Usuarios ordinarios no
-- leen ni escriben este ledger.
create policy "Service role reads ai usage events"
  on public.ai_usage_events for select
  using (auth.role() = 'service_role');

-- Append-only reforzado por trigger (patrón de operational_case_events,
-- migración 00019): ni UPDATE ni DELETE, ni siquiera desde service_role.
create or replace function public.ai_usage_events_enforce_append_only()
returns trigger
language plpgsql
as $fn$
begin
  raise exception 'ai_usage_events is append-only (id=%, user_id=%)', old.id, old.user_id;
end;
$fn$;

create trigger ai_usage_events_no_update
  before update on public.ai_usage_events
  for each row execute function public.ai_usage_events_enforce_append_only();

create trigger ai_usage_events_no_delete
  before delete on public.ai_usage_events
  for each row execute function public.ai_usage_events_enforce_append_only();
