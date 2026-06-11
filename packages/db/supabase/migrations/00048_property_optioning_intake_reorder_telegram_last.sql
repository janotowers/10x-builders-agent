-- ============================================================
-- 00048_property_optioning_intake_reorder_telegram_last.sql
--
-- Mueve telegram_chat_id al final del intake de property_optioning
-- para separarlo de los campos de la propiedad.
-- ============================================================

update public.operational_case_types oct
set
  intake_schema_jsonb = (
    select coalesce(
      jsonb_agg(field order by sort_key, orig_idx),
      '[]'::jsonb
    )
    from (
      select
        field,
        ordinality as orig_idx,
        case field->>'name'
          when 'property_title' then 10
          when 'owner_name' then 20
          when 'property_zone' then 30
          when 'street' then 40
          when 'exterior_number' then 50
          when 'postal_code' then 60
          when 'operation_type' then 70
          when 'property_type' then 80
          when 'target_price' then 90
          when 'area_m2' then 100
          when 'bedrooms' then 110
          when 'bathrooms' then 120
          when 'parking_spaces' then 130
          when 'telegram_chat_id' then 10000
          else 5000 + ordinality
        end as sort_key
      from jsonb_array_elements(coalesce(oct.intake_schema_jsonb, '[]'::jsonb))
        with ordinality as t(field, ordinality)
    ) sorted_fields
  ),
  updated_at = now()
where oct.case_type = 'property_optioning';
