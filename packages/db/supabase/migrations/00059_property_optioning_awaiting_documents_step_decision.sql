-- ============================================================
-- 00059_property_optioning_awaiting_documents_step_decision.sql
--
-- Añade step_decision (metadata explicativa, PATTERN_STEP_BRANCH_DECISION)
-- al paso awaiting_documents. No cambia runtime ni tool_ids.
-- ============================================================

update public.operational_case_types oct
set
  operational_flow_jsonb = (
    select coalesce(
      jsonb_agg(
        case
          when step->>'step_key' = 'awaiting_documents' then
            step || jsonb_build_object(
              'step_decision',
              jsonb_build_object(
                'id', 'document_request_target',
                'label', '¿Quién aporta los documentos?',
                'description',
                  'Misma etapa (expediente); distinto responsable y waiting_*. El panel no ejecuta este IF.',
                'context_key', 'document_request_target',
                'decided_by_hint',
                  'Post-intake: respuesta «interno»/«externo», o inferido si suben archivos antes de elegir.',
                'branches', jsonb_build_array(
                  jsonb_build_object(
                    'value', 'internal_user',
                    'label', 'Equipo interno',
                    'description', 'El asesor o el equipo sube documentos al caso y confirma con «listo».',
                    'expected_status', 'waiting_internal',
                    'primary_tool_ids', jsonb_build_array('notify_user'),
                    'scenario_ids', jsonb_build_array('awaiting_documents_internal_upload')
                  ),
                  jsonb_build_object(
                    'value', 'external_contact',
                    'label', 'Contacto externo',
                    'description', 'Se solicita al dueño/contacto por Telegram (o deep link si aún no está vinculado).',
                    'expected_status', 'waiting_external',
                    'primary_tool_ids', jsonb_build_array('telegram_send_message_to_contact'),
                    'scenario_ids', jsonb_build_array('awaiting_documents_outreach')
                  )
                ),
                'shared_tool_ids', jsonb_build_array('operational_case_list_documents')
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
