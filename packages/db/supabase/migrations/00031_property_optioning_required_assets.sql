-- ============================================================
-- 00031_property_optioning_required_assets.sql
--
-- Declara assets autoservibles requeridos por tools del flujo de opcionar
-- propiedad. La UI/readiness los usa para permitir upload por cuenta.
-- ============================================================

update public.operational_case_types
set operational_flow_jsonb = jsonb_set(
  jsonb_set(
    operational_flow_jsonb,
    '{5,step_skills,0,skill_tools,0,required_assets}',
    jsonb_build_array(
      jsonb_build_object(
        'asset_key', 'commission_contract_template',
        'label', 'Plantilla de contrato de comisión/exclusiva',
        'description', 'Documento base que se usa para generar el contrato de comisión o exclusiva de la propiedad.',
        'accept', jsonb_build_array(
          'application/pdf',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'application/msword'
        ),
        'max_size_mb', 15,
        'required', true
      )
    ),
    true
  ),
  '{7,step_skills,0,skill_tools,0,required_assets}',
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
  ),
  true
)
where case_type = 'property_optioning'
  and jsonb_array_length(operational_flow_jsonb) >= 8
  and operational_flow_jsonb #>> '{5,step_skills,0,skill_tools,0,tool_id}' = 'generate_document_from_template'
  and operational_flow_jsonb #>> '{7,step_skills,0,skill_tools,0,tool_id}' = 'image_watermark';
