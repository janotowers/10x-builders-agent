-- ============================================================
-- 00032_easybroker_comparable_copy.sql
--
-- Aclara el copy de EasyBroker en flows existentes: listings activos son
-- mercado actual; sold/rented es referencia histórica, no cierre real
-- garantizado.
-- ============================================================

update public.operational_case_types
set operational_flow_jsonb = jsonb_set(
  jsonb_set(
    jsonb_set(
      operational_flow_jsonb,
      '{3,step_skills,0,skill_tools,0,tool_description}',
      to_jsonb('Consulta propiedades activas/publicadas similares para referencia de mercado actual.'::text),
      false
    ),
    '{3,step_skills,0,skill_tools,1,tool_label}',
    to_jsonb('Buscar vendidas/rentadas en EasyBroker'::text),
    false
  ),
  '{3,step_skills,0,skill_tools,1,tool_description}',
  to_jsonb('Consulta propiedades marcadas como vendidas/rentadas para referencia histórica; el precio no necesariamente es el cierre real.'::text),
  false
)
where case_type = 'property_optioning'
  and jsonb_array_length(operational_flow_jsonb) >= 4
  and operational_flow_jsonb #>> '{3,step_skills,0,skill_tools,0,tool_id}' = 'easybroker_search_listings'
  and operational_flow_jsonb #>> '{3,step_skills,0,skill_tools,1,tool_id}' = 'easybroker_search_closed_deals';
