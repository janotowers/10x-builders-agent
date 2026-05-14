-- ============================================================
-- 00019_operational_cases.sql
--
-- Subsistema de Casos operacionales (ver docs/operational-cases/plan.md
-- y docs/operational-cases/architecture.md).
--
-- Tres tablas:
--   1. operational_case_types: catálogo de tipos de caso (ej. property_optioning).
--   2. operational_cases: instancias vivas multi-día con estado, paso actual,
--      next_action_at, due_at, version (optimistic locking) y referencia a la
--      skill a usar.
--   3. operational_case_events: timeline append-only por caso.
--
-- Además extiende agent_sessions.channel para aceptar 'case_runner'.
-- ============================================================

-- ============================================================
-- operational_case_types — catálogo de tipos de caso
-- ============================================================
create table public.operational_case_types (
  case_type                       text primary key,
  display_name                    text not null,
  default_skill_slug              text not null,
  default_reminder_policy_jsonb   jsonb not null default '{}'::jsonb,
  description                     text,
  created_at                      timestamptz not null default now(),
  updated_at                      timestamptz not null default now()
);

comment on table public.operational_case_types is
  'Catálogo de tipos de caso operacional (ej. property_optioning). default_skill_slug indica la skill a aplicar mediante binding directo cuando se procesa un caso de este tipo.';

-- Catálogo es lectura pública para usuarios autenticados (no contiene PII);
-- escritura solo desde service_role.
alter table public.operational_case_types enable row level security;

create policy "Authenticated users can read case types"
  on public.operational_case_types for select
  using (auth.role() = 'authenticated' or auth.role() = 'service_role');

create policy "Service role manages case types"
  on public.operational_case_types for all
  using (auth.role() = 'service_role');

-- ============================================================
-- operational_cases — instancias vivas
-- ============================================================
create table public.operational_cases (
  id                          uuid primary key default uuid_generate_v4(),
  user_id                     uuid not null references public.profiles(id) on delete cascade,
  case_type                   text not null references public.operational_case_types(case_type),
  status                      text not null default 'active'
                                check (status in ('active','waiting_external','paused','completed','failed')),
  current_step                text,
  assigned_to_user_id         uuid references public.profiles(id) on delete set null,
  external_contact_jsonb      jsonb not null default '{}'::jsonb,
  next_action_at              timestamptz,
  due_at                      timestamptz,
  context_jsonb               jsonb not null default '{}'::jsonb,
  version                     int not null default 0,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

comment on table public.operational_cases is
  'Instancias vivas de casos operacionales multi-día. version se usa para optimistic locking: cualquier UPDATE debe verificar version y aumentarla. external_contact_jsonb guarda canal y chat_id del humano externo (ej. {channel: telegram, chat_id: 123}).';

-- Índice para el scanner del cron: sólo casos vencidos en estados procesables
create index idx_operational_cases_due
  on public.operational_cases (next_action_at)
  where status in ('active','waiting_external');

create index idx_operational_cases_user_status
  on public.operational_cases (user_id, status, updated_at desc);

alter table public.operational_cases enable row level security;

create policy "Users manage own cases"
  on public.operational_cases for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Service role full access to operational_cases"
  on public.operational_cases for all
  using (auth.role() = 'service_role');

-- ============================================================
-- operational_case_events — timeline append-only por caso
-- ============================================================
create table public.operational_case_events (
  id              uuid primary key default uuid_generate_v4(),
  case_id         uuid not null references public.operational_cases(id) on delete cascade,
  event_type      text not null
                    check (event_type in (
                      'step_completed',
                      'reminder_sent',
                      'escalated',
                      'human_decision',
                      'external_response',
                      'state_changed',
                      'error'
                    )),
  actor           text not null
                    check (actor in ('system','agent','user','external')),
  payload_jsonb   jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

comment on table public.operational_case_events is
  'Timeline append-only por caso. NO se actualiza ni se borra. La historia completa permite reconstruir cómo llegó el caso a su estado actual.';

create index idx_operational_case_events_case
  on public.operational_case_events (case_id, created_at desc);

alter table public.operational_case_events enable row level security;

-- Lectura: el dueño del caso ve sus eventos.
create policy "Users view own case events"
  on public.operational_case_events for select
  using (
    exists (
      select 1 from public.operational_cases c
      where c.id = operational_case_events.case_id
        and c.user_id = auth.uid()
    )
  );

-- Escritura: SOLO service_role (los eventos los inserta el cron / el agente
-- corriendo en service_role). El usuario nunca debe poder editar la historia.
create policy "Service role inserts case events"
  on public.operational_case_events for insert
  with check (auth.role() = 'service_role');

create policy "Service role full read access to case events"
  on public.operational_case_events for select
  using (auth.role() = 'service_role');

-- Trigger explícito: prohíbe UPDATE y DELETE sobre case_events incluso desde
-- service_role para reforzar la invariante append-only en código. Si alguna
-- vez hay que migrar/reescribir, hacerlo con migración explícita que la
-- desactive temporalmente.
create or replace function public.operational_case_events_enforce_append_only()
returns trigger
language plpgsql
as $fn$
begin
  raise exception 'operational_case_events is append-only (event_type=%, case_id=%)', old.event_type, old.case_id;
end;
$fn$;

create trigger operational_case_events_no_update
  before update on public.operational_case_events
  for each row execute function public.operational_case_events_enforce_append_only();

create trigger operational_case_events_no_delete
  before delete on public.operational_case_events
  for each row execute function public.operational_case_events_enforce_append_only();

-- ============================================================
-- Extender agent_sessions.channel para aceptar 'case_runner'
-- ============================================================
alter table public.agent_sessions
  drop constraint if exists agent_sessions_channel_check;

alter table public.agent_sessions
  add constraint agent_sessions_channel_check
    check (channel in ('web', 'telegram', 'cron', 'heartbeat', 'case_runner'));

-- ============================================================
-- Catálogo inicial: property_optioning
-- ============================================================
-- default_reminder_policy_jsonb:
--   remind_after_h: array de horas tras las que mandar recordatorio si seguimos
--                   en waiting_external sin respuesta del externo.
--   escalate_after_h: horas para escalar al humano interno (no al externo).
insert into public.operational_case_types
  (case_type, display_name, default_skill_slug, default_reminder_policy_jsonb, description)
values (
  'property_optioning',
  'Opcionar propiedad',
  'property-optioning-coach',
  jsonb_build_object(
    'remind_after_h', jsonb_build_array(24, 72),
    'escalate_after_h', 168
  ),
  'Procedimiento end-to-end para obtener la exclusiva/permiso de comercialización de una propiedad: solicitar documentos del propietario, capturar características, hacer análisis de comparables, preparar precio y contrato, coordinar fotos, generar paquete de publicación.'
)
on conflict (case_type) do nothing;
