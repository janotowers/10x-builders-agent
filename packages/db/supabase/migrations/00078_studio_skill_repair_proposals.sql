-- ============================================================
-- 00078_studio_skill_repair_proposals.sql
--
-- Human-triggered, bounded repair proposals for failed reusable-skill
-- qualifications. account_skills V1 has one mutable row per user/slug, so a
-- proposal is kept separate until a future explicit review/apply action.
-- ============================================================

create table if not exists public.studio_skill_repair_proposals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  source_skill_id uuid not null references public.account_skills(id) on delete cascade,
  source_run_id uuid not null references public.studio_qualification_runs(id) on delete cascade,
  source_fingerprint text not null,
  source_skill_version integer not null check (source_skill_version > 0),
  repair_iteration integer not null check (repair_iteration >= 1 and repair_iteration <= 3),
  idempotency_key text not null,

  status text not null default 'generating'
    check (status in ('generating', 'proposed', 'failed')),
  proposed_body_md text,
  proposed_metadata_jsonb jsonb,
  compiler_model_id text,
  failure_jsonb jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint studio_skill_repair_source_fingerprint_not_empty
    check (btrim(source_fingerprint) <> ''),
  constraint studio_skill_repair_idempotency_key_not_empty
    check (btrim(idempotency_key) <> ''),
  constraint studio_skill_repair_terminal_shape
    check (
      (status = 'generating'
        and proposed_body_md is null
        and proposed_metadata_jsonb is null
        and failure_jsonb is null)
      or
      (status = 'proposed'
        and proposed_body_md is not null
        and btrim(proposed_body_md) <> ''
        and proposed_metadata_jsonb is not null
        and compiler_model_id is not null
        and failure_jsonb is null)
      or
      (status = 'failed'
        and proposed_body_md is null
        and proposed_metadata_jsonb is null
        and failure_jsonb is not null)
    ),

  unique (user_id, source_run_id),
  unique (user_id, idempotency_key)
);

comment on table public.studio_skill_repair_proposals is
  'Review-only reusable-skill repair proposals. Generation never mutates, activates, publishes, or automatically requalifies account_skills.';

create index if not exists idx_studio_skill_repair_proposals_user_created
  on public.studio_skill_repair_proposals (user_id, created_at desc);

alter table public.studio_skill_repair_proposals enable row level security;

drop policy if exists "Users read own studio skill repair proposals"
  on public.studio_skill_repair_proposals;
create policy "Users read own studio skill repair proposals"
  on public.studio_skill_repair_proposals for select
  using (auth.uid() = user_id);

drop policy if exists "Service role manages studio skill repair proposals"
  on public.studio_skill_repair_proposals;
create policy "Service role manages studio skill repair proposals"
  on public.studio_skill_repair_proposals for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

drop trigger if exists trg_studio_skill_repair_proposals_updated_at
  on public.studio_skill_repair_proposals;
create trigger trg_studio_skill_repair_proposals_updated_at
  before update on public.studio_skill_repair_proposals
  for each row execute function public.studio_qualification_runs_set_updated_at();
