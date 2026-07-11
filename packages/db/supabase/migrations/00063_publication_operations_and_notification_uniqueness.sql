-- ============================================================
-- 00063_publication_operations_and_notification_uniqueness.sql
--
-- Ledger idempotente de side effects de publicación + unicidad
-- de notificaciones activas por (user, case, kind).
-- ============================================================

create table if not exists public.publication_operations (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.operational_cases(id) on delete cascade,
  destination text not null check (destination in ('easybroker', 'ungga', 'manual')),
  operation_key text not null,
  operation_type text not null,
  status text not null
    check (status in ('claimed', 'running', 'succeeded', 'failed', 'unknown_outcome')),
  request_jsonb jsonb not null default '{}'::jsonb,
  result_jsonb jsonb not null default '{}'::jsonb,
  error_text text,
  claimed_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint publication_operations_unique_key
    unique (case_id, destination, operation_key)
);

create index if not exists idx_publication_operations_case_status
  on public.publication_operations (case_id, status, created_at desc);

create index if not exists idx_publication_operations_destination
  on public.publication_operations (destination, status);

alter table public.publication_operations enable row level security;

create policy "Service role full access to publication_operations"
  on public.publication_operations for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

comment on table public.publication_operations is
  'Ledger idempotente de operaciones externas de publicación (create/upload/publish).';

-- Deduplicate unread notifications for the same (user, case, kind): keep oldest.
with ranked as (
  select
    id,
    row_number() over (
      partition by user_id, case_id, kind
      order by created_at asc, id asc
    ) as rn
  from public.internal_user_notifications
  where status = 'unread'
    and case_id is not null
)
update public.internal_user_notifications n
set
  status = 'dismissed',
  updated_at = now(),
  metadata_jsonb = coalesce(n.metadata_jsonb, '{}'::jsonb)
    || jsonb_build_object(
      'dismissed_reason', 'duplicate_active_notification_migration',
      'dismissed_at', now()
    )
from ranked r
where n.id = r.id
  and r.rn > 1;

-- Unique active notification per (user, case, kind).
create unique index if not exists idx_internal_user_notifications_active_unique
  on public.internal_user_notifications (user_id, case_id, kind)
  where status = 'unread' and case_id is not null;
