-- ============================================================
-- 00058_property_optioning_awaiting_documents_branch_copy.sql
--
-- Rebalancea copy del paso awaiting_documents (PATTERN_STEP_BRANCH_DECISION):
-- el hito es reunir el expediente; interno/externo son ramas, no un solo
-- camino "pedir al propietario". No cambia tool_ids ni runtime.
-- ============================================================

update public.operational_case_types oct
set
  operational_flow_jsonb = (
    select coalesce(
      jsonb_agg(
        case
          when step->>'step_key' = 'awaiting_documents' then
            step
              || jsonb_build_object(
                'step_label', 'Reunir documentos',
                'step_description',
                  'Obtiene el expediente documental (escritura bloqueante + ideales). Quién aporta se decide por rama: equipo interno o contacto externo.',
                'step_skills', (
                  select coalesce(
                    jsonb_agg(
                      case
                        when skill->>'skill_slug' = 'request-property-documents' then
                          skill
                            || jsonb_build_object(
                              'skill_label', 'Solicitud de documentos',
                              'skill_description',
                                'Según document_request_target: pide subida al equipo interno (notify_user) o solicita al contacto externo por Telegram; registra recordatorios y escala si hace falta.',
                              'skill_tools', (
                                select coalesce(
                                  jsonb_agg(
                                    case
                                      when tool->>'tool_id' = 'telegram_send_message_to_contact' then
                                        tool || jsonb_build_object(
                                          'tool_label', 'Enviar mensaje por Telegram',
                                          'tool_description',
                                            'Rama externa: contacta al propietario o contacto externo por Telegram.'
                                        )
                                      when tool->>'tool_id' = 'notify_user' then
                                        tool || jsonb_build_object(
                                          'tool_label', 'Notificar al asesor',
                                          'tool_description',
                                            'Rama interna: solicita al equipo que suba documentos. También escala al asesor si falta respuesta del externo o hay decisión humana.'
                                        )
                                      when tool->>'tool_id' = 'operational_case_list_documents' then
                                        tool || jsonb_build_object(
                                          'tool_label', 'Consultar documentos del caso',
                                          'tool_description',
                                            'Compartida: lista documentos recibidos y su estado para saber qué falta.'
                                        )
                                      else tool
                                    end
                                    order by tool_ord
                                  ),
                                  '[]'::jsonb
                                )
                                from jsonb_array_elements(
                                  coalesce(skill->'skill_tools', '[]'::jsonb)
                                ) with ordinality as tools(tool, tool_ord)
                              )
                            )
                        else skill
                      end
                      order by skill_ord
                    ),
                    '[]'::jsonb
                  )
                  from jsonb_array_elements(
                    coalesce(step->'step_skills', '[]'::jsonb)
                  ) with ordinality as skills(skill, skill_ord)
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
