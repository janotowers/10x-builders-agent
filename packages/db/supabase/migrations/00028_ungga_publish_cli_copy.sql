-- ============================================================
-- 00028_ungga_publish_cli_copy.sql
--
-- Corrige filas existentes que ya recibieron el flow antes de actualizar el
-- copy de ungga_publish_listing. La publicación en Ungga se probará primero
-- vía CLI/browser automation; la API queda como alternativa futura.
-- ============================================================

update public.operational_case_types
set
  operational_flow_jsonb = jsonb_set(
    operational_flow_jsonb,
    array[
      step_idx::text,
      'step_skills',
      skill_idx::text,
      'skill_tools',
      tool_idx::text,
      'tool_description'
    ],
    to_jsonb(
      'Publica la ficha en Ungga vía CLI/browser automation; la API queda como alternativa futura.'::text
    ),
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
