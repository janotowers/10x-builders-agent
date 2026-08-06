-- ============================================================
-- 00073_executor_mode_taxonomy.sql
--
-- Taxonomía de executor kinds (2026-08-06, decisión de diseño aprobada por
-- el usuario): `specialized_agent` → `registered_specialized_worker`.
-- El modo describe un worker REGISTRADO por work_type con contrato aislado,
-- que puede ser híbrido (checks deterministas + segunda opinión de modelo
-- opcional). "Agent" en el nombre colisionaba con los futuros sub-agentes
-- IA: `ephemeral_subagent` queda reservado para hijos temporales delegados
-- por OTRO agente (relación padre-hijo real) y se agrega `ephemeral_worker`
-- para ejecuciones temporales iniciadas directamente por el dispatcher.
--
-- Sin usuarios reales en producción (solo el tenant de laboratorio):
-- rename limpio + data-fix de filas ya estampadas, sin ventana de alias.
-- ============================================================

-- 1. Soltar el check inline de 00071 para poder actualizar las filas.
alter table public.worker_profiles
  drop constraint if exists worker_profiles_execution_mode_check;

-- 2. Data-fix: perfiles con el modo viejo (seed valuation_verifier de 00071).
update public.worker_profiles
  set execution_mode = 'registered_specialized_worker'
  where execution_mode = 'specialized_agent';

-- 3. Data-fix histórico: attempts estampados con el kind viejo, para que el
-- historial lea igual que la convención nueva (executor_kind es texto libre,
-- sin constraint — ver 00069).
update public.work_item_attempts
  set executor_kind = 'registered_specialized_worker'
  where executor_kind = 'specialized_agent';

-- 4. Re-crear el check con el vocabulario nuevo (Technical Plan §9).
alter table public.worker_profiles
  add constraint worker_profiles_execution_mode_check check (execution_mode in
    ('main_agent','deterministic_service','registered_specialized_worker',
     'ephemeral_subagent','ephemeral_worker','durable_worker',
     'external_service','human'));
