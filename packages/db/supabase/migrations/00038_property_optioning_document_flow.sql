-- ============================================================
-- 00038_property_optioning_document_flow.sql
--
-- Ajusta metadata/readiness de pasos 2 y 3 para documentos por caso y
-- extracción multimodal.
-- ============================================================

update public.operational_case_types
set operational_flow_jsonb = jsonb_set(
  jsonb_set(
    jsonb_set(
      jsonb_set(
        operational_flow_jsonb,
        '{1,step_description}',
        to_jsonb('Pide al propietario el documento bloqueante de escritura-descripción y documentos ideales del expediente.'::text),
        false
      ),
      '{1,step_skills,0,skill_description}',
      to_jsonb('Prepara el mensaje al propietario, registra documentos recibidos, envía recordatorios y escala si no responde.'::text),
      false
    ),
    '{1,step_skills,0,skill_tools}',
    jsonb_build_array(
      jsonb_build_object(
        'tool_id', 'telegram_send_message_to_contact',
        'tool_label', 'Enviar mensaje por Telegram',
        'tool_description', 'Contacta al propietario o contacto externo por Telegram.'
      ),
      jsonb_build_object(
        'tool_id', 'operational_case_list_documents',
        'tool_label', 'Consultar documentos del caso',
        'tool_description', 'Lista documentos recibidos y su estado de extracción para saber qué falta.'
      ),
      jsonb_build_object(
        'tool_id', 'notify_user',
        'tool_label', 'Notificar al asesor',
        'tool_description', 'Escala al usuario operador cuando falta respuesta o decisión humana.'
      )
    ),
    false
  ),
  '{2,step_skills,0,skill_tools}',
  jsonb_build_array(
    jsonb_build_object(
      'tool_id', 'operational_case_list_documents',
      'tool_label', 'Consultar documentos del caso',
      'tool_description', 'Lista documentos recibidos para usarlos como fuente de datos.'
    ),
    jsonb_build_object(
      'tool_id', 'operational_case_extract_document_fields',
      'tool_label', 'Extraer datos de documentos',
      'tool_description', 'Usa visión para extraer datos visibles de imágenes de escritura, predial o boleta registral.'
    ),
    jsonb_build_object(
      'tool_id', 'telegram_send_message_to_contact',
      'tool_label', 'Preguntar faltantes al propietario',
      'tool_description', 'Pide al dueño sólo características críticas que sigan faltando.'
    ),
    jsonb_build_object(
      'tool_id', 'notify_user',
      'tool_label', 'Solicitar validación del asesor',
      'tool_description', 'Pide confirmación humana de los datos estructurados antes de comparables.'
    )
  ),
  false
)
where case_type = 'property_optioning'
  and jsonb_array_length(operational_flow_jsonb) >= 3;
