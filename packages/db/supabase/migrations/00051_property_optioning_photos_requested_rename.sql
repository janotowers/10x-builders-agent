-- ============================================================
-- 00051_property_optioning_photos_requested_rename.sql
--
-- Rename limpio del paso 6 y su skill:
--   photos_scheduled -> photos_requested
--   coordinate-photo-session -> request-property-photos
--
-- Incluye actualización de flujos, casos, runs de test, metadata de tool calls,
-- account_skills y payload histórico de eventos.
-- ============================================================

-- 1) Flow JSON del case type (global + tenant overrides)
update public.operational_case_types oct
set
  operational_flow_jsonb = replace(
    replace(
      oct.operational_flow_jsonb::text,
      '"photos_scheduled"',
      '"photos_requested"'
    ),
    '"coordinate-photo-session"',
    '"request-property-photos"'
  )::jsonb,
  updated_at = now()
where oct.case_type = 'property_optioning'
  and (
    oct.operational_flow_jsonb::text like '%photos_scheduled%'
    or oct.operational_flow_jsonb::text like '%coordinate-photo-session%'
  );

-- 2) Casos existentes
update public.operational_cases
set
  current_step = 'photos_requested',
  context_jsonb = replace(
    replace(
      context_jsonb::text,
      'photos_scheduled_request_internal_photos',
      'photos_requested_request_internal_photos'
    ),
    'photos_scheduled',
    'photos_requested'
  )::jsonb,
  updated_at = now()
where case_type = 'property_optioning'
  and (
    current_step = 'photos_scheduled'
    or context_jsonb::text like '%photos_scheduled%'
  );

-- 3) Historial de pruebas N3/N4
update public.operational_case_test_runs
set
  step_key = case
    when step_key = 'photos_scheduled' then 'photos_requested'
    else step_key
  end,
  skill_slug = case
    when skill_slug = 'coordinate-photo-session' then 'request-property-photos'
    else skill_slug
  end,
  scenario_id = case
    when scenario_id = 'photos_scheduled_request_internal_photos'
      then 'photos_requested_request_internal_photos'
    else scenario_id
  end,
  request_jsonb = replace(
    replace(
      replace(request_jsonb::text, 'photos_scheduled_request_internal_photos', 'photos_requested_request_internal_photos'),
      'photos_scheduled',
      'photos_requested'
    ),
    'coordinate-photo-session',
    'request-property-photos'
  )::jsonb,
  result_jsonb = replace(
    replace(
      replace(result_jsonb::text, 'photos_scheduled_request_internal_photos', 'photos_requested_request_internal_photos'),
      'photos_scheduled',
      'photos_requested'
    ),
    'coordinate-photo-session',
    'request-property-photos'
  )::jsonb,
  updated_at = now()
where
  step_key = 'photos_scheduled'
  or skill_slug = 'coordinate-photo-session'
  or scenario_id = 'photos_scheduled_request_internal_photos'
  or request_jsonb::text like '%photos_scheduled%'
  or request_jsonb::text like '%coordinate-photo-session%'
  or result_jsonb::text like '%photos_scheduled%'
  or result_jsonb::text like '%coordinate-photo-session%';

-- 4) Metadata de tool calls (auditoría por paso/skill)
update public.tool_calls
set metadata_jsonb = replace(
  replace(
    metadata_jsonb::text,
    '"photos_scheduled"',
    '"photos_requested"'
  ),
  '"coordinate-photo-session"',
  '"request-property-photos"'
)::jsonb
where metadata_jsonb::text like '%photos_scheduled%'
   or metadata_jsonb::text like '%coordinate-photo-session%';

-- 5) account_skills override por usuario (si existen)
update public.account_skills
set
  slug = 'request-property-photos',
  body_md = replace(body_md, 'coordinate-photo-session', 'request-property-photos'),
  metadata_jsonb = replace(
    metadata_jsonb::text,
    'coordinate-photo-session',
    'request-property-photos'
  )::jsonb,
  updated_at = now()
where slug = 'coordinate-photo-session';

-- 6) Timeline histórica (append-only): patch temporal de triggers
do $$
begin
  if exists (
    select 1
    from pg_trigger
    where tgname = 'operational_case_events_no_update'
      and tgrelid = 'public.operational_case_events'::regclass
  ) then
    execute 'alter table public.operational_case_events disable trigger operational_case_events_no_update';
  end if;

  if exists (
    select 1
    from pg_trigger
    where tgname = 'operational_case_events_no_delete'
      and tgrelid = 'public.operational_case_events'::regclass
  ) then
    execute 'alter table public.operational_case_events disable trigger operational_case_events_no_delete';
  end if;
end
$$;

update public.operational_case_events e
set payload_jsonb = replace(
  replace(
    replace(e.payload_jsonb::text, 'photos_scheduled_request_internal_photos', 'photos_requested_request_internal_photos'),
    'photos_scheduled',
    'photos_requested'
  ),
  'coordinate-photo-session',
  'request-property-photos'
)::jsonb
where e.payload_jsonb::text like '%photos_scheduled%'
   or e.payload_jsonb::text like '%coordinate-photo-session%';

do $$
begin
  if exists (
    select 1
    from pg_trigger
    where tgname = 'operational_case_events_no_update'
      and tgrelid = 'public.operational_case_events'::regclass
  ) then
    execute 'alter table public.operational_case_events enable trigger operational_case_events_no_update';
  end if;

  if exists (
    select 1
    from pg_trigger
    where tgname = 'operational_case_events_no_delete'
      and tgrelid = 'public.operational_case_events'::regclass
  ) then
    execute 'alter table public.operational_case_events enable trigger operational_case_events_no_delete';
  end if;
end
$$;
