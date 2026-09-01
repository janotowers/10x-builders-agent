-- ============================================================
-- 00083_case_relationships.sql
--
-- R1 Relationship Operations — SL-0, symbolic unit M-RELATIONSHIPS.
-- Technical Plan §2 TD-7 · ADR-109 (generic cross-domain Case relationships
-- and lineage).
--
-- A generic Case-to-Case edge primitive shared by every domain, landed early in
-- the substrate wave so duplicate canonicalization and supersession (SL-3) and
-- the Transaction association (SL-8b) build on it rather than reinventing it.
--
-- ADR-109 §9: relationships are Organization-contained. Both endpoints must
-- belong to the same Organization, and cross-organization relationships are NOT
-- enabled by weakening tenant isolation. That is enforced structurally here —
-- organization_id is NOT NULL and each endpoint carries a composite FK to
-- operational_cases(id, organization_id), so a cross-tenant edge cannot be
-- inserted at all, and a legacy NULL-Organization Case cannot be an endpoint.
--
-- ADR-109 §4: relationship mutations never touch either Case row. This table is
-- the only thing that changes; both timelines receive events separately.
-- ============================================================

create table public.case_relationships (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete cascade,

  from_case_id        uuid not null,
  to_case_id          uuid not null,

  relationship_type   text not null
                        check (relationship_type in (
                          'duplicate_of',
                          'superseded_by',
                          'split_from',
                          'transaction_association'
                        )),

  status              text not null default 'active'
                        check (status in ('active', 'ended')),

  created_by_user_id  uuid references public.profiles(id) on delete set null,
  actor_kind          text not null default 'human'
                        check (actor_kind in ('human', 'agent', 'system')),
  reason              text,
  evidence_refs_jsonb jsonb not null default '{}'::jsonb,
  provenance_jsonb    jsonb not null default '{}'::jsonb,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  ended_at            timestamptz,

  constraint case_relationships_no_self_edge
    check (from_case_id <> to_case_id),

  constraint case_relationships_ended_shape
    check (
      (status = 'ended' and ended_at is not null)
      or (status <> 'ended' and ended_at is null)
    ),

  -- Organization containment, structurally (ADR-109 §9).
  constraint case_relationships_from_case_same_org
    foreign key (from_case_id, organization_id)
    references public.operational_cases (id, organization_id),

  constraint case_relationships_to_case_same_org
    foreign key (to_case_id, organization_id)
    references public.operational_cases (id, organization_id)
);

comment on table public.case_relationships is
  'Generic directed Case-to-Case edges (duplicate_of, superseded_by, split_from, transaction_association). Organization-contained by ADR-109 §9, enforced by composite FKs on both endpoints. Mutations go through the authorized packages/db helper and never modify either Case row.';

comment on column public.case_relationships.relationship_type is
  'Typed registry mirrored in packages/types. Directed except transaction_association, which is a non-destructive business association: it never closes or supersedes the Opportunity.';

comment on column public.case_relationships.status is
  'active | ended. Edges are ended rather than deleted so lineage stays reconstructible.';

-- One active edge of a given type between a given ordered pair.
create unique index uq_case_relationships_active_edge
  on public.case_relationships (from_case_id, to_case_id, relationship_type)
  where status = 'active';

create index idx_case_relationships_from
  on public.case_relationships (from_case_id, relationship_type, status);

create index idx_case_relationships_to
  on public.case_relationships (to_case_id, relationship_type, status);

create index idx_case_relationships_organization
  on public.case_relationships (organization_id, status, updated_at desc);

-- ============================================================
-- RLS — membership reads, service-role writes.
--
-- Organization-owned from birth (organization_id NOT NULL), so no legacy path
-- exists and no restrictive guard is required.
-- ============================================================
alter table public.case_relationships enable row level security;

create policy "Org members read case relationships"
  on public.case_relationships for select
  to authenticated
  using (public.is_active_org_member(organization_id));

create policy "Service role manages case relationships"
  on public.case_relationships for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
