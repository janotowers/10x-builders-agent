-- ============================================================
-- 00080_organizations_core.sql
--
-- R1 Relationship Operations — SL-0, symbolic unit M-ORG (a).
-- Technical Plan §2 TD-1 / §3 · ADR-106 (organization-native multi-seat
-- tenancy with legacy identity bridge).
--
-- Organization core: the tenancy objects that depend on nothing else.
-- `external_identity_bindings` deliberately lands later (00082) because its
-- composite FK targets `operational_cases(id, organization_id)`, created in
-- 00081 — splitting M-ORG here is what breaks the unit-level dependency cycle.
--
-- Everything is additive. Nothing existing is modified: `account_feature_flags`
-- and `account_tool_secrets` keep their per-user semantics untouched.
--
-- Tenancy contract (TD-1 access matrix):
--   * these tables are Organization-owned from birth, so there is no legacy
--     `user_id` path to revoke and NO restrictive guard is needed here;
--   * reads = active Membership; writes = service role only;
--   * `organization_tool_secrets` is service-role only in both directions.
--
-- Membership lifecycle is SOFT: rows are never hard-deleted, deactivation
-- flips `status` so identity/provenance references stay resolvable. Identity is
-- not authorization: a membership row proves who belongs, `status='active'`
-- decides what they may do, and that is re-checked at action time.
-- ============================================================

-- ============================================================
-- organizations
-- ============================================================
create table public.organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  status      text not null default 'active'
                check (status in ('active', 'inactive')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint organizations_name_not_empty check (btrim(name) <> '')
);

comment on table public.organizations is
  'Organization (brokerage) tenant boundary introduced by ADR-106. R1 runs a single pilot Organization; the legacy identity bridge lives in external_identity_bindings (00082), never in this table.';

-- ============================================================
-- organization_memberships — who belongs to an Organization
-- ============================================================
create table public.organization_memberships (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  user_id          uuid not null references public.profiles(id) on delete cascade,
  role             text not null
                     check (role in ('owner', 'org_admin', 'advisor')),
  status           text not null default 'active'
                     check (status in ('active', 'inactive')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  unique (organization_id, user_id),
  -- Composite-FK target: lets other tables express "this row belongs to a
  -- member of THIS Organization" as a real FK instead of a trigger (00082).
  unique (id, organization_id)
);

comment on table public.organization_memberships is
  'Membership of a user in an Organization. Soft lifecycle: never hard-deleted, deactivation flips status so historical identity/provenance references stay resolvable. Role vocabulary is the initial migration mapping from legacy super-admin/admin/vendedor, not the permanent authorization model.';

comment on column public.organization_memberships.status is
  'active | inactive. Authorization is always evaluated against status=active at action time (authorizeOrgAction / is_active_org_member); an inactive membership keeps identity resolvable but grants nothing.';

create index idx_organization_memberships_user
  on public.organization_memberships (user_id, status);

create index idx_organization_memberships_org
  on public.organization_memberships (organization_id, status);

-- ============================================================
-- is_active_org_member — the single membership predicate used by RLS
--
-- SECURITY DEFINER so RLS policies can ask "is the current user an active
-- member of this Organization?" without recursing into organization_memberships
-- (which has its own policies). Hardening invariant, Technical Plan TD-1:
--   * `set search_path = ''` + fully schema-qualified references, so nothing
--     resolves through a caller-controlled search_path;
--   * EXECUTE revoked from PUBLIC, granted only to the roles that invoke it;
--   * STABLE and side-effect free, safe to call from a policy.
-- The repo's older security-definer functions (handle_new_user 00001,
-- match_memories* 00005/00006/00008/00011) qualify their references but set no
-- search_path; they are a partial precedent only and were not copied here.
--
-- Do NOT add FORCE ROW LEVEL SECURITY to organization_memberships: this
-- function depends on owner-bypass to avoid policy recursion.
-- ============================================================
create or replace function public.is_active_org_member(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.organization_memberships m
     where m.organization_id = p_organization_id
       and m.user_id = (select auth.uid())
       and m.status = 'active'
  );
$$;

comment on function public.is_active_org_member(uuid) is
  'True when the calling user has an ACTIVE membership in the given Organization. Used by RLS policies on Organization-owned rows. SECURITY DEFINER with a fixed empty search_path and fully qualified references; EXECUTE restricted.';

revoke execute on function public.is_active_org_member(uuid) from public;
grant execute on function public.is_active_org_member(uuid) to authenticated, service_role;

-- ============================================================
-- contacts — Organization-scoped person records
--
-- Contact truth stays referential: NO legacy-lead mirror fields. One contact
-- may carry n legacy_lead bindings and participate in n Opportunities.
-- ============================================================
create table public.contacts (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  display_name        text,
  primary_phone_hint  text,
  preferences_jsonb   jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- Composite-FK target for same-Organization guarantees (00082).
  unique (id, organization_id)
);

comment on table public.contacts is
  'Organization-scoped contact. Minimal display fields only; external identity lives in external_identity_bindings and preferences carry their own provenance in preferences_jsonb.';

comment on column public.contacts.preferences_jsonb is
  'Contact-scoped preferences with per-entry provenance (S2). Not authorization data.';

create index idx_contacts_organization
  on public.contacts (organization_id, updated_at desc);

-- ============================================================
-- organization_feature_flags — rollout flags resolved at Organization scope
--
-- Mirrors account_feature_flags (00067) but Organization-scoped: every
-- authority-bearing R1 flag resolves here and never per member, so two advisors
-- of one Organization can never see conflicting authority behavior. Env vars
-- remain global kill-switches.
-- ============================================================
create table public.organization_feature_flags (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  flag_key         text not null,
  enabled          boolean not null default false,
  value_text       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  unique (organization_id, flag_key)
);

comment on table public.organization_feature_flags is
  'Organization-scoped rollout flags (relationship_ops, relationship_admission_mode, relationship_send_effects, ...). Resolved only at Organization scope — never per member, never with a per-user fallback.';

create index idx_organization_feature_flags_lookup
  on public.organization_feature_flags (organization_id, flag_key);

-- ============================================================
-- organization_tool_secrets — Organization-scoped provider credentials
--
-- Same AES-256-GCM helpers as account_tool_secrets (encryptJson/decryptJson);
-- that table stays untouched. Unlike it, this one is service-role only in BOTH
-- directions: credentials are never exposed to a user JWT.
-- ============================================================
create table public.organization_tool_secrets (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null references public.organizations(id) on delete cascade,
  provider                text not null,
  config_jsonb            jsonb not null default '{}'::jsonb,
  encrypted_secret_jsonb  text not null default '',
  status                  text not null default 'pending_test'
                            check (status in (
                              'pending_test',
                              'active',
                              'invalid',
                              'disconnected'
                            )),
  last_checked_at         timestamptz,
  last_used_at            timestamptz,
  last_error              text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  unique (organization_id, provider)
);

comment on table public.organization_tool_secrets is
  'Organization-scoped credentials for tenant-dependent providers (traditional_gu_firestore, traditional_gu_mongo, later traditional_gu_api). encrypted_secret_jsonb is AES-256-GCM (ENCRYPTION_KEY), same helpers as account_tool_secrets. Service-role only in both directions.';

create index idx_organization_tool_secrets_org
  on public.organization_tool_secrets (organization_id, status, updated_at desc);

-- ============================================================
-- RLS — membership reads, service-role writes
--
-- No restrictive guard on these tables: they are Organization-owned from birth,
-- so no pre-existing permissive user_id path exists that would need revoking.
-- ============================================================
alter table public.organizations              enable row level security;
alter table public.organization_memberships   enable row level security;
alter table public.contacts                   enable row level security;
alter table public.organization_feature_flags enable row level security;
alter table public.organization_tool_secrets  enable row level security;

create policy "Members read own organizations"
  on public.organizations for select
  to authenticated
  using (public.is_active_org_member(id));

create policy "Service role manages organizations"
  on public.organizations for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create policy "Members read organization memberships"
  on public.organization_memberships for select
  to authenticated
  using (public.is_active_org_member(organization_id));

create policy "Service role manages organization memberships"
  on public.organization_memberships for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create policy "Members read organization contacts"
  on public.contacts for select
  to authenticated
  using (public.is_active_org_member(organization_id));

create policy "Service role manages contacts"
  on public.contacts for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create policy "Members read organization feature flags"
  on public.organization_feature_flags for select
  to authenticated
  using (public.is_active_org_member(organization_id));

create policy "Service role manages organization feature flags"
  on public.organization_feature_flags for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- Credentials: no authenticated read path at all.
create policy "Service role manages organization tool secrets"
  on public.organization_tool_secrets for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
