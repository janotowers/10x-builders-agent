-- ============================================================
-- 00026_inherit_operational_case_flow.sql
--
-- Las versiones privadas creadas antes de operational_flow_jsonb pueden tener
-- flow vacío aunque exista una plantilla global canónica del mismo case_type.
-- Copiamos el flow global a esas versiones para que readiness y pruebas usen
-- contenido curado en lugar del fallback inferido por skills.
-- ============================================================

update public.operational_case_types private_case
set operational_flow_jsonb = global_case.operational_flow_jsonb,
    updated_at = now()
from public.operational_case_types global_case
where private_case.user_id is not null
  and private_case.case_type = global_case.case_type
  and global_case.user_id is null
  and coalesce(jsonb_array_length(private_case.operational_flow_jsonb), 0) = 0
  and coalesce(jsonb_array_length(global_case.operational_flow_jsonb), 0) > 0;
