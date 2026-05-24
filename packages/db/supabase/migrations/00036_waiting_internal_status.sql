-- ============================================================
-- 00036_waiting_internal_status.sql
--
-- Distingue espera por humano interno (asesor/inmobiliario) de espera por
-- contacto externo (propietario/lead/prospecto).
-- ============================================================

alter table public.operational_cases
  drop constraint if exists operational_cases_status_check;

alter table public.operational_cases
  add constraint operational_cases_status_check
    check (status in (
      'active',
      'waiting_internal',
      'waiting_external',
      'paused',
      'completed',
      'failed'
    ));

drop index if exists idx_operational_cases_due;

create index idx_operational_cases_due
  on public.operational_cases (next_action_at)
  where status in ('active','waiting_internal','waiting_external');

comment on column public.operational_cases.status is
  'active: procesable; waiting_internal: espera respuesta del usuario interno; waiting_external: espera respuesta de contacto externo; paused/completed/failed: terminales o manuales.';
