-- ============================================================
-- 00046_property_optioning_reorder_geocode_before_avaclick.sql
--
-- Ordena skill_tools del Paso 3 para que geocode_property_address
-- aparezca antes de get_avaclick_valuation (lat/lng antes de valuación).
-- Aplica a plantillas globales y case types por-tenant.
-- ============================================================

update public.operational_case_types oct
set
  operational_flow_jsonb = (
    select jsonb_agg(
      case
        when step->>'step_key' <> 'comparables_in_progress' then step
        else jsonb_set(
          step,
          '{step_skills}',
          (
            select coalesce(
              jsonb_agg(
                case
                  when skill->>'skill_slug' <> 'perform-comparable-analysis' then skill
                  else jsonb_set(
                    skill,
                    '{skill_tools}',
                    (
                      select coalesce(
                        jsonb_agg(tool order by sort_key, orig_idx),
                        '[]'::jsonb
                      )
                      from (
                        select
                          tool,
                          ordinality as orig_idx,
                          case tool->>'tool_id'
                            when 'easybroker_search_listings' then 10
                            when 'easybroker_search_closed_deals' then 20
                            when 'bigquery_lookup_local_comparables' then 30
                            when 'geocode_property_address' then 40
                            when 'get_avaclick_valuation' then 50
                            when 'operational_case_persist_comparables_analysis' then 100
                            when 'operational_case_update_state' then 110
                            when 'operational_case_add_event' then 120
                            else 1000 + ordinality
                          end as sort_key
                        from jsonb_array_elements(
                          coalesce(skill->'skill_tools', '[]'::jsonb)
                        ) with ordinality as t(tool, ordinality)
                      ) sorted_tools
                    )
                  )
                end
                order by skill_idx
              ),
              '[]'::jsonb
            )
            from jsonb_array_elements(coalesce(step->'step_skills', '[]'::jsonb))
              with ordinality as s(skill, skill_idx)
          )
        )
      end
      order by step_idx
    )
    from jsonb_array_elements(oct.operational_flow_jsonb) with ordinality as st(step, step_idx)
  ),
  updated_at = now()
where oct.case_type = 'property_optioning';
