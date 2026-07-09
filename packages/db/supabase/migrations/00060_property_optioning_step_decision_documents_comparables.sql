-- ============================================================
-- 00060_property_optioning_step_decision_documents_comparables.sql
--
-- Fase F (PATTERN_STEP_BRANCH_DECISION): mapea step_decision en
-- documents_received y comparables_in_progress a los N4 ya existentes.
-- No inventa escenarios. No cambia runtime.
-- En comparables, declara notify_user en skill_tools si falta (UI/readiness).
-- ============================================================

-- 1) Asegurar notify_user en perform-comparable-analysis (rama sin muestra).
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
        'tool_id', 'notify_user',
        'tool_label', 'Notificar al asesor',
        'tool_description',
          'Rama sin muestra defendible: avisa al asesor (filtros, sugerencias). Con muestra, notify opcional al cerrar.'
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
      where tool->>'tool_id' = 'notify_user'
    )
) targets
where public.operational_case_types.id = targets.case_type_id;

-- 2) step_decision en documents_received + comparables_in_progress.
update public.operational_case_types oct
set
  operational_flow_jsonb = (
    select coalesce(
      jsonb_agg(
        case
          when step->>'step_key' = 'documents_received'
            and (step->'step_decision') is null then
            step || jsonb_build_object(
              'step_decision',
              jsonb_build_object(
                'id', 'critical_property_data',
                'label', '¿Datos críticos completos?',
                'description',
                  'Tras estructurar property_data: revisión interna si está completo, o faltantes al contacto si no. El panel no ejecuta este IF.',
                'context_key', 'property_data.missing_critical_fields',
                'decided_by_hint',
                  'Skill extract-property-characteristics tras listar/extraer documentos: vacío/ausente missing_critical_fields → revisión; con faltantes → Telegram.',
                'branches', jsonb_build_array(
                  jsonb_build_object(
                    'value', 'complete',
                    'label', 'Completos → revisión interna',
                    'description',
                      'Datos críticos listos: notify_user(kind=property_data_review) y avanza a property_data_review.',
                    'expected_status', 'waiting_internal',
                    'primary_tool_ids', jsonb_build_array('notify_user'),
                    'scenario_ids', jsonb_build_array('documents_received_property_data_review')
                  ),
                  jsonb_build_object(
                    'value', 'pending_critical',
                    'label', 'Faltantes → contacto externo',
                    'description',
                      'Faltan campos críticos: pregunta sólo esos al contacto (Telegram) y permanece en documents_received.',
                    'expected_status', 'waiting_external',
                    'primary_tool_ids', jsonb_build_array('telegram_send_message_to_contact'),
                    'scenario_ids', jsonb_build_array('documents_received_characteristics_pending')
                  )
                ),
                'shared_tool_ids', jsonb_build_array(
                  'operational_case_list_documents',
                  'operational_case_extract_document_fields'
                )
              )
            )
          when step->>'step_key' = 'comparables_in_progress'
            and (step->'step_decision') is null then
            step || jsonb_build_object(
              'step_decision',
              jsonb_build_object(
                'id', 'defensible_comparables_sample',
                'label', '¿Muestra de comparables defendible?',
                'description',
                  'Tras persistir el análisis: usable_count > 0 avanza a precio; 0 usables permanece y notifica al asesor. El panel no ejecuta este IF.',
                'context_key', 'comparables_analysis.data_quality.usable_count',
                'decided_by_hint',
                  'Resultado de operational_case_persist_comparables_analysis (usable_count / defensible_sample).',
                'branches', jsonb_build_array(
                  jsonb_build_object(
                    'value', 'defensible',
                    'label', 'Muestra defendible → precio',
                    'description',
                      'usable_count > 0: persiste análisis y avanza a price_proposal_pending (notify opcional).',
                    'expected_status', 'active',
                    'primary_tool_ids', jsonb_build_array('operational_case_update_state'),
                    'scenario_ids', jsonb_build_array('comparables_in_progress_complete')
                  ),
                  jsonb_build_object(
                    'value', 'insufficient',
                    'label', 'Sin usables → no avanzar',
                    'description',
                      'usable_count = 0 en todas las fuentes: waiting_internal + notify_user; no price_proposal_pending.',
                    'expected_status', 'waiting_internal',
                    'primary_tool_ids', jsonb_build_array('notify_user'),
                    'scenario_ids', jsonb_build_array(
                      'comparables_in_progress_insufficient_data'
                    )
                  )
                ),
                'shared_tool_ids', jsonb_build_array(
                  'easybroker_search_listings',
                  'easybroker_search_closed_deals',
                  'bigquery_lookup_local_comparables',
                  'geocode_property_address',
                  'get_avaclick_valuation',
                  'operational_case_persist_comparables_analysis'
                )
              )
            )
          else step
        end
        order by ordinality
      ),
      '[]'::jsonb
    )
    from jsonb_array_elements(coalesce(oct.operational_flow_jsonb, '[]'::jsonb))
      with ordinality as t(step, ordinality)
  ),
  updated_at = now()
where oct.case_type = 'property_optioning';
