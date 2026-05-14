-- ============================================================
-- 00022_operational_case_type_ownership_intake.sql
--
-- Evoluciona el subsistema de Casos operacionales para que los "casos de
-- uso" puedan ser:
--   - global (plantillas del producto, user_id IS NULL),
--   - private (propias de una cuenta, user_id = profile),
--   - shared (reservado para compartición explícita).
--
-- Cambios clave:
--   1. operational_case_types deja de tener PK por slug y pasa a usar `id uuid`.
--   2. Mantiene `case_type` como slug legible, único por scope:
--        - unique(case_type) where user_id IS NULL  (slugs globales)
--        - unique(user_id, case_type)               (slugs privados/compartidos)
--   3. operational_cases gana `case_type_id uuid` como FK real.
--      Mantiene `case_type` como cache denormalizada (logs/UX) — la fuente de
--      verdad pasa a ser `case_type_id`.
--   4. Añade `intake_schema_jsonb` para renderizar formularios dinámicos.
--   5. RLS: cada usuario ve globales + las suyas; sólo administra las suyas.
-- ============================================================

create extension if not exists "uuid-ossp";

-- ── 1. Nuevas columnas en operational_case_types ──────────────────────
alter table public.operational_case_types
  add column if not exists id uuid not null default uuid_generate_v4(),
  add column if not exists user_id uuid references public.profiles(id) on delete cascade,
  add column if not exists visibility text not null default 'global',
  add column if not exists status text not null default 'active',
  add column if not exists intake_schema_jsonb jsonb not null default '[]'::jsonb;

-- ── 2. Nueva FK denormalizada en operational_cases ────────────────────
alter table public.operational_cases
  add column if not exists case_type_id uuid;

update public.operational_cases oc
set case_type_id = oct.id
from public.operational_case_types oct
where oct.case_type = oc.case_type
  and oc.case_type_id is null;

-- ── 3. Romper la PK por slug y la FK que dependía de ella ─────────────
alter table public.operational_cases
  drop constraint if exists operational_cases_case_type_fkey;

alter table public.operational_case_types
  drop constraint if exists operational_case_types_pkey;

alter table public.operational_case_types
  add primary key (id);

-- ── 4. Re-cablear la FK por id ────────────────────────────────────────
alter table public.operational_cases
  add constraint operational_cases_case_type_id_fkey
    foreign key (case_type_id)
    references public.operational_case_types(id)
    on delete restrict;

alter table public.operational_cases
  alter column case_type_id set not null;

-- ── 5. Unicidad del slug por scope ────────────────────────────────────
create unique index if not exists operational_case_types_global_slug_idx
  on public.operational_case_types (case_type)
  where user_id is null;

create unique index if not exists operational_case_types_private_slug_idx
  on public.operational_case_types (user_id, case_type)
  where user_id is not null;

-- ── 6. Checks de visibility / status ──────────────────────────────────
alter table public.operational_case_types
  drop constraint if exists operational_case_types_visibility_check;

alter table public.operational_case_types
  add constraint operational_case_types_visibility_check
    check (visibility in ('global', 'private', 'shared'));

alter table public.operational_case_types
  drop constraint if exists operational_case_types_status_check;

alter table public.operational_case_types
  add constraint operational_case_types_status_check
    check (status in ('draft', 'active', 'archived'));

-- ── 7. RLS ────────────────────────────────────────────────────────────
drop policy if exists "Authenticated users can read case types"
  on public.operational_case_types;

create policy "Users read visible case types"
  on public.operational_case_types for select
  using (
    auth.role() = 'service_role'
    or visibility = 'global'
    or user_id = auth.uid()
  );

create policy "Users manage own case types"
  on public.operational_case_types for all
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and visibility in ('private', 'shared')
  );

-- ── 8. Backfill del intake_schema para `property_optioning` global ────
update public.operational_case_types
set intake_schema_jsonb = jsonb_build_array(
  jsonb_build_object(
    'name', 'property_title',
    'label', 'Título / propiedad',
    'type', 'text',
    'required', true,
    'placeholder', 'Ej. Departamento Polanco'
  ),
  jsonb_build_object(
    'name', 'owner_name',
    'label', 'Nombre del propietario',
    'type', 'text',
    'required', false,
    'placeholder', 'Nombre del dueño/lead'
  ),
  jsonb_build_object(
    'name', 'telegram_chat_id',
    'label', 'Telegram chat_id externo',
    'type', 'number',
    'required', false,
    'placeholder', 'Ej. 123456789',
    'help_text', 'Opcional; requiere que el contacto haya escrito al bot.'
  )
)
where case_type = 'property_optioning'
  and user_id is null
  and intake_schema_jsonb = '[]'::jsonb;

-- ── 9. Caso de uso global mínimo: lead_follow_up ──────────────────────
insert into public.operational_case_types
  (
    case_type,
    display_name,
    default_skill_slug,
    default_reminder_policy_jsonb,
    description,
    visibility,
    status,
    intake_schema_jsonb
  )
select
  'lead_follow_up',
  'Seguimiento de lead',
  'lead-follow-up-draft',
  jsonb_build_object(
    'remind_after_h', jsonb_build_array(24, 48),
    'escalate_after_h', 96
  ),
  'Caso de uso mínimo para validar formularios dinámicos: capturar datos de un lead, objetivo del seguimiento y canal preferido. No está pensado todavía como flujo productivo completo.',
  'global',
  'active',
  jsonb_build_array(
    jsonb_build_object(
      'name', 'lead_name',
      'label', 'Nombre del lead',
      'type', 'text',
      'required', true,
      'placeholder', 'Ej. Mariana López'
    ),
    jsonb_build_object(
      'name', 'interest',
      'label', 'Interés / inmueble',
      'type', 'textarea',
      'required', false,
      'placeholder', 'Qué está buscando o qué inmueble preguntó'
    ),
    jsonb_build_object(
      'name', 'preferred_channel',
      'label', 'Canal preferido',
      'type', 'select',
      'required', false,
      'options', jsonb_build_array('telegram', 'whatsapp', 'email', 'phone')
    )
  )
where not exists (
  select 1 from public.operational_case_types
  where case_type = 'lead_follow_up'
    and user_id is null
);
