-- ============================================================
-- 00050_property_optioning_photos_and_publish_labels.sql
--
-- Ajusta labels/descripciones de pasos 6-7 del flujo property_optioning:
-- - photos_scheduled => "Solicitar fotos" (proceso interno)
-- - package_ready   => "Gestionar publicación"
-- ============================================================

update public.operational_case_types oct
set
  operational_flow_jsonb = (
    select coalesce(
      jsonb_agg(
        case
          when step->>'step_key' = 'photos_scheduled' then
            step
              || jsonb_build_object(
                'step_label', 'Solicitar fotos',
                'step_description', 'Solicita fotos al asesor interno y avanza cuando haya evidencia suficiente en el caso.',
                'step_skills', jsonb_build_array(
                  jsonb_build_object(
                    'skill_slug', 'coordinate-photo-session',
                    'skill_label', 'Solicitud interna de fotos',
                    'skill_description', 'Pide fotos al asesor interno, registra seguimiento y habilita el paso de publicación.',
                    'skill_tools', jsonb_build_array(
                      jsonb_build_object(
                        'tool_id', 'notify_user',
                        'tool_label', 'Solicitar fotos al asesor',
                        'tool_description', 'Envía instrucciones internas para subir fotos del inmueble.'
                      ),
                      jsonb_build_object(
                        'tool_id', 'operational_case_update_state',
                        'tool_label', 'Actualizar estado del caso',
                        'tool_description', 'Mantiene waiting_internal o avanza a package_ready cuando aplica.'
                      ),
                      jsonb_build_object(
                        'tool_id', 'operational_case_add_event',
                        'tool_label', 'Registrar evento del paso',
                        'tool_description', 'Guarda evidencia de solicitud o avance por fotos recibidas.'
                      ),
                      jsonb_build_object(
                        'tool_id', 'operational_case_register_document',
                        'tool_label', 'Registrar fotos subidas',
                        'tool_description', 'Asocia imágenes del caso para poblar raw_photos y su evidencia.'
                      )
                    )
                  )
                )
              )
          when step->>'step_key' = 'package_ready' then
            step
              || jsonb_build_object(
                'step_label', 'Gestionar publicación',
                'step_description', 'Prepara, valida y aprueba el paquete final antes de publicar en EasyBroker.'
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
