-- Slice 5.3.1: claim de materialización atómico para evitar borradores
-- duplicados cuando hay doble clic, retry HTTP o pestañas paralelas.

alter table public.studio_authoring_sessions
  drop constraint if exists studio_authoring_sessions_status_check;

alter table public.studio_authoring_sessions
  add constraint studio_authoring_sessions_status_check
  check (
    status in (
      'active',
      'clarifying',
      'materializing',
      'compiled',
      'abandoned',
      'redirected'
    )
  );

comment on column public.studio_authoring_sessions.status is
  'Lifecycle de discovery/confirmación. materializing es un claim transaccional: sólo una solicitud confirmada puede crear el artefacto.';
