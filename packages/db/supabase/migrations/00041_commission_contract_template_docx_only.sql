-- Plantilla de contrato: solo DOCX (el renderer no soporta PDF/DOC).

update public.operational_case_types
set operational_flow_jsonb = jsonb_set(
  operational_flow_jsonb,
  '{5,step_skills,0,skill_tools,0,required_assets,0,accept}',
  jsonb_build_array(
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.docx'
  ),
  true
)
where case_type = 'property_optioning'
  and jsonb_array_length(operational_flow_jsonb) >= 6
  and operational_flow_jsonb #>> '{5,step_skills,0,skill_tools,0,tool_id}' = 'generate_document_from_template'
  and operational_flow_jsonb #>> '{5,step_skills,0,skill_tools,0,required_assets,0,asset_key}' = 'commission_contract_template';
