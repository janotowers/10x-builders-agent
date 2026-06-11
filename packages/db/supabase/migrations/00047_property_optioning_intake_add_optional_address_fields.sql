-- ============================================================
-- 00047_property_optioning_intake_add_optional_address_fields.sql
--
-- Agrega campos opcionales de direccion al intake de property_optioning
-- para pruebas de geocoding/valuacion mas realistas en Caso de prueba.
-- ============================================================

update public.operational_case_types oct
set
  intake_schema_jsonb = coalesce(oct.intake_schema_jsonb, '[]'::jsonb) || jsonb_build_array(
    jsonb_build_object(
      'name', 'street',
      'label', 'Calle',
      'type', 'text',
      'required', false,
      'placeholder', 'Ej. Av Providencia'
    )
  )
where oct.case_type = 'property_optioning'
  and not exists (
    select 1
    from jsonb_array_elements(coalesce(oct.intake_schema_jsonb, '[]'::jsonb)) as field
    where field->>'name' = 'street'
  );

update public.operational_case_types oct
set
  intake_schema_jsonb = coalesce(oct.intake_schema_jsonb, '[]'::jsonb) || jsonb_build_array(
    jsonb_build_object(
      'name', 'exterior_number',
      'label', 'Numero exterior',
      'type', 'text',
      'required', false,
      'placeholder', 'Ej. 1234'
    )
  )
where oct.case_type = 'property_optioning'
  and not exists (
    select 1
    from jsonb_array_elements(coalesce(oct.intake_schema_jsonb, '[]'::jsonb)) as field
    where field->>'name' = 'exterior_number'
  );

update public.operational_case_types oct
set
  intake_schema_jsonb = coalesce(oct.intake_schema_jsonb, '[]'::jsonb) || jsonb_build_array(
    jsonb_build_object(
      'name', 'postal_code',
      'label', 'Codigo postal',
      'type', 'text',
      'required', false,
      'placeholder', 'Ej. 44630'
    )
  )
where oct.case_type = 'property_optioning'
  and not exists (
    select 1
    from jsonb_array_elements(coalesce(oct.intake_schema_jsonb, '[]'::jsonb)) as field
    where field->>'name' = 'postal_code'
  );
