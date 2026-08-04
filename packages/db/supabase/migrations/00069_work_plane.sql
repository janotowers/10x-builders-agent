-- ============================================================
-- 00069_work_plane.sql
--
-- Slice 2.1 (flexible-workflows plan / Technical Plan §7/§10): work plane.
-- Four tables: work_items, work_item_attempts, work_item_dependencies,
-- work_item_events. Business truth stays on operational_cases; executable
-- work lives here. Case vocabulary and work vocabulary never mix.
--
-- Tables are inert until the v2 work-plane flag dispatches against them
-- (account_feature_flags). Rollback = flag off; tables keep audit data.
--
-- Terminology: claim liveness fields deliberately avoid the word
-- "heartbeat" — that name is reserved for the Gu OS Heartbeat
-- proactive-execution feature (api/cron/heartbeat).
-- ============================================================

-- ============================================================
-- work_items — executable units of work owned by a case
-- ============================================================
create table public.work_items (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.operational_cases(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  workflow_definition_version integer not null,
  work_type text not null,
  -- Provenance (implementation-plan finding 17): how the item came to exist.
  -- Only 'definition_template' has a Phase 2 consumer; 'impact_repair' lands
  -- with Slice 3.2; 'agent_proposed'/'human' are reserved seams. Dispatch,
  -- readiness, and claim logic never branch on this column.
  origin text not null default 'definition_template'
    check (origin in ('definition_template','impact_repair','agent_proposed','human')),
  status text not null default 'todo'
    check (status in ('todo','ready','running','blocked','review','done','cancelled')),
  priority integer not null default 100,
  required_capability text not null,
  -- FK to worker_profiles deferred: that table arrives with Phase 3
  -- (migration 00071 per plan). Do not add FKs to future tables.
  assigned_worker_profile_id uuid,
  not_before timestamptz,
  due_at timestamptz,
  attempt_count integer not null default 0,
  max_attempts integer not null default 3,
  current_attempt_id uuid,  -- FK added below, after work_item_attempts exists
  blocked_reason text,
  input_contract_jsonb jsonb not null default '{}'::jsonb,
  output_contract_jsonb jsonb not null default '{}'::jsonb,
  verification_contract_jsonb jsonb not null default '{}'::jsonb,
  result_jsonb jsonb,
  idempotency_key text,
  version integer not null default 1,  -- optimistic locking, same pattern as operational_cases
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (case_id, idempotency_key),
  constraint work_items_work_type_not_empty check (btrim(work_type) <> ''),
  constraint work_items_required_capability_not_empty check (btrim(required_capability) <> '')
);

comment on table public.work_items is
  'Plano de trabajo (Technical Plan §7): unidades ejecutables pertenecientes a un operational_case. Vocabulario de estados genérico (todo/ready/running/blocked/review/done/cancelled), deliberadamente distinto del vocabulario del caso. ready se calcula por satisfacción de dependencias, nunca a mano. La finalización de trabajo jamás escribe current_step del caso directamente: el avance del caso pasa por el advancement predicate de la definición (§8.4).';
comment on column public.work_items.origin is
  'Procedencia (finding 17): definition_template (instanciado on_enter_state, Phase 2), impact_repair (impact engine, Phase 3), agent_proposed/human (costuras reservadas, sin consumidor hasta que existan verification contracts). El despacho nunca hace branch sobre esta columna.';
comment on column public.work_items.version is
  'Optimistic locking: todo UPDATE verifica version y la incrementa (mismo patrón que operational_cases).';

-- Dispatch de items listos: por tenant, en orden de prioridad, respetando not_before.
create index idx_work_items_ready_dispatch
  on public.work_items (user_id, priority, not_before)
  where status = 'ready';

-- Vista de trabajo por caso.
create index idx_work_items_case_status
  on public.work_items (case_id, status);

-- Propagación de readiness por tenant (items todo con dependencias resueltas).
create index idx_work_items_user_status
  on public.work_items (user_id, status);

alter table public.work_items enable row level security;

create policy "Users view own work items"
  on public.work_items for select
  using (auth.uid() = user_id);

create policy "Service role manages work items"
  on public.work_items for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create or replace function public.work_items_set_updated_at()
returns trigger
language plpgsql
as $fn$
begin
  new.updated_at = now();
  return new;
end;
$fn$;

create trigger trg_work_items_updated_at
  before update on public.work_items
  for each row execute function public.work_items_set_updated_at();

-- ============================================================
-- work_item_attempts — execution-specific state (claims live here)
-- ============================================================
-- Claim fields live on attempts, not on the item: one item may be processed
-- by several executors across retries; claim fields on work_items would let
-- attempt 2 overwrite attempt 1's stale claim (Technical Plan §10).
create table public.work_item_attempts (
  id uuid primary key default gen_random_uuid(),
  work_item_id uuid not null references public.work_items(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  attempt_number integer not null,
  executor_kind text not null,
  executor_ref text,  -- runner id / profile id / external correlation id
  -- FK to worker_profiles deferred to Phase 3 (same rationale as work_items).
  worker_profile_id uuid,
  status text not null
    check (status in ('running','succeeded','failed','claim_expired','cancelled')),
  claimed_at timestamptz not null default now(),
  claim_expires_at timestamptz not null,
  -- Most recent liveness update from the executor processing this attempt.
  -- Unrelated to the Gu OS Heartbeat proactive-execution feature.
  last_liveness_at timestamptz,
  last_progress_at timestamptz,  -- alive vs actually advancing (optional signal)
  completed_at timestamptz,
  error_jsonb jsonb,
  evidence_jsonb jsonb,
  created_at timestamptz not null default now(),
  unique (work_item_id, attempt_number)
);

comment on table public.work_item_attempts is
  'Intentos de ejecución de un work_item (Technical Plan §10). El claim (claimed_at/claim_expires_at) y la vitalidad del ejecutor (last_liveness_at) viven aquí, no en el item. Una actualización de vitalidad PUEDE renovar el lease (extender claim_expires_at) pero son cosas distintas: la renovación emite su propio evento append-only (claim_renewed); nunca colapsar ambas en un solo timestamp.';
comment on column public.work_item_attempts.last_liveness_at is
  'Última señal de actividad del ejecutor. Unrelated to the Gu OS Heartbeat proactive-execution feature.';
comment on column public.work_item_attempts.claim_expires_at is
  'Vigencia del claim. Un attempt running con claim_expires_at < now() es un stale claim: recovery lo marca claim_expired, regresa el item a ready y limpia current_attempt_id sin incrementar attempt_count.';

-- Stale-claim recovery: attempts running con lease vencido.
create index idx_work_item_attempts_running_expiry
  on public.work_item_attempts (claim_expires_at)
  where status = 'running';

create index idx_work_item_attempts_item
  on public.work_item_attempts (work_item_id, attempt_number desc);

alter table public.work_item_attempts enable row level security;

create policy "Users view own work item attempts"
  on public.work_item_attempts for select
  using (auth.uid() = user_id);

create policy "Service role manages work item attempts"
  on public.work_item_attempts for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- FK diferido: work_items.current_attempt_id → work_item_attempts.
alter table public.work_items
  add constraint work_items_current_attempt_fk
    foreign key (current_attempt_id)
    references public.work_item_attempts(id)
    on delete set null;

-- ============================================================
-- work_item_dependencies — edges (fan-out / fan-in caen de la tabla)
-- ============================================================
create table public.work_item_dependencies (
  work_item_id uuid not null references public.work_items(id) on delete cascade,
  depends_on_id uuid not null references public.work_items(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  dependency_kind text not null default 'finish_to_start',
  created_at timestamptz not null default now(),
  primary key (work_item_id, depends_on_id),
  check (work_item_id <> depends_on_id)
);

comment on table public.work_item_dependencies is
  'Aristas de dependencia entre work_items (Technical Plan §8). El rechazo de ciclos ocurre al compilar la definición; el check de auto-referencia atrapa ciclos triviales en insert. ready = todas las dependencias done y not_before vencido (propagación set-based, nunca loop por item).';

-- Propagación de readiness: al completar un item, encontrar dependientes.
create index idx_work_item_dependencies_depends_on
  on public.work_item_dependencies (depends_on_id);

alter table public.work_item_dependencies enable row level security;

create policy "Users view own work item dependencies"
  on public.work_item_dependencies for select
  using (auth.uid() = user_id);

create policy "Service role manages work item dependencies"
  on public.work_item_dependencies for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- ============================================================
-- work_item_events — timeline append-only por work_item
-- ============================================================
-- Sin CHECK cerrado sobre event_type (aprendizaje del finding 9: el CHECK
-- cerrado de operational_case_events obligó a discriminar por payload.kind).
-- El vocabulario vive en packages/types (claimed, claim_renewed,
-- liveness_updated, claim_expired, verified, blocked, done, …).
create table public.work_item_events (
  id uuid primary key default gen_random_uuid(),
  work_item_id uuid not null references public.work_items(id) on delete cascade,
  attempt_id uuid references public.work_item_attempts(id) on delete set null,
  user_id uuid not null references public.profiles(id) on delete cascade,
  event_type text not null,
  actor text not null,
  payload_jsonb jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint work_item_events_event_type_not_empty check (btrim(event_type) <> ''),
  constraint work_item_events_actor_not_empty check (btrim(actor) <> '')
);

comment on table public.work_item_events is
  'Timeline append-only por work_item. NO se actualiza ni se borra: la historia permite reconstruir claims, renovaciones de lease, expiraciones y verificaciones. Doble claim silencioso = imposible de ocultar.';

create index idx_work_item_events_item
  on public.work_item_events (work_item_id, created_at desc);

create index idx_work_item_events_user
  on public.work_item_events (user_id, created_at desc);

alter table public.work_item_events enable row level security;

create policy "Users view own work item events"
  on public.work_item_events for select
  using (auth.uid() = user_id);

create policy "Service role manages work item events"
  on public.work_item_events for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- Append-only enforcement (patrón 00019/00068): prohibido incluso para
-- service_role; una reescritura requiere migración explícita que lo
-- desactive temporalmente.
create or replace function public.work_item_events_enforce_append_only()
returns trigger
language plpgsql
as $fn$
begin
  raise exception 'work_item_events is append-only (event_type=%, work_item_id=%)', old.event_type, old.work_item_id;
end;
$fn$;

create trigger work_item_events_no_update
  before update on public.work_item_events
  for each row execute function public.work_item_events_enforce_append_only();

create trigger work_item_events_no_delete
  before delete on public.work_item_events
  for each row execute function public.work_item_events_enforce_append_only();
