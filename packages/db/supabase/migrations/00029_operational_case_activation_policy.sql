-- ============================================================
-- 00029_operational_case_activation_policy.sql
--
-- Configuración por caso de uso para copy/reglas de prueba segura inicial
-- y checks de activación. Evita hardcodear en UI mensajes específicos de
-- un caso de uso; skill-authoring puede generarla junto con el flow.
-- ============================================================

alter table public.operational_case_types
  add column if not exists activation_policy_jsonb jsonb not null default '{}'::jsonb;

comment on column public.operational_case_types.activation_policy_jsonb is
  'Política configurable para prueba segura inicial, copy de checks de activación y criterios de operación real.';

update public.operational_case_types
set activation_policy_jsonb = jsonb_build_object(
  'safe_test', jsonb_build_object(
    'description', 'Crea un caso con valores sintéticos del intake para validar el arranque seguro del flujo sin mezclarlo con operación real.',
    'run_button_label', 'Ejecutar prueba segura inicial',
    'synthetic_data_copy', 'Este caso se creó con valores de prueba derivados del formulario inicial; no usa datos reales ni ejecuta envíos, escrituras o publicaciones.',
    'success_copy', 'Prueba segura inicial pasada: el caso de prueba validó intake y avanzó al primer paso operativo sin ejecutar acciones externas.',
    'timeline_note', 'Prueba segura inicial: valida intake y deja pendiente la siguiente acción. Tools de envío/escritura/publicación no se ejecutan automáticamente y requieren confirmación humana.',
    'next_action', 'Revisar readiness de tools de envío/escritura/publicación antes de operación real completa.',
    'start_step', 'intake',
    'success_step', 'awaiting_documents'
  ),
  'activation_checks', jsonb_build_object(
    'skill_valid_copy', 'Skill válida: parser/rúbrica sin bloqueos.',
    'readiness_ready_copy', 'Tools listas: readiness sin bloqueos críticos.',
    'readiness_blocked_copy', 'Tools pendientes: resuelve las herramientas bloqueantes antes de activar.',
    'safe_test_success_copy', 'Prueba segura inicial pasada: el caso de prueba validó intake y avanzó al primer paso operativo sin ejecutar acciones externas.',
    'conversational_safe_copy', 'Uso conversacional seguro: puede iniciarse desde chat/Telegram en modo controlado, sin envíos/publicaciones automáticas.',
    'real_operation_complete_copy', 'Operación real completa: sin stubs técnicos pendientes.',
    'real_operation_pending_copy', 'Operación real completa: pendiente; quedan {stub_count} stubs/capacidades por resolver antes de operar sin restricciones.',
    'real_operation_requires_no_stubs', true
  )
)
where case_type = 'property_optioning'
  and activation_policy_jsonb = '{}'::jsonb;
