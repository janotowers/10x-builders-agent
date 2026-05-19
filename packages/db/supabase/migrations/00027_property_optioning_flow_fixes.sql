-- ============================================================
-- 00027_property_optioning_flow_fixes.sql
--
-- Ajustes al operational_flow_jsonb de property_optioning:
-- - Mapear calendar_update_event al paso "Coordinar fotos"
--   (faltaba aunque calendar_create_event ya estaba, lo cual dejaba
--    reagendar/actualizar sin paso).
-- - Mapear bigquery_run_query al paso "Análisis de comparables" como
--   tool técnica subyacente (estaba en allowed_tools del compuesto pero
--   sin paso visible).
--
-- Las demás tools que quedan sin paso son transversales/soporte:
-- operational_case_add_event, get_user_preferences, read_skill_reference.
-- La UI las muestra como bloque "Herramientas transversales", no como
-- un paso numerado.
-- ============================================================

update public.operational_case_types
set
  operational_flow_jsonb = jsonb_set(
    operational_flow_jsonb,
    array[step_idx::text, 'step_skills', skill_idx::text, 'skill_tools'],
    coalesce(
      operational_flow_jsonb #> array[step_idx::text, 'step_skills', skill_idx::text, 'skill_tools'],
      '[]'::jsonb
    ) || jsonb_build_array(
      jsonb_build_object(
        'tool_id', 'calendar_update_event',
        'tool_label', 'Actualizar evento de calendario',
        'tool_description', 'Reagenda o ajusta una sesión de fotos previamente coordinada.'
      )
    ),
    true
  ),
  updated_at = now()
from (
  select
    oct.id as case_type_id,
    step_pos.idx - 1 as step_idx,
    skill_pos.idx - 1 as skill_idx
  from public.operational_case_types oct,
       jsonb_array_elements(oct.operational_flow_jsonb)
         with ordinality as step_pos(step, idx),
       jsonb_array_elements(coalesce(step_pos.step->'step_skills', '[]'::jsonb))
         with ordinality as skill_pos(skill, idx)
  where oct.case_type = 'property_optioning'
    and step_pos.step->>'step_key' = 'photos_scheduled'
    and skill_pos.skill->>'skill_slug' = 'coordinate-photo-session'
    and not exists (
      select 1
      from jsonb_array_elements(coalesce(skill_pos.skill->'skill_tools', '[]'::jsonb)) tool
      where tool->>'tool_id' = 'calendar_update_event'
    )
) targets
where public.operational_case_types.id = targets.case_type_id;

update public.operational_case_types
set
  operational_flow_jsonb = jsonb_set(
    operational_flow_jsonb,
    array[step_idx::text, 'step_skills', skill_idx::text, 'skill_tools', tool_idx::text, 'tool_description'],
    to_jsonb('Publica la ficha en Ungga vía CLI/browser automation; la API queda como alternativa futura.'::text),
    false
  ),
  updated_at = now()
from (
  select
    oct.id as case_type_id,
    step_pos.idx - 1 as step_idx,
    skill_pos.idx - 1 as skill_idx,
    tool_pos.idx - 1 as tool_idx
  from public.operational_case_types oct,
       jsonb_array_elements(oct.operational_flow_jsonb)
         with ordinality as step_pos(step, idx),
       jsonb_array_elements(coalesce(step_pos.step->'step_skills', '[]'::jsonb))
         with ordinality as skill_pos(skill, idx),
       jsonb_array_elements(coalesce(skill_pos.skill->'skill_tools', '[]'::jsonb))
         with ordinality as tool_pos(tool, idx)
  where oct.case_type = 'property_optioning'
    and tool_pos.tool->>'tool_id' = 'ungga_publish_listing'
) targets
where public.operational_case_types.id = targets.case_type_id;

update public.operational_case_types
set
  operational_flow_jsonb = jsonb_set(
    operational_flow_jsonb,
    array[step_idx::text, 'step_skills', skill_idx::text, 'skill_tools'],
    coalesce(
      operational_flow_jsonb #> array[step_idx::text, 'step_skills', skill_idx::text, 'skill_tools'],
      '[]'::jsonb
    ) || jsonb_build_array(
      jsonb_build_object(
        'tool_id', 'bigquery_run_query',
        'tool_label', 'Consulta SQL directa (BigQuery)',
        'tool_description', 'Tool técnica subyacente para consultas ad-hoc; normalmente se usa el wrapper Consultar comparables internos.'
      )
    ),
    true
  ),
  updated_at = now()
from (
  select
    oct.id as case_type_id,
    step_pos.idx - 1 as step_idx,
    skill_pos.idx - 1 as skill_idx
  from public.operational_case_types oct,
       jsonb_array_elements(oct.operational_flow_jsonb)
         with ordinality as step_pos(step, idx),
       jsonb_array_elements(coalesce(step_pos.step->'step_skills', '[]'::jsonb))
         with ordinality as skill_pos(skill, idx)
  where oct.case_type = 'property_optioning'
    and step_pos.step->>'step_key' = 'comparables_in_progress'
    and skill_pos.skill->>'skill_slug' = 'perform-comparable-analysis'
    and not exists (
      select 1
      from jsonb_array_elements(coalesce(skill_pos.skill->'skill_tools', '[]'::jsonb)) tool
      where tool->>'tool_id' = 'bigquery_run_query'
    )
) targets
where public.operational_case_types.id = targets.case_type_id;
