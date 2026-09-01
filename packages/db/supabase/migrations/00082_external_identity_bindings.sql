-- ============================================================
-- 00082_external_identity_bindings.sql
--
-- R1 Relationship Operations — SL-0, symbolic unit M-ORG (b).
-- Technical Plan §2 TD-1 · ADR-106 (legacy identity bridge).
--
-- The bridge between Traditional Gu identities and Gu OS objects. Lands after
-- 00081 because its same-Organization guarantees are expressed as real
-- composite FKs against operational_cases(id, organization_id).
--
-- Two rules govern this table:
--   1. External ids are OPAQUE. They are stored and compared, never parsed.
--   2. A binding is routing/identity/provenance data — it can never grant
--      authority. Every action independently passes membership/authority/policy
--      gates, which is also why this table has no authenticated read path.
--
-- Referential integrity is structural, not conventional: exactly one typed ref
-- column is set, and each one carries a composite FK that makes a cross-tenant
-- reference impossible rather than merely non-dangling.
-- ============================================================

create table public.external_identity_bindings (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references public.organizations(id) on delete cascade,

  source_system        text not null
                         check (source_system in ('traditional_gu')),
  binding_kind         text not null
                         check (binding_kind in (
                           'legacy_organization_key',
                           'legacy_user',
                           'gu_whatsapp_number',
                           'advisor_whatsapp_endpoint',
                           'legacy_lead',
                           'prospect_channel'
                         )),
  external_id          text not null,

  -- Typed reference columns — exactly one is set (see CHECK below).
  ref_organization_id  uuid,
  ref_membership_id    uuid,
  ref_contact_id       uuid,
  ref_case_id          uuid,

  verification_jsonb   jsonb not null default '{}'::jsonb,
  provenance_jsonb     jsonb not null default '{}'::jsonb,

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint external_identity_bindings_external_id_not_empty
    check (btrim(external_id) <> ''),

  -- Exactly one typed reference. A deliberate deviation from the CURRENT
  -- artifact_inputs no-FK precedent: this is a security boundary.
  constraint external_identity_bindings_exactly_one_ref
    check (
      (ref_organization_id is not null)::int
      + (ref_membership_id is not null)::int
      + (ref_contact_id    is not null)::int
      + (ref_case_id       is not null)::int
      = 1
    ),

  -- A self-referencing Organization binding may only name its own Organization.
  constraint external_identity_bindings_ref_organization_same_org
    check (ref_organization_id is null or ref_organization_id = organization_id),

  -- Same-Organization guarantees as real composite FKs (no triggers).
  -- Person identity binds through the MEMBERSHIP row, not the profile: the
  -- membership carries the person-Organization pair, so the FK expresses
  -- same-Organization membership existence directly. The binding stays
  -- historically true when that membership goes inactive — identity is not
  -- authorization.
  constraint external_identity_bindings_membership_same_org
    foreign key (ref_membership_id, organization_id)
    references public.organization_memberships (id, organization_id),

  constraint external_identity_bindings_contact_same_org
    foreign key (ref_contact_id, organization_id)
    references public.contacts (id, organization_id),

  -- Also structurally prevents binding a legacy Case, whose organization_id is
  -- NULL and therefore cannot match a NOT NULL organization_id here.
  constraint external_identity_bindings_case_same_org
    foreign key (ref_case_id, organization_id)
    references public.operational_cases (id, organization_id),

  -- Base rule: an external id resolves once per Organization.
  unique (organization_id, source_system, binding_kind, external_id)
);

comment on table public.external_identity_bindings is
  'Maps opaque Traditional Gu external identifiers to Gu OS objects (Organization, membership, contact, Case). Routing/identity/provenance only — never an authority grant. Service-role only; external_id is never parsed.';

comment on column public.external_identity_bindings.external_id is
  'Opaque external identifier. Composite legacy identities (e.g. lead_id) are stored whole and compared whole; no component is ever parsed out.';

comment on column public.external_identity_bindings.ref_membership_id is
  'Person identity binds through the membership row (soft lifecycle, never hard-deleted) so the composite FK can express same-Organization membership. Remains resolvable for historical provenance after deactivation.';

-- Routing-critical kinds must resolve to exactly ONE Organization globally:
-- inbound event routing cannot be ambiguous. Kinds that are not
-- source-guaranteed Organization-exclusive stay Organization-scoped only.
create unique index uq_external_identity_bindings_global_routing
  on public.external_identity_bindings (source_system, binding_kind, external_id)
  where binding_kind in (
    'legacy_organization_key',
    'legacy_user',
    'gu_whatsapp_number',
    'legacy_lead'
  );

create index idx_external_identity_bindings_org
  on public.external_identity_bindings (organization_id, binding_kind);

create index idx_external_identity_bindings_ref_case
  on public.external_identity_bindings (ref_case_id)
  where ref_case_id is not null;

create index idx_external_identity_bindings_ref_contact
  on public.external_identity_bindings (ref_contact_id)
  where ref_contact_id is not null;

-- Operational/security internal: no authenticated read path at all.
alter table public.external_identity_bindings enable row level security;

create policy "Service role manages external identity bindings"
  on public.external_identity_bindings for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- ============================================================
-- bootstrap_organization — generic, idempotent Organization resolve-or-create
--
-- Generic on purpose: no pilot-specific data lives in a schema migration. The
-- caller supplies the legacy key; the operational script applies it per tenant.
--
-- Convergence contract:
--   * the BINDING is the identity anchor, never the Organization name — a name
--     match must never imply identity;
--   * Organization + binding are created in ONE invocation, so a partial
--     failure cannot leave an Organization without its binding (the exception
--     handler rolls the whole block back);
--   * on a lost race the unique_violation handler re-reads and returns the
--     existing Organization, so concurrent or replayed runs converge on one.
--
-- Privilege guardrail: this creates tenancy and identity, so it stays
-- SECURITY INVOKER (never DEFINER) with EXECUTE revoked from PUBLIC/anon/
-- authenticated and granted only to service_role. Under invoker rights a user
-- JWT is additionally stopped by the service-role-only RLS above.
-- ============================================================
create or replace function public.bootstrap_organization(
  p_legacy_key text,
  p_org_name   text default null
)
returns uuid
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_organization_id uuid;
begin
  if p_legacy_key is null or btrim(p_legacy_key) = '' then
    raise exception 'bootstrap_organization: p_legacy_key is required';
  end if;

  select b.organization_id
    into v_organization_id
    from public.external_identity_bindings b
   where b.source_system = 'traditional_gu'
     and b.binding_kind  = 'legacy_organization_key'
     and b.external_id   = p_legacy_key;

  if v_organization_id is not null then
    return v_organization_id;
  end if;

  insert into public.organizations (name)
  values (coalesce(nullif(btrim(p_org_name), ''), p_legacy_key))
  returning id into v_organization_id;

  insert into public.external_identity_bindings (
    organization_id,
    source_system,
    binding_kind,
    external_id,
    ref_organization_id,
    provenance_jsonb
  )
  values (
    v_organization_id,
    'traditional_gu',
    'legacy_organization_key',
    p_legacy_key,
    v_organization_id,
    jsonb_build_object('source', 'bootstrap_organization')
  );

  return v_organization_id;

exception
  when unique_violation then
    select b.organization_id
      into v_organization_id
      from public.external_identity_bindings b
     where b.source_system = 'traditional_gu'
       and b.binding_kind  = 'legacy_organization_key'
       and b.external_id   = p_legacy_key;

    if v_organization_id is null then
      raise;
    end if;

    return v_organization_id;
end;
$$;

comment on function public.bootstrap_organization(text, text) is
  'Idempotent resolve-or-create of an Organization from an opaque legacy organization key. Returns the existing Organization when the binding already exists. SECURITY INVOKER; EXECUTE restricted to service_role.';

revoke execute on function public.bootstrap_organization(text, text) from public;
revoke execute on function public.bootstrap_organization(text, text) from anon;
revoke execute on function public.bootstrap_organization(text, text) from authenticated;
grant  execute on function public.bootstrap_organization(text, text) to service_role;
