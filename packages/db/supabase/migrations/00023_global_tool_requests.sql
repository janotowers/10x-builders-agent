-- ============================================================
-- 00023_global_tool_requests.sql
--
-- Solicitudes de incorporación de tools al catálogo/producto global.
--
-- Se crean desde "Ajustes -> Casos de uso -> Preparación operativa" cuando una
-- tool requerida por una skill privada no existe en TOOL_CATALOG o existe pero
-- todavía no tiene una pantalla de conexión/configuración para la cuenta
-- (ej. EasyBroker, Ungga, Tokko, Wiggot, templates de documentos, watermark).
--
-- No reemplaza a una integración real: documenta el backlog de capacidades
-- globales que el equipo de Ungga debe ir incorporando gradualmente. El admin
-- del producto las revisa, prioriza y al implementarlas cierra la solicitud.
--
-- V1 deliberadamente mínimo: tabla con RLS por usuario solicitante. No hay
-- todavía panel admin, votos ni notificaciones; eso queda para versiones
-- posteriores (ver docs/operational-cases/future-considerations.md).
-- ============================================================

create table public.global_tool_requests (
  id                    uuid primary key default uuid_generate_v4(),
  user_id               uuid not null references public.profiles(id) on delete cascade,
  case_type_id          uuid references public.operational_case_types(id) on delete set null,
  tool_id               text not null,
  request_kind          text not null
                          check (request_kind in (
                            'incorporate_to_catalog',
                            'enable_account_config',
                            'provide_tenant_asset'
                          )),
  business_context      text,
  status                text not null default 'requested'
                          check (status in (
                            'requested',
                            'in_review',
                            'in_progress',
                            'shipped',
                            'rejected'
                          )),
  admin_notes           text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

comment on table public.global_tool_requests is
  'Solicitudes de incorporación de tools/capacidades al catálogo o configuración por cuenta. Sirve como backlog visible para el equipo de Ungga sobre qué herramientas comunes deben pasar a estar disponibles globalmente. No es una integración: es una petición.';

comment on column public.global_tool_requests.request_kind is
  'incorporate_to_catalog: la tool no existe en TOOL_CATALOG y debería incorporarse al producto. enable_account_config: la tool existe pero falta la pantalla/flujo para conectarla por cuenta (ej. EasyBroker). provide_tenant_asset: la tool requiere un asset/configuración tenant (ej. template de documento, watermark).';

create index idx_global_tool_requests_user
  on public.global_tool_requests (user_id, created_at desc);

create index idx_global_tool_requests_tool_status
  on public.global_tool_requests (tool_id, status, created_at desc);

alter table public.global_tool_requests enable row level security;

create policy "Users manage own tool requests"
  on public.global_tool_requests for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Service role full access to global_tool_requests"
  on public.global_tool_requests for all
  using (auth.role() = 'service_role');
