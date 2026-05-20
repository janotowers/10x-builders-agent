-- ============================================================
-- 00034_property_optioning_intake_patch_existing.sql
--
-- Repara schemas `property_optioning` parcialmente actualizados, incluyendo
-- versiones privadas que ya tienen `property_zone` pero conservan campos viejos
-- como `operation_type`/`property_type` en modo select.
-- ============================================================

with patched as (
  select
    oct.id,
    jsonb_agg(
      case field.value->>'name'
        when 'operation_type' then jsonb_build_object(
          'name', 'operation_type',
          'label', 'Operación aplicable',
          'type', 'multi_select',
          'required', true,
          'options', jsonb_build_array(
            jsonb_build_object('value', 'sale', 'label', 'Venta'),
            jsonb_build_object('value', 'rent', 'label', 'Renta')
          ),
          'help_text', 'Puedes seleccionar una o ambas opciones.'
        )
        when 'property_type' then jsonb_build_object(
          'name', 'property_type',
          'label', 'Tipo de propiedad',
          'type', 'multi_select',
          'required', true,
          'options', jsonb_build_array(
            jsonb_build_object('value', 'Casa', 'label', 'Casa'),
            jsonb_build_object('value', 'Departamento', 'label', 'Departamento'),
            jsonb_build_object('value', 'Terreno', 'label', 'Terreno'),
            jsonb_build_object('value', 'Oficina', 'label', 'Oficina'),
            jsonb_build_object('value', 'Local', 'label', 'Local')
          ),
          'help_text', 'Puedes seleccionar todos los tipos aplicables.'
        )
        when 'target_price' then jsonb_build_object(
          'name', 'target_price',
          'label', 'Precio objetivo (MXN)',
          'type', 'number',
          'required', false,
          'min', 0,
          'step', 1,
          'unit', 'MXN',
          'placeholder', 'Ej. 5500000',
          'help_text', 'Por ahora se interpreta en pesos mexicanos. Soporte multi-moneda (ej. USD) queda como mejora futura.'
        )
        when 'area_m2' then jsonb_build_object(
          'name', 'area_m2',
          'label', 'Superficie / construcción m²',
          'type', 'number',
          'required', false,
          'min', 0,
          'step', 1,
          'placeholder', 'Ej. 180',
          'help_text', 'Se usa para proponer un rango comparable ±20%.'
        )
        when 'bedrooms' then jsonb_build_object(
          'name', 'bedrooms',
          'label', 'Recámaras',
          'type', 'number',
          'required', false,
          'min', 0,
          'step', 1,
          'placeholder', 'Ej. 3'
        )
        when 'bathrooms' then jsonb_build_object(
          'name', 'bathrooms',
          'label', 'Baños',
          'type', 'number',
          'required', false,
          'min', 0,
          'step', 0.5,
          'placeholder', 'Ej. 2.5',
          'help_text', 'Permite medios baños.'
        )
        when 'parking_spaces' then jsonb_build_object(
          'name', 'parking_spaces',
          'label', 'Estacionamientos',
          'type', 'number',
          'required', false,
          'min', 0,
          'step', 1,
          'placeholder', 'Ej. 2'
        )
        when 'telegram_chat_id' then jsonb_build_object(
          'name', 'telegram_chat_id',
          'label', 'Telegram chat_id externo',
          'type', 'number',
          'required', false,
          'min', 0,
          'step', 1,
          'placeholder', 'Ej. 123456789',
          'help_text', 'Opcional; requiere que el contacto haya escrito al bot.'
        )
        else field.value
      end
      order by field.ordinality
    ) as intake_schema_jsonb
  from public.operational_case_types oct
  cross join lateral jsonb_array_elements(oct.intake_schema_jsonb)
    with ordinality as field(value, ordinality)
  where oct.case_type = 'property_optioning'
    and jsonb_typeof(oct.intake_schema_jsonb) = 'array'
  group by oct.id
)
update public.operational_case_types oct
set intake_schema_jsonb = patched.intake_schema_jsonb
from patched
where oct.id = patched.id
  and oct.intake_schema_jsonb is distinct from patched.intake_schema_jsonb;
