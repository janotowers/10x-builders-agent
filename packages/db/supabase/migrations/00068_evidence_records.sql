-- Slice 1.5 (flexible-workflows plan / Technical Plan §13): minimal evidence
-- records. Gate runs (lab checks, replay) persist hash-pinned pass/fail
-- evidence; artifact change invalidates prior evidence via the hash.
-- Append-only: evidence is audit data for release review.

create table public.evidence_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  subject_kind text not null
    check (subject_kind in (
      'work_item_attempt',
      'workflow_definition',
      'case_artifact',
      'release'
    )),
  subject_id uuid not null,
  gate text not null,
  artifact_hash text not null,
  result text not null check (result in ('pass', 'fail')),
  detail_jsonb jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index evidence_records_subject_idx
  on public.evidence_records (user_id, subject_kind, subject_id, created_at desc);

create index evidence_records_hash_idx
  on public.evidence_records (artifact_hash);

-- Append-only enforcement (same pattern as operational_case_events).
create or replace function public.evidence_records_reject_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'evidence_records is append-only';
end;
$$;

create trigger evidence_records_no_update
  before update on public.evidence_records
  for each row execute function public.evidence_records_reject_mutation();

create trigger evidence_records_no_delete
  before delete on public.evidence_records
  for each row execute function public.evidence_records_reject_mutation();

alter table public.evidence_records enable row level security;

create policy "Users read own evidence records"
  on public.evidence_records for select
  using (auth.uid() = user_id);

create policy "Service role manages evidence records"
  on public.evidence_records for all
  using (auth.role() = 'service_role');
