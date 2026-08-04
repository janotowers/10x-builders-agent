-- ============================================================
-- 00071_worker_profiles.sql
--
-- Slice 3.4-1 (flexible-workflows plan / Technical Plan §9): worker
-- profiles. Un work item pide una `required_capability`; el runtime la
-- resuelve a un perfil y hace enforcement de allowed_tools /
-- allowed_data_scopes EN LA SELECCIÓN del ejecutor, nunca vía prompt.
--
-- Seguridad (§21): los perfiles JAMÁS embeben credenciales — no hay
-- columnas de secretos y ninguna columna jsonb debe contenerlos. La
-- ejecución siempre es tenant-scoped (hereda el user_id del work item);
-- user_id null = perfil global (catálogo), no ejecución global.
--
-- model_policy_jsonb (§9.1): alias lógico + budgets; el alias se resuelve
-- en código (packages/agent/src/model.ts) contra un mapa central de ids de
-- OpenRouter — las definiciones no hardcodean strings de vendor.
-- ============================================================

create table public.worker_profiles (
  id uuid primary key default gen_random_uuid(),
  -- null = perfil global disponible para todos los tenants; un tenant puede
  -- sombrear un slug global con su propia fila (unique por (user_id, slug)).
  user_id uuid references public.profiles(id) on delete cascade,
  slug text not null,
  capabilities text[] not null default '{}',
  execution_mode text not null check (execution_mode in
    ('main_agent','deterministic_service','specialized_agent','ephemeral_subagent',
     'durable_worker','external_service','human')),
  allowed_tools text[] not null default '{}',
  allowed_data_scopes text[] not null default '{}',
  model_policy_jsonb jsonb not null default '{}',
  approval_policy_jsonb jsonb not null default '{}',
  timeout_seconds integer not null default 300,
  retry_policy_jsonb jsonb not null default '{}',
  verification_contract_jsonb jsonb not null default '{}',
  max_concurrency integer not null default 1,
  cost_ceiling_cents integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint worker_profiles_slug_not_empty check (btrim(slug) <> ''),
  unique (user_id, slug)
);

comment on table public.worker_profiles is
  'Perfiles de ejecutores del plano de trabajo (Technical Plan §9). El runtime resuelve required_capability → perfil y hace enforcement de tool/data scopes en la selección. Nunca contienen credenciales (§21); user_id null = perfil global de catálogo.';
comment on column public.worker_profiles.model_policy_jsonb is
  'Política de modelo §9.1: { role, model_alias, fallback_aliases, max_output_tokens, temperature, max_cost_cents_per_run }. Alias → id concreto se resuelve en código; perfiles deterministas la ignoran.';
comment on column public.worker_profiles.allowed_data_scopes is
  'Scopes de datos que la selección permite al ejecutor (p. ej. case_facts:read). El enforcement ocurre al elegir ejecutor, no dentro del prompt.';

-- Unicidad del slug global (user_id null no participa en UNIQUE estándar).
create unique index idx_worker_profiles_global_slug
  on public.worker_profiles (slug)
  where user_id is null;

create index idx_worker_profiles_user
  on public.worker_profiles (user_id)
  where user_id is not null;

alter table public.worker_profiles enable row level security;

-- Tenants ven perfiles globales + los suyos. Escritura solo service-role
-- (el authoring de perfiles no es una superficie de usuario en Phase 3).
create policy "Users view global and own worker profiles"
  on public.worker_profiles for select
  using (user_id is null or auth.uid() = user_id);

create policy "Service role manages worker profiles"
  on public.worker_profiles for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- ============================================================
-- Seed §9 "introduce now": dos servicios deterministas levantados de código
-- existente + el verificador de valuación (specialized_agent, read-only).
-- ============================================================

insert into public.worker_profiles
  (user_id, slug, capabilities, execution_mode, allowed_tools,
   allowed_data_scopes, model_policy_jsonb, verification_contract_jsonb,
   timeout_seconds, max_concurrency)
values
  -- Publication reconciliation: envuelve publication-reconcile.ts. Perfil
  -- determinista ⇒ model_policy vacía/ignorada.
  (null, 'publication_reconciliation',
   array['service:publication_reconciliation'],
   'deterministic_service',
   array[]::text[],
   array['operational_cases:read','operational_cases:write',
         'integrations:easybroker:read','integrations:ungga:read'],
   '{}'::jsonb,
   '{"output": "publication_state_with_changes"}'::jsonb,
   300, 1),
  -- Extraction consolidation: sección de consolidación de
  -- property-optioning-post-agent-invariants.ts tras contrato explícito.
  (null, 'extraction_consolidation',
   array['service:extraction_consolidation'],
   'deterministic_service',
   array[]::text[],
   array['operational_cases:read','operational_cases:write',
         'case_documents:read'],
   '{}'::jsonb,
   '{"output": "consolidated_property_data"}'::jsonb,
   300, 1),
  -- Valuation verifier (§9 activation bar: verificación independiente +
  -- aislamiento de contexto). Superficie read-only: SIN tools; solo lee el
  -- comparable set y los hechos de la propiedad — nunca el razonamiento de
  -- la recomendación. Arranca en reasoning_standard; sube a reasoning_high
  -- solo cuando los contadores de falso-accept/reject crucen el umbral §9.1.
  (null, 'valuation_verifier',
   array['agent:valuation_verifier'],
   'specialized_agent',
   array[]::text[],
   array['case_facts:read','case_artifacts:read'],
   '{"role": "valuation_verifier", "model_alias": "reasoning_standard",
     "fallback_aliases": [], "max_output_tokens": 3000, "temperature": 0,
     "max_cost_cents_per_run": 8}'::jsonb,
   '{"output": "pass_fail_findings", "read_only": true}'::jsonb,
   180, 1);
