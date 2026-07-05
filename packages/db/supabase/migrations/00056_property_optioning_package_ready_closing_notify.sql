-- ============================================================
-- 00056_property_optioning_package_ready_closing_notify.sql
--
-- Separa HITL (notify_user mid-flow) del cierre final visible en
-- readiness UI: segunda entrada notify_user al final del paso.
-- ============================================================

with package_ready_targets as (
  select
    oct.id as case_type_id,
    step_pos.idx - 1 as step_idx,
    skill_pos.idx - 1 as skill_idx,
    coalesce(
      (
        select tool->'required_assets'
        from jsonb_array_elements(coalesce(skill_pos.skill->'skill_tools', '[]'::jsonb)) tool
        where tool->>'tool_id' = 'image_watermark'
        limit 1
      ),
      jsonb_build_array(
        jsonb_build_object(
          'asset_key', 'listing_photo_watermark',
          'label', 'Watermark para fotos de publicación',
          'description', 'Imagen transparente o logo que se aplicará a las fotos antes de publicar.',
          'accept', jsonb_build_array(
            'image/png',
            'image/jpeg',
            'image/webp',
            'image/svg+xml'
          ),
          'max_size_mb', 5,
          'required', true
        )
      )
    ) as watermark_required_assets
  from public.operational_case_types oct,
       jsonb_array_elements(oct.operational_flow_jsonb) with ordinality as step_pos(step, idx),
       jsonb_array_elements(coalesce(step_pos.step->'step_skills', '[]'::jsonb))
         with ordinality as skill_pos(skill, idx)
  where oct.case_type = 'property_optioning'
    and jsonb_typeof(oct.operational_flow_jsonb) = 'array'
    and step_pos.step->>'step_key' = 'package_ready'
    and skill_pos.skill->>'skill_slug' = 'publish-listing-package'
)
update public.operational_case_types oct
set
  operational_flow_jsonb = jsonb_set(
    oct.operational_flow_jsonb,
    array[targets.step_idx::text, 'step_skills', targets.skill_idx::text, 'skill_tools'],
    jsonb_build_array(
      jsonb_build_object(
        'tool_id', 'analyze_property_images',
        'tool_label', 'Analizar imágenes de la propiedad',
        'tool_description', 'Extrae observaciones visuales verificables y cobertura fotográfica sin inferencias no sustentadas.'
      ),
      jsonb_build_object(
        'tool_id', 'lookup_property_surroundings',
        'tool_label', 'Enriquecer entorno de la propiedad',
        'tool_description', 'Recupera puntos de interés verificables y contexto de zona con fuente.'
      ),
      jsonb_build_object(
        'tool_id', 'prepare_listing_description_draft',
        'tool_label', 'Preparar borrador de descripción',
        'tool_description', 'Genera un borrador comercial desde ingredientes verificados para revisión humana.'
      ),
      jsonb_build_object(
        'tool_id', 'notify_user',
        'tool_label', 'Solicitar aprobaciones internas',
        'tool_description', 'Solicita revisión y aprobaciones internas (descripción, destinos de publicación).'
      ),
      jsonb_build_object(
        'tool_id', 'image_watermark',
        'tool_label', 'Aplicar marca de agua',
        'tool_description', 'Procesa fotos con el watermark configurado para la cuenta.',
        'required_assets', targets.watermark_required_assets
      ),
      jsonb_build_object(
        'tool_id', 'easybroker_create_listing',
        'tool_label', 'Crear publicación en EasyBroker',
        'tool_description', 'Crea la ficha de la propiedad en EasyBroker tras aprobación humana por destino.'
      ),
      jsonb_build_object(
        'tool_id', 'easybroker_upload_images',
        'tool_label', 'Subir fotos a EasyBroker',
        'tool_description', 'Adjunta imágenes a una publicación existente en EasyBroker.'
      ),
      jsonb_build_object(
        'tool_id', 'ungga_publish_listing',
        'tool_label', 'Publicar en Ungga',
        'tool_description', 'Publica la ficha en Ungga cuando el destino haya sido aprobado.'
      ),
      jsonb_build_object(
        'tool_id', 'notify_user',
        'tool_label', 'Enviar resumen final de publicación',
        'tool_description', 'Notifica al asesor el cierre del caso con links y resumen canónico (listing_published_summary).',
        'test_inputs_mapping', jsonb_build_object(
          'kind', 'tool_readiness_test',
          'text', 'Prueba controlada desde Ajustes: valida el resumen final de publicación (listing_published_summary).'
        )
      )
    ),
    true
  ),
  updated_at = now()
from package_ready_targets targets
where oct.id = targets.case_type_id;
