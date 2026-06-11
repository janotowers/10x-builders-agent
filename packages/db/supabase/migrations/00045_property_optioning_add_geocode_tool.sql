-- ============================================================
-- 00045_property_optioning_add_geocode_tool.sql
--
-- Expone geocode_property_address en el Paso 3 (comparables_in_progress)
-- dentro de perform-comparable-analysis para readiness UI (N1/N3/N4).
-- Aplica a plantillas globales y case types por-tenant.
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
        'tool_id', 'geocode_property_address',
        'tool_label', 'Geocodificar dirección',
        'tool_description', 'Resuelve latitud/longitud de una dirección para enriquecer comparables y valuación cuando no hay coordenadas.'
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
      where tool->>'tool_id' = 'geocode_property_address'
    )
) targets
where public.operational_case_types.id = targets.case_type_id;
