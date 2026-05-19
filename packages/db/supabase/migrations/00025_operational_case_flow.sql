-- ============================================================
-- 00025_operational_case_flow.sql
--
-- Agrega una estructura explícita para renderizar y validar casos de uso
-- como flujo operativo paso → skill → tool. Este JSON NO reemplaza al
-- SKILL.md runtime; es el contrato UI/readiness/test-runner generado por
-- skill-authoring y revisable por humanos.
-- ============================================================

alter table public.operational_case_types
  add column if not exists operational_flow_jsonb jsonb not null default '[]'::jsonb;

comment on column public.operational_case_types.operational_flow_jsonb is
  'Estructura UI/operacional paso → skill → tool para readiness, prueba controlada y activación. El runtime sigue usando default_skill_slug + SKILL.md.';

-- ============================================================
-- Backfill: property_optioning global
-- ============================================================

update public.operational_case_types
set operational_flow_jsonb = jsonb_build_array(
  jsonb_build_object(
    'step_key', 'intake',
    'step_label', 'Captura inicial',
    'step_description', 'Recolecta los datos mínimos para crear la instancia del caso operacional.',
    'step_skills', jsonb_build_array(),
    'step_tools', jsonb_build_array(
      jsonb_build_object(
        'tool_id', 'operational_case_create',
        'tool_label', 'Crear caso operacional',
        'tool_description', 'Registra una instancia concreta del caso con los datos capturados.'
      ),
      jsonb_build_object(
        'tool_id', 'operational_case_update_state',
        'tool_label', 'Actualizar estado del caso',
        'tool_description', 'Mueve el caso desde captura inicial al siguiente paso operativo cuando hay datos suficientes.'
      ),
      jsonb_build_object(
        'tool_id', 'notify_user',
        'tool_label', 'Notificar al asesor',
        'tool_description', 'Pide datos faltantes o avisa al usuario operador cuando el flujo necesita intervención.'
      )
    )
  ),
  jsonb_build_object(
    'step_key', 'awaiting_documents',
    'step_label', 'Solicitar documentos',
    'step_description', 'Pide documentos requeridos al propietario y registra las respuestas.',
    'step_skills', jsonb_build_array(
      jsonb_build_object(
        'skill_slug', 'request-property-documents',
        'skill_label', 'Solicitud de documentos',
        'skill_description', 'Prepara el mensaje al propietario, envía recordatorios y escala si no responde.',
        'skill_tools', jsonb_build_array(
          jsonb_build_object(
            'tool_id', 'telegram_send_message_to_contact',
            'tool_label', 'Enviar mensaje por Telegram',
            'tool_description', 'Contacta al propietario o contacto externo por Telegram.'
          ),
          jsonb_build_object(
            'tool_id', 'notify_user',
            'tool_label', 'Notificar al asesor',
            'tool_description', 'Escala al usuario operador cuando falta respuesta o decisión humana.'
          )
        )
      )
    ),
    'step_tools', jsonb_build_array()
  ),
  jsonb_build_object(
    'step_key', 'documents_received',
    'step_label', 'Extraer características',
    'step_description', 'Estructura la información recibida sobre la propiedad.',
    'step_skills', jsonb_build_array(
      jsonb_build_object(
        'skill_slug', 'extract-property-characteristics',
        'skill_label', 'Extracción de características',
        'skill_description', 'Convierte documentos y respuestas en datos estructurados de la propiedad.',
        'skill_tools', jsonb_build_array(
          jsonb_build_object(
            'tool_id', 'notify_user',
            'tool_label', 'Notificar al asesor',
            'tool_description', 'Pide aclaraciones o confirma datos relevantes con el usuario operador.'
          )
        )
      )
    ),
    'step_tools', jsonb_build_array()
  ),
  jsonb_build_object(
    'step_key', 'comparables_in_progress',
    'step_label', 'Análisis de comparables',
    'step_description', 'Busca referencias de mercado para proponer un rango de precio.',
    'step_skills', jsonb_build_array(
      jsonb_build_object(
        'skill_slug', 'perform-comparable-analysis',
        'skill_label', 'Análisis de comparables',
        'skill_description', 'Consulta propiedades similares activas, operaciones cerradas y datos internos.',
        'skill_tools', jsonb_build_array(
          jsonb_build_object(
            'tool_id', 'easybroker_search_listings',
            'tool_label', 'Buscar propiedades activas en EasyBroker',
            'tool_description', 'Consulta propiedades activas/publicadas similares para referencia de mercado actual.'
          ),
          jsonb_build_object(
            'tool_id', 'easybroker_search_closed_deals',
            'tool_label', 'Buscar vendidas/rentadas en EasyBroker',
            'tool_description', 'Consulta propiedades marcadas como vendidas/rentadas para referencia histórica; el precio no necesariamente es el cierre real.'
          ),
          jsonb_build_object(
            'tool_id', 'bigquery_lookup_local_comparables',
            'tool_label', 'Consultar comparables internos',
            'tool_description', 'Busca datos históricos propios de la inmobiliaria.'
          )
        )
      )
    ),
    'step_tools', jsonb_build_array()
  ),
  jsonb_build_object(
    'step_key', 'price_proposal_pending',
    'step_label', 'Preparar precio',
    'step_description', 'Propone precio de salida y rango de negociación para aprobación humana.',
    'step_skills', jsonb_build_array(
      jsonb_build_object(
        'skill_slug', 'prepare-listing-price',
        'skill_label', 'Preparación de precio',
        'skill_description', 'Sintetiza comparables y prepara una recomendación de precio para HITL.',
        'skill_tools', jsonb_build_array(
          jsonb_build_object(
            'tool_id', 'notify_user',
            'tool_label', 'Solicitar aprobación del asesor',
            'tool_description', 'Presenta la propuesta y espera decisión humana antes de avanzar.'
          )
        )
      )
    ),
    'step_tools', jsonb_build_array()
  ),
  jsonb_build_object(
    'step_key', 'contract_pending',
    'step_label', 'Preparar contrato',
    'step_description', 'Genera o prepara el contrato de comisión/exclusiva para revisión.',
    'step_skills', jsonb_build_array(
      jsonb_build_object(
        'skill_slug', 'prepare-commission-contract',
        'skill_label', 'Contrato de comisión',
        'skill_description', 'Genera el contrato desde una plantilla y lo manda a revisión humana.',
        'skill_tools', jsonb_build_array(
          jsonb_build_object(
            'tool_id', 'generate_document_from_template',
            'tool_label', 'Generar documento desde plantilla',
            'tool_description', 'Crea el contrato usando una plantilla configurada para la cuenta.'
          ),
          jsonb_build_object(
            'tool_id', 'notify_user',
            'tool_label', 'Solicitar revisión del asesor',
            'tool_description', 'Pide aprobación humana antes de usar el contrato.'
          )
        )
      )
    ),
    'step_tools', jsonb_build_array()
  ),
  jsonb_build_object(
    'step_key', 'photos_scheduled',
    'step_label', 'Coordinar fotos',
    'step_description', 'Coordina la sesión de fotos profesional de la propiedad.',
    'step_skills', jsonb_build_array(
      jsonb_build_object(
        'skill_slug', 'coordinate-photo-session',
        'skill_label', 'Coordinación de fotos',
        'skill_description', 'Propone horarios, confirma con contactos y crea eventos de calendario.',
        'skill_tools', jsonb_build_array(
          jsonb_build_object(
            'tool_id', 'calendar_list_events',
            'tool_label', 'Revisar calendario',
            'tool_description', 'Busca disponibilidad para coordinar la sesión.'
          ),
          jsonb_build_object(
            'tool_id', 'calendar_create_event',
            'tool_label', 'Crear evento de calendario',
            'tool_description', 'Agenda la sesión de fotos cuando hay horario confirmado.'
          ),
          jsonb_build_object(
            'tool_id', 'telegram_send_message_to_contact',
            'tool_label', 'Confirmar por Telegram',
            'tool_description', 'Coordina con el propietario o contacto externo.'
          )
        )
      )
    ),
    'step_tools', jsonb_build_array()
  ),
  jsonb_build_object(
    'step_key', 'package_ready',
    'step_label', 'Preparar publicación',
    'step_description', 'Ensambla fotos, descripción y datos finales para publicar.',
    'step_skills', jsonb_build_array(
      jsonb_build_object(
        'skill_slug', 'publish-listing-package',
        'skill_label', 'Paquete de publicación',
        'skill_description', 'Prepara el paquete final y publica donde haya integración disponible.',
        'skill_tools', jsonb_build_array(
          jsonb_build_object(
            'tool_id', 'image_watermark',
            'tool_label', 'Aplicar marca de agua',
            'tool_description', 'Procesa fotos con el watermark configurado para la cuenta.'
          ),
          jsonb_build_object(
            'tool_id', 'easybroker_create_listing',
            'tool_label', 'Crear publicación en EasyBroker',
            'tool_description', 'Crea la ficha de la propiedad en EasyBroker tras aprobación humana.'
          ),
          jsonb_build_object(
            'tool_id', 'easybroker_upload_images',
            'tool_label', 'Subir fotos a EasyBroker',
            'tool_description', 'Adjunta imágenes a una publicación existente en EasyBroker.'
          ),
          jsonb_build_object(
            'tool_id', 'ungga_publish_listing',
            'tool_label', 'Publicar en Ungga',
            'tool_description', 'Publica la ficha en Ungga vía CLI/browser automation; la API queda como alternativa futura.'
          )
        )
      )
    ),
    'step_tools', jsonb_build_array()
  )
)
where case_type = 'property_optioning'
  and user_id is null
  and operational_flow_jsonb = '[]'::jsonb;

-- ============================================================
-- Backfill: lead_follow_up global
-- ============================================================

update public.operational_case_types
set operational_flow_jsonb = jsonb_build_array(
  jsonb_build_object(
    'step_key', 'intake',
    'step_label', 'Captura del lead',
    'step_description', 'Registra datos mínimos del lead y el objetivo del seguimiento.',
    'step_skills', jsonb_build_array(
      jsonb_build_object(
        'skill_slug', 'lead-follow-up-draft',
        'skill_label', 'Seguimiento de lead',
        'skill_description', 'Prepara un mensaje de seguimiento a partir del contexto del lead.',
        'skill_tools', jsonb_build_array(
          jsonb_build_object(
            'tool_id', 'notify_user',
            'tool_label', 'Enviar borrador al asesor',
            'tool_description', 'Entrega el borrador o pide revisión humana antes de enviar.'
          )
        )
      )
    ),
    'step_tools', jsonb_build_array(
      jsonb_build_object(
        'tool_id', 'operational_case_create',
        'tool_label', 'Crear caso operacional',
        'tool_description', 'Registra una instancia concreta del seguimiento.'
      )
    )
  )
)
where case_type = 'lead_follow_up'
  and user_id is null
  and operational_flow_jsonb = '[]'::jsonb;
