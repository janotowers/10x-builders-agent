-- ============================================================
-- 00057_property_optioning_intake_split_area.sql
--
-- Separa el campo de intake `area_m2` (ambiguo: alias de construcción por
-- catálogo, pero rotulado "Superficie / construcción") en dos campos claros:
--   - area_total_m2      -> superficie de terreno / total
--   - area_construida_m2 -> superficie construida (construction_size)
--
-- Esto elimina la ambigüedad que provocaba incoherencias entre el formulario
-- (área única) y property_data (área total vs construida separadas), que se veían
-- como "450 construcción" en el payload de publicación vs "116.93 total" en el
-- borrador.
--
-- Idempotente: solo migra case types que aún tienen `area_m2` y no tienen
-- `area_total_m2`. Reejecutar no duplica campos.
-- ============================================================

-- 1) Reescribe el intake_schema reemplazando la entrada `area_m2` por dos entradas,
--    preservando el orden del resto de campos.
with targets as (
  select oct.id
  from public.operational_case_types oct
  where oct.case_type = 'property_optioning'
    and jsonb_typeof(oct.intake_schema_jsonb) = 'array'
    and exists (
      select 1
      from jsonb_array_elements(oct.intake_schema_jsonb) as field
      where field->>'name' = 'area_m2'
    )
    and not exists (
      select 1
      from jsonb_array_elements(oct.intake_schema_jsonb) as field
      where field->>'name' = 'area_total_m2'
    )
),
expanded as (
  select
    t.id,
    field.ordinality,
    case
      when field.value->>'name' = 'area_m2' then jsonb_build_array(
        jsonb_build_object(
          'name', 'area_total_m2',
          'label', 'Superficie de terreno / total (m²)',
          'type', 'number',
          'required', false,
          'min', 0,
          'step', 1,
          'placeholder', 'Ej. 200',
          'help_text', 'Terreno o superficie total del inmueble.'
        ),
        jsonb_build_object(
          'name', 'area_construida_m2',
          'label', 'Superficie construida (m²)',
          'type', 'number',
          'required', false,
          'min', 0,
          'step', 1,
          'placeholder', 'Ej. 180',
          'help_text', 'Se usa para la ficha de publicación (construction_size) y para proponer el rango comparable ±20%.'
        )
      )
      else jsonb_build_array(field.value)
    end as items
  from targets t
  join public.operational_case_types oct on oct.id = t.id
  cross join lateral jsonb_array_elements(oct.intake_schema_jsonb)
    with ordinality as field(value, ordinality)
),
rebuilt as (
  select
    x.id,
    jsonb_agg(x.item order by x.ord, x.sub_ord) as intake_schema_jsonb
  from (
    select
      e.id,
      e.ordinality as ord,
      sub.ordinality as sub_ord,
      sub.value as item
    from expanded e
    cross join lateral jsonb_array_elements(e.items)
      with ordinality as sub(value, ordinality)
  ) x
  group by x.id
)
update public.operational_case_types oct
set intake_schema_jsonb = rebuilt.intake_schema_jsonb
from rebuilt
where oct.id = rebuilt.id
  and oct.intake_schema_jsonb is distinct from rebuilt.intake_schema_jsonb;

-- 2) Backfill de contextos de casos de prueba: el `area_m2` viejo (alias de
--    construcción) alimenta `area_construida_m2` para que el formulario muestre
--    un valor coherente tras el split. Se conserva `area_m2` como legacy inofensivo.
update public.operational_cases oc
set context_jsonb = jsonb_set(
  oc.context_jsonb,
  '{area_construida_m2}',
  oc.context_jsonb->'area_m2',
  true
)
where oc.case_type = 'property_optioning'
  and oc.context_jsonb ? 'area_m2'
  and not (oc.context_jsonb ? 'area_construida_m2')
  and jsonb_typeof(oc.context_jsonb->'area_m2') = 'number';
