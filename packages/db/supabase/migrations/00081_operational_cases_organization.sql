-- ============================================================
-- 00081_operational_cases_organization.sql
--
-- R1 Relationship Operations — SL-0, symbolic unit M-CASE-ORG.
-- Technical Plan §2 TD-1 (access matrix) / TD-3 (runtime authority) / §3.
--
-- Brings Organization ownership to the Case surface, additively:
--   * operational_cases.organization_id (nullable — legacy rows stay NULL);
--   * operational_cases.runtime_authority (nullable — TD-3);
--   * unique (id, organization_id) as the composite-FK target that 00082 and
--     00083 need to express same-Organization guarantees as real FKs;
--   * the permissive + RESTRICTIVE policy composition described below.
--
-- WHY RESTRICTIVE: PERMISSIVE policies OR-compose, so adding a membership
-- policy alone could never revoke the legacy `auth.uid() = user_id` path on an
-- Organization-owned row — a revoked member would still reach rows they created.
-- A RESTRICTIVE policy ANDs across every permissive path, so it can. CURRENT
-- policy definitions are never touched; legacy rows (organization_id IS NULL)
-- keep byte-identical behavior.
--
-- WHY PER-COMMAND: the CURRENT "Users manage own cases" policy is PERMISSIVE
-- FOR ALL, so a single SELECT-shaped guard would leave a creator who is also an
-- active member holding direct UPDATE/DELETE on an Organization-owned row. The
-- approved contract is "writes server-only" (TD-1), so membership grants READ
-- only and every Organization-owned write goes through service-role/server
-- authorization (authorizeOrgAction). Writes on legacy rows are unchanged.
--
-- The restrictive policies target `TO authenticated` only, so service-role
-- paths are untouched and remain application-authorized by design.
-- ============================================================

-- ============================================================
-- Columns
-- ============================================================
alter table public.operational_cases
  add column organization_id uuid references public.organizations(id),
  add column runtime_authority text
    check (runtime_authority in ('legacy', 'gu_os'));

comment on column public.operational_cases.organization_id is
  'Owning Organization, or NULL for legacy user-scoped Cases. NULL rows keep their CURRENT owner semantics exactly; non-NULL rows are governed only by current active Membership.';

comment on column public.operational_cases.runtime_authority is
  'ADR-107 per-Opportunity runtime decision authority: legacy | gu_os. Deliberately nullable with no column default — relationship Cases are created with ''legacy'' by the admission path, and authority only moves through an authorized governed operation, never implicitly by Case creation.';

-- Composite-FK target. `id` is already the primary key, so this adds no new
-- uniqueness semantics; it exists so other tables can reference
-- (case_id, organization_id) and be structurally unable to cross tenants.
alter table public.operational_cases
  add constraint operational_cases_id_organization_key
    unique (id, organization_id);

create index idx_operational_cases_organization
  on public.operational_cases (organization_id, status, updated_at desc)
  where organization_id is not null;

-- ============================================================
-- operational_cases — permissive membership read + restrictive guards
-- ============================================================

-- (P) Active members can read their Organization's Cases.
create policy "Org members read organization cases"
  on public.operational_cases for select
  to authenticated
  using (
    organization_id is not null
    and public.is_active_org_member(organization_id)
  );

-- (R) Tenancy guard: legacy rows unaffected; Organization rows require CURRENT
-- active Membership even for the historical creator.
create policy "Org tenancy guard on cases"
  on public.operational_cases as restrictive for select
  to authenticated
  using (
    organization_id is null
    or public.is_active_org_member(organization_id)
  );

-- (R) Organization-owned rows are server-write only. Legacy rows keep the
-- CURRENT owner write path.
create policy "Organization cases are server-write only (insert)"
  on public.operational_cases as restrictive for insert
  to authenticated
  with check (organization_id is null);

-- The WITH CHECK half is load-bearing: without it an authenticated owner could
-- adopt their own legacy Case into an Organization by setting organization_id.
create policy "Organization cases are server-write only (update)"
  on public.operational_cases as restrictive for update
  to authenticated
  using (organization_id is null)
  with check (organization_id is null);

create policy "Organization cases are server-write only (delete)"
  on public.operational_cases as restrictive for delete
  to authenticated
  using (organization_id is null);

-- ============================================================
-- Case child surfaces — read only, resolved through the parent Case
--
-- Scope is exactly the four CURRENT child tables named in the TD-1 matrix.
-- work_items / work_item_attempts deliberately get NO new RLS in R1: Portfolio
-- access is server-authorized, and defense-in-depth there is deferred until a
-- user-JWT read path actually exists. artifact_inputs is likewise untouched.
--
-- These tables have SELECT-only authenticated policies today, and RLS is
-- deny-by-default, so no restrictive WRITE guard is needed here.
-- ============================================================

-- case_facts
create policy "Org members read organization case facts"
  on public.case_facts for select
  to authenticated
  using (
    exists (
      select 1
        from public.operational_cases c
       where c.id = case_facts.case_id
         and c.organization_id is not null
         and public.is_active_org_member(c.organization_id)
    )
  );

create policy "Org tenancy guard on case facts"
  on public.case_facts as restrictive for select
  to authenticated
  using (
    exists (
      select 1
        from public.operational_cases c
       where c.id = case_facts.case_id
         and (
           c.organization_id is null
           or public.is_active_org_member(c.organization_id)
         )
    )
  );

-- case_artifacts
create policy "Org members read organization case artifacts"
  on public.case_artifacts for select
  to authenticated
  using (
    exists (
      select 1
        from public.operational_cases c
       where c.id = case_artifacts.case_id
         and c.organization_id is not null
         and public.is_active_org_member(c.organization_id)
    )
  );

create policy "Org tenancy guard on case artifacts"
  on public.case_artifacts as restrictive for select
  to authenticated
  using (
    exists (
      select 1
        from public.operational_cases c
       where c.id = case_artifacts.case_id
         and (
           c.organization_id is null
           or public.is_active_org_member(c.organization_id)
         )
    )
  );

-- case_approvals
create policy "Org members read organization case approvals"
  on public.case_approvals for select
  to authenticated
  using (
    exists (
      select 1
        from public.operational_cases c
       where c.id = case_approvals.case_id
         and c.organization_id is not null
         and public.is_active_org_member(c.organization_id)
    )
  );

create policy "Org tenancy guard on case approvals"
  on public.case_approvals as restrictive for select
  to authenticated
  using (
    exists (
      select 1
        from public.operational_cases c
       where c.id = case_approvals.case_id
         and (
           c.organization_id is null
           or public.is_active_org_member(c.organization_id)
         )
    )
  );

-- operational_case_events
create policy "Org members read organization case events"
  on public.operational_case_events for select
  to authenticated
  using (
    exists (
      select 1
        from public.operational_cases c
       where c.id = operational_case_events.case_id
         and c.organization_id is not null
         and public.is_active_org_member(c.organization_id)
    )
  );

create policy "Org tenancy guard on case events"
  on public.operational_case_events as restrictive for select
  to authenticated
  using (
    exists (
      select 1
        from public.operational_cases c
       where c.id = operational_case_events.case_id
         and (
           c.organization_id is null
           or public.is_active_org_member(c.organization_id)
         )
    )
  );
