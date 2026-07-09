-- ============================================================
-- 00061_property_optioning_documents_received_pending_internal_branch.sql
--
-- PATTERN_STEP_BRANCH_DECISION: split documents_received pending into
-- pending_external | pending_internal (audiencia vía document_request_target).
-- Metadata only; runtime already branches in skill + post-invariants.
-- ============================================================

update public.operational_case_types oct
set
  operational_flow_jsonb = (
    select coalesce(
      jsonb_agg(
        case
          when step->>'step_key' = 'documents_received'
            and step->'step_decision'->>'id' = 'critical_property_data' then
            jsonb_set(
              jsonb_set(
                step,
                '{step_decision,decided_by_hint}',
                to_jsonb(
                  'Tras listar/extraer: si faltantes vacíos → revisión interna. Si hay faltantes, audiencia según document_request_target (heredado de awaiting_documents): externo → Telegram; interno → notify_user determinístico (characteristics_pending_internal).'::text
                ),
                true
              ),
              '{step_decision,branches}',
              jsonb_build_array(
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
                  'value', 'pending_external',
                  'label', 'Faltantes → contacto externo',
                  'description',
                    'Faltan campos críticos y document_request_target=external_contact: pregunta sólo esos al contacto (Telegram) y permanece en documents_received.',
                  'expected_status', 'waiting_external',
                  'primary_tool_ids', jsonb_build_array('telegram_send_message_to_contact'),
                  'scenario_ids', jsonb_build_array('documents_received_characteristics_pending')
                ),
                jsonb_build_object(
                  'value', 'pending_internal',
                  'label', 'Faltantes → equipo interno',
                  'description',
                    'Faltan campos críticos y document_request_target=internal_user: sin Telegram; notify_user / characteristics_pending_internal y waiting_internal.',
                  'expected_status', 'waiting_internal',
                  'primary_tool_ids', jsonb_build_array('notify_user'),
                  'scenario_ids', jsonb_build_array(
                    'documents_received_characteristics_pending_internal'
                  )
                )
              ),
              true
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
