-- ============================================================
-- 00009_business_brain.sql
--
-- V1-C-α: añade el "Business Brain" del agente como columna JSONB
-- en el perfil de cada usuario.
--
-- El Business Brain es el contenedor estructurado por-tenant donde
-- guardamos el contexto que el agente carga en cada turno (cuando
-- un skill lo requiera): identidad de la inmobiliaria, project/dataset
-- de BigQuery, configuración del Heartbeat, reglas operativas, etc.
--
-- Forma del JSONB (en V1-C-α solo usamos `identity` y `bigquery`,
-- el resto se reserva sin romper compatibilidad):
--
-- {
--   "identity": {
--     "organization_id": "string",      -- id en BigQuery (firestore_users.organization_id)
--     "org_name": "string",             -- nombre legible (Inmobiliaria Garios)
--     "country": "MX" | "US" | "..."    -- país principal (informativo)
--   },
--   "bigquery": {
--     "project_id": "ungga-full",
--     "location": "US",
--     "dataset_allowlist": ["firestore_users", "mongo_data", ...]
--   },
--   "context": { ... },          -- libre, para V1-D
--   "operating_rules": { ... },  -- libre, para V1-D
--   "heartbeat": { ... }         -- libre, para V2 (checklist + intervalo)
-- }
--
-- La columna `is_ungga_admin BOOLEAN` ya fue añadida manualmente por
-- el usuario en Supabase con default FALSE; aquí solo nos aseguramos
-- (idempotente) por si alguien re-aplica desde cero.
-- ============================================================

alter table public.profiles
  add column if not exists business_brain jsonb not null default '{}'::jsonb,
  add column if not exists is_ungga_admin boolean not null default false;

-- Índice GIN solo sobre las claves "identity" y "bigquery" no es necesario
-- en V1: las consultas siempre se hacen por `id` (PK del profile) y
-- después leen `business_brain` en memoria. Si en V1-D necesitamos
-- buscar perfiles por `organization_id`, añadiremos un índice expresión.

-- Comentarios autodocumentados (visibles en pgAdmin / Supabase UI):
comment on column public.profiles.business_brain is
  'JSONB: contenedor por-tenant del agente. Slots: identity, bigquery, context, operating_rules, heartbeat. Lo lee runAgent y lo materializa en un bloque [Contexto de tenant] cuando la skill activa lo requiere.';
comment on column public.profiles.is_ungga_admin is
  'TRUE para personal interno de Ungga (visibilidad cross-tenant en BigQuery). Por defecto FALSE.';
