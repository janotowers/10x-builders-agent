-- ============================================================
-- 00039_property_optioning_intake_flow_copy.sql
--
-- Renombra el hito intake en operational_flow_jsonb, actualiza
-- descripción y quita notify_user de step_tools (sigue en coach).
-- Aplica a global y tenants con el mismo case_type.
-- ============================================================

update public.operational_case_types oct
set
  operational_flow_jsonb = (
    select coalesce(
      jsonb_agg(
        case
          when step->>'step_key' = 'intake' then
            jsonb_set(
              jsonb_set(
                jsonb_set(
                  step,
                  '{step_label}',
                  '"Completar registro del caso"'::jsonb
                ),
                '{step_description}',
                '"Comprueba que el caso tenga los datos mínimos y quede listo para el primer paso operativo."'::jsonb
              ),
              '{step_tools}',
              coalesce(
                (
                  select jsonb_agg(
                    case
                      when tool->>'tool_id' = 'operational_case_create' then
                        jsonb_set(
                          tool,
                          '{tool_description}',
                          '"Registra la instancia del caso con los datos mínimos capturados."'::jsonb
                        )
                      when tool->>'tool_id' = 'operational_case_update_state' then
                        jsonb_set(
                          tool,
                          '{tool_description}',
                          '"Avanza el caso al primer paso operativo cuando el registro está completo."'::jsonb
                        )
                      else tool
                    end
                  )
                  from jsonb_array_elements(coalesce(step->'step_tools', '[]'::jsonb)) tool
                  where tool->>'tool_id' is distinct from 'notify_user'
                ),
                '[]'::jsonb
              )
            )
          else step
        end
        order by ord
      ),
      '[]'::jsonb
    )
    from jsonb_array_elements(oct.operational_flow_jsonb) with ordinality as t(step, ord)
  ),
  activation_policy_jsonb = case
    when oct.user_id is null
      and oct.case_type = 'property_optioning'
      and oct.activation_policy_jsonb is not null
      and oct.activation_policy_jsonb != '{}'::jsonb
    then jsonb_set(
      oct.activation_policy_jsonb,
      '{safe_test,description}',
      '"Prepara un caso de prueba con datos del intake y valida el registro antes del flujo operativo, sin mezclarlo con operación real."'::jsonb
    )
    else oct.activation_policy_jsonb
  end,
  updated_at = now()
where oct.case_type = 'property_optioning'
  and coalesce(jsonb_array_length(oct.operational_flow_jsonb), 0) > 0
  and exists (
    select 1
    from jsonb_array_elements(oct.operational_flow_jsonb) step
    where step->>'step_key' = 'intake'
  );
