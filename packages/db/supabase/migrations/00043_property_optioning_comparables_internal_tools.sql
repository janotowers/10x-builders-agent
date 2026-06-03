-- ============================================================
-- 00043_property_optioning_comparables_internal_tools.sql
--
-- Documenta en el flow de UI (readiness) las tools internas del paso
-- comparables_in_progress. El runtime ya las usa vía SKILL.md; esto solo
-- muestra «Herramientas internas» en Paso 3 y evita que
-- operational_case_persist_comparables_analysis quede en transversales.
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
        'tool_id', 'operational_case_persist_comparables_analysis',
        'tool_label', 'Persistir análisis de comparables',
        'tool_description', 'Construye comparables_analysis en el caso desde los resultados de búsqueda del turno (no escribir el JSON a mano).'
      ),
      jsonb_build_object(
        'tool_id', 'operational_case_update_state',
        'tool_label', 'Actualizar estado del caso',
        'tool_description', 'Transición de paso y status tras el análisis de mercado.'
      ),
      jsonb_build_object(
        'tool_id', 'operational_case_add_event',
        'tool_label', 'Registrar evento en el caso',
        'tool_description', 'Auditoría y decisiones sin cambio de estado en este hito.'
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
      where tool->>'tool_id' = 'operational_case_persist_comparables_analysis'
    )
) targets
where public.operational_case_types.id = targets.case_type_id;
