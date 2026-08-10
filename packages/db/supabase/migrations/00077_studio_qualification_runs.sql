-- ============================================================
-- 00077_studio_qualification_runs.sql
--
-- Durable, tenant-scoped qualification history for Workflow Studio
-- operational tests. A run pins every input that can invalidate its result:
-- artifact, resolved models, scenarios, rubric and sandbox policy.
-- ============================================================

create table if not exists public.studio_qualification_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,

  artifact_kind text not null
    check (artifact_kind in (
      'case_workflow',
      'reusable_skill',
      'durable_task',
      'schedule'
    )),
  artifact_id uuid not null,
  artifact_version integer,
  artifact_hash text not null,

  status text not null default 'pending'
    check (status in (
      'pending',
      'running',
      'passed',
      'failed',
      'stale',
      'non_convergent'
    )),
  qualification_fingerprint text not null,
  resolved_models_jsonb jsonb not null default '{}'::jsonb,
  judge_model_id text not null,

  scenario_set_id text not null,
  scenario_set_version text not null,
  scenario_set_hash text not null,
  rubric_id text not null,
  rubric_version text not null,
  rubric_hash text not null,
  sandbox_policy_id text not null,
  sandbox_policy_version text not null,
  sandbox_policy_hash text not null,
  runner_version text not null,

  result_jsonb jsonb not null default '{}'::jsonb,
  error_jsonb jsonb,
  repair_iteration integer not null default 0
    check (repair_iteration >= 0 and repair_iteration <= 5),

  input_tokens integer check (input_tokens is null or input_tokens >= 0),
  output_tokens integer check (output_tokens is null or output_tokens >= 0),
  total_tokens integer check (total_tokens is null or total_tokens >= 0),
  reported_cost_micro_usd bigint
    check (reported_cost_micro_usd is null or reported_cost_micro_usd >= 0),
  estimated_cost_micro_usd bigint
    check (estimated_cost_micro_usd is null or estimated_cost_micro_usd >= 0),
  currency text not null default 'USD',
  pricing_version text,

  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint studio_qualification_runs_artifact_hash_not_empty
    check (btrim(artifact_hash) <> ''),
  constraint studio_qualification_runs_fingerprint_not_empty
    check (btrim(qualification_fingerprint) <> ''),
  constraint studio_qualification_runs_terminal_finished
    check (
      status in ('pending', 'running')
      or finished_at is not null
    )
);

comment on table public.studio_qualification_runs is
  'Hash-pinned operational qualification runs for Studio artifacts. Historical results remain auditable; changed inputs derive or persist status=stale.';

create index if not exists idx_studio_qualification_runs_user_created
  on public.studio_qualification_runs (user_id, created_at desc);

create index if not exists idx_studio_qualification_runs_artifact
  on public.studio_qualification_runs
    (user_id, artifact_kind, artifact_id, created_at desc);

create index if not exists idx_studio_qualification_runs_status
  on public.studio_qualification_runs (status, created_at asc);

create index if not exists idx_studio_qualification_runs_fingerprint
  on public.studio_qualification_runs
    (user_id, qualification_fingerprint);

alter table public.studio_qualification_runs enable row level security;

drop policy if exists "Users read own studio qualification runs"
  on public.studio_qualification_runs;
create policy "Users read own studio qualification runs"
  on public.studio_qualification_runs for select
  using (auth.uid() = user_id);

drop policy if exists "Service role manages studio qualification runs"
  on public.studio_qualification_runs;
create policy "Service role manages studio qualification runs"
  on public.studio_qualification_runs for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create or replace function public.studio_qualification_runs_set_updated_at()
returns trigger
language plpgsql
as $fn$
begin
  new.updated_at = now();
  return new;
end;
$fn$;

drop trigger if exists trg_studio_qualification_runs_updated_at
  on public.studio_qualification_runs;
create trigger trg_studio_qualification_runs_updated_at
  before update on public.studio_qualification_runs
  for each row execute function public.studio_qualification_runs_set_updated_at();

-- Correlate each metered model call with its qualification run. Keep this a
-- nullable plain UUID like the ledger's other future-plane correlation ids:
-- metering must never block or cascade a qualification lifecycle.
alter table public.ai_usage_events
  add column if not exists studio_qualification_run_id uuid;

create index if not exists idx_ai_usage_events_studio_qualification_run
  on public.ai_usage_events (studio_qualification_run_id)
  where studio_qualification_run_id is not null;

-- Qualification evidence points at the durable run. The run itself retains
-- the artifact kind/id/hash, so one subject kind works for every Studio form.
alter table public.evidence_records
  drop constraint if exists evidence_records_subject_kind_check;

alter table public.evidence_records
  add constraint evidence_records_subject_kind_check
  check (subject_kind in (
    'work_item_attempt',
    'workflow_definition',
    'case_artifact',
    'release',
    'studio_qualification_run'
  ));
