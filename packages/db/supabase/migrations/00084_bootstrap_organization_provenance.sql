-- ============================================================
-- 00084_bootstrap_organization_provenance.sql
--
-- R1 Relationship Operations — SL-0 amendment (T5b preparation).
-- Technical Plan §2 TD-1 · ADR-106 · legacy-source-audit §4.2/§4.4/§4.5.
--
-- WHY THIS EXISTS
--
-- The bootstrap RPC landed in 00082 taking a single opaque key. First-hand
-- legacy-source verification then established that Traditional Gu's stored
-- `organization_id` and its NORMALIZED organization identity are different
-- strings:
--
--   raw stored representation : users/<ownerUid>   (Firestore path form)
--   normalized identity       : <ownerUid>          (bare owner UID, produced
--                                                    by ownerUidFromOrganization()
--                                                    and consumed by ownerUidOf()
--                                                    and guardLeadOneController)
--
-- Only the bare owner UID may be the external routing key. The raw path form is
-- source/provenance: it explains where the key came from and lets a later
-- reconciliation recognise the legacy representation, but nothing routes on it.
--
-- The old two-argument signature could not express that difference — a caller
-- had one slot and had to choose. This migration replaces it with a signature
-- that takes both, and persists them in the SAME statement as the Organization
-- and its binding, so provenance can never be lost to a partial failure and is
-- never written by a second UPDATE afterwards.
--
-- Inbound WhatsApp routing remains a SEPARATE external identity: it binds as
-- `gu_whatsapp_number`, never as `legacy_organization_key`. The organization
-- key anchors identity; the Gu number routes events.
--
-- ORGANIZATION IDENTITY INPUTS ARE NOT MEMBERSHIP INPUTS
--
-- This function takes no member argument and creates no membership, by design.
-- The profile a legacy identity happens to be DISCOVERED on (for example a
-- development profile whose business_brain was pointed at the pilot's legacy
-- context) must never become a member as a side effect of that discovery.
-- Membership is always supplied explicitly, with an explicit role, through
-- organization_memberships — see ADR-106 §2 (membership is first-class) and
-- §4.3 of the legacy audit (legacy claims are not Gu OS grants).
-- ============================================================

-- The superseded signature must not survive as an alternate path: CREATE OR
-- REPLACE with different argument names/arity would leave an OVERLOAD, so a
-- caller could still reach the old contract and store an un-normalized key.
-- Drop it explicitly, then create the new one.
drop function if exists public.bootstrap_organization(text, text);

create or replace function public.bootstrap_organization(
  p_legacy_organization_key text,
  p_raw_legacy_source       text default null,
  p_org_name                text default null
)
returns uuid
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_organization_id uuid;
  v_provenance      jsonb;
begin
  if p_legacy_organization_key is null
     or btrim(p_legacy_organization_key) = '' then
    raise exception
      'bootstrap_organization: p_legacy_organization_key is required (normalized bare owner UID, not the raw users/<uid> path)';
  end if;

  -- Resolve by binding: the binding is the identity anchor, never the name.
  select b.organization_id
    into v_organization_id
    from public.external_identity_bindings b
   where b.source_system = 'traditional_gu'
     and b.binding_kind  = 'legacy_organization_key'
     and b.external_id   = p_legacy_organization_key;

  if v_organization_id is not null then
    -- Reuse path stays read-only. Provenance is captured at creation time; a
    -- re-run must not rewrite the identity record of an existing Organization.
    return v_organization_id;
  end if;

  v_provenance := jsonb_strip_nulls(
    jsonb_build_object(
      'source',            'bootstrap_organization',
      'raw_legacy_source', p_raw_legacy_source
    )
  );

  insert into public.organizations (name)
  values (coalesce(nullif(btrim(p_org_name), ''), p_legacy_organization_key))
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
    p_legacy_organization_key,
    v_organization_id,
    v_provenance
  );

  return v_organization_id;

exception
  when unique_violation then
    -- Concurrency/replay: another run won the race. The whole block rolls back,
    -- so no orphan Organization survives; re-read and converge on the existing
    -- one instead of failing.
    select b.organization_id
      into v_organization_id
      from public.external_identity_bindings b
     where b.source_system = 'traditional_gu'
       and b.binding_kind  = 'legacy_organization_key'
       and b.external_id   = p_legacy_organization_key;

    if v_organization_id is null then
      raise;
    end if;

    return v_organization_id;
end;
$$;

comment on function public.bootstrap_organization(text, text, text) is
  'Idempotent resolve-or-create of an Organization from the NORMALIZED legacy organization key (bare owner UID). The raw legacy representation (e.g. users/<uid>) is recorded as provenance in the same statement, never as the routing key. Creates no membership: membership is always supplied explicitly with an explicit role. SECURITY INVOKER; EXECUTE restricted to service_role.';

-- A newly created function grants EXECUTE to PUBLIC by default, so the
-- guardrail must be re-applied here — this function creates tenancy and
-- identity and must never be callable by anon or authenticated.
revoke execute on function public.bootstrap_organization(text, text, text) from public;
revoke execute on function public.bootstrap_organization(text, text, text) from anon;
revoke execute on function public.bootstrap_organization(text, text, text) from authenticated;
grant  execute on function public.bootstrap_organization(text, text, text) to service_role;
