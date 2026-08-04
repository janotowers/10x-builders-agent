-- ============================================================
-- 00070_impact_plane.sql
--
-- Slice 3.1 (flexible-workflows plan / Technical Plan §11, analysis §7.3):
-- impact plane. Facts are append-only claims with provenance; artifacts pin
-- the inputs they were computed from (input_hash); approvals pin the
-- evidence they were granted against (evidence_hash). Staleness becomes
-- computable instead of implicit.
--
-- Scope guard (implementation-plan rule 13): ONLY case_facts /
-- case_artifacts / artifact_inputs / case_approvals + account_assets
-- versioning. The §11 "additional classes" (knowledge artifact, executable
-- artifact, situational software, turn artifact) add NO tables here.
--
-- Tables are inert until the impact engine (Slice 3.2) consumes them.
-- Rollback = nothing dispatches against them; rows remain audit data.
-- ============================================================

-- ============================================================
-- case_facts — append-only commercial truth with provenance
-- ============================================================
create table public.case_facts (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.operational_cases(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  fact_key text not null,                    -- e.g. 'property.bedrooms'
  value_jsonb jsonb not null,
  source_kind text not null check (source_kind in
    ('user','external_contact','document','integration','derived')),
  source_ref text,                           -- document id, message id, tool call id
  confidence numeric,
  superseded_by uuid references public.case_facts(id) on delete set null,
  recorded_at timestamptz not null default now(),
  constraint case_facts_fact_key_not_empty check (btrim(fact_key) <> ''),
  constraint case_facts_no_self_supersede check (superseded_by is distinct from id)
);

comment on table public.case_facts is
  'Plano de impacto (Technical Plan §11): hechos comerciales append-only con procedencia. Una corrección NUNCA actualiza el valor en sitio: inserta una fila nueva y apunta superseded_by de la anterior a la nueva. La historia de correcciones queda estructural, no por convención.';
comment on column public.case_facts.superseded_by is
  'Única mutación permitida sobre una fila existente: null → id de la fila que la reemplaza (one-shot, ver trigger). Todo lo demás es inmutable.';
comment on column public.case_facts.source_kind is
  'Procedencia del hecho. external_contact participa del screening de Slice 3.2-6; ningún hecho de fuente externa satisface una postcondición de aprobación sin HITL.';

-- Lectura de hechos vigentes por caso/clave (superseded_by is null = vigente).
create index idx_case_facts_current
  on public.case_facts (case_id, fact_key)
  where superseded_by is null;

create index idx_case_facts_case_recorded
  on public.case_facts (case_id, recorded_at desc);

create index idx_case_facts_user
  on public.case_facts (user_id, recorded_at desc);

alter table public.case_facts enable row level security;

create policy "Users view own case facts"
  on public.case_facts for select
  using (auth.uid() = user_id);

create policy "Service role manages case facts"
  on public.case_facts for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- Append-only (patrón 00019/00068/00069) con UNA excepción quirúrgica: fijar
-- superseded_by de null → valor, sin tocar ninguna otra columna. Esa escritura
-- es parte de la semántica de inserción-que-reemplaza, no una edición.
create or replace function public.case_facts_enforce_append_only()
returns trigger
language plpgsql
as $fn$
begin
  if tg_op = 'DELETE' then
    raise exception 'case_facts is append-only (fact_key=%, case_id=%)', old.fact_key, old.case_id;
  end if;
  if old.superseded_by is null
     and new.superseded_by is not null
     and to_jsonb(old) - 'superseded_by' = to_jsonb(new) - 'superseded_by' then
    return new;
  end if;
  raise exception 'case_facts rows are immutable except superseded_by null→value (fact_key=%, case_id=%)', old.fact_key, old.case_id;
end;
$fn$;

create trigger case_facts_no_update
  before update on public.case_facts
  for each row execute function public.case_facts_enforce_append_only();

create trigger case_facts_no_delete
  before delete on public.case_facts
  for each row execute function public.case_facts_enforce_append_only();

-- ============================================================
-- case_artifacts — generated outputs pinned to their inputs
-- ============================================================
create table public.case_artifacts (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.operational_cases(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  artifact_type text not null,               -- comparable_set, valuation, listing_copy, contract_draft…
  content_jsonb jsonb not null,
  input_hash text not null,
  -- Vocabulario §11 (analysis §6.5): current/stale/suspended/invalid/superseded.
  status text not null default 'current'
    check (status in ('current','stale','suspended','invalid','superseded')),
  produced_by_work_item_id uuid references public.work_items(id) on delete set null,
  version integer not null default 1,  -- optimistic locking, mismo patrón que operational_cases
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint case_artifacts_artifact_type_not_empty check (btrim(artifact_type) <> ''),
  constraint case_artifacts_input_hash_not_empty check (btrim(input_hash) <> '')
);

comment on table public.case_artifacts is
  'Plano de impacto (Technical Plan §11): artefactos generados de un caso, con input_hash sobre sus entradas declaradas (artifact_inputs). El motor de impacto (Slice 3.2) recalcula el hash cuando cambia una entrada declarada; hash distinto → stale + evento + trabajo de reparación. Hash igual → current: esa es la garantía de selectividad.';
comment on column public.case_artifacts.status is
  'current: hash de entradas vigente · stale: una entrada declarada cambió · suspended: retenido mecánicamente (nunca revocación de negocio) · invalid: falló verificación · superseded: reemplazado por un artefacto nuevo.';
comment on column public.case_artifacts.input_hash is
  'Hash canónico de las entradas consumidas (generalización de property-identity-signature.ts, Slice 3.2-2). Para entradas account_asset se calcula sobre el content_hash de la VERSIÓN consumida.';

create index idx_case_artifacts_case_type
  on public.case_artifacts (case_id, artifact_type, created_at desc);

create index idx_case_artifacts_user_status
  on public.case_artifacts (user_id, status);

alter table public.case_artifacts enable row level security;

create policy "Users view own case artifacts"
  on public.case_artifacts for select
  using (auth.uid() = user_id);

create policy "Service role manages case artifacts"
  on public.case_artifacts for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create or replace function public.case_artifacts_set_updated_at()
returns trigger
language plpgsql
as $fn$
begin
  new.updated_at = now();
  return new;
end;
$fn$;

create trigger trg_case_artifacts_updated_at
  before update on public.case_artifacts
  for each row execute function public.case_artifacts_set_updated_at();

-- ============================================================
-- artifact_inputs — declared dependency edges
-- ============================================================
-- input_kind incluye account_asset (finding 16): plantillas y watermarks son
-- entradas de artefactos generados y no son ni hechos ni artefactos. Para
-- account_asset, input_id referencia la fila de account_asset_versions
-- consumida (la versión pineada), nunca el asset mutable.
create table public.artifact_inputs (
  artifact_id uuid not null references public.case_artifacts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  input_kind text not null check (input_kind in ('fact','artifact','account_asset')),
  input_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (artifact_id, input_kind, input_id)
);

comment on table public.artifact_inputs is
  'Aristas de dependencia declaradas por la metodología del workflow (impact_dependencies de la definición, Technical Plan §5.2/§11). El sistema NUNCA infiere dependencias universales por nombre de campo. input_id apunta a case_facts.id, case_artifacts.id o account_asset_versions.id según input_kind (sin FK polimórfica; la integridad la garantiza la capa de queries).';

-- Lookup inverso del motor de impacto: entrada cambiada → artefactos afectados.
create index idx_artifact_inputs_input
  on public.artifact_inputs (input_id);

create index idx_artifact_inputs_user
  on public.artifact_inputs (user_id);

alter table public.artifact_inputs enable row level security;

create policy "Users view own artifact inputs"
  on public.artifact_inputs for select
  using (auth.uid() = user_id);

create policy "Service role manages artifact inputs"
  on public.artifact_inputs for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- ============================================================
-- case_approvals — decisions pinned to the evidence they saw
-- ============================================================
create table public.case_approvals (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.operational_cases(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  approval_kind text not null,               -- price, contract, publication…
  decision text not null check (decision in
    ('approved','rejected','suspended','revoked')),
  decided_by uuid references public.profiles(id) on delete set null,
  decided_at timestamptz not null default now(),
  evidence_hash text not null,               -- hash de los hechos/artefactos aprobados
  evidence_snapshot_jsonb jsonb not null,
  superseded_by uuid references public.case_approvals(id) on delete set null,
  rationale text,
  constraint case_approvals_approval_kind_not_empty check (btrim(approval_kind) <> ''),
  constraint case_approvals_evidence_hash_not_empty check (btrim(evidence_hash) <> ''),
  constraint case_approvals_no_self_supersede check (superseded_by is distinct from id)
);

comment on table public.case_approvals is
  'Plano de impacto (Technical Plan §11): aprobaciones ancladas a evidencia. evidence_hash pinea la base sobre la que se decidió; si la base cambia, el motor de impacto suspende (suspended = acto mecánico reversible) y NUNCA revoca automáticamente (revoked = acto de negocio humano). Re-aprobar inserta una fila nueva que reemplaza la anterior vía superseded_by (Slice 3.3).';
comment on column public.case_approvals.evidence_snapshot_jsonb is
  'Snapshot de la evidencia al momento de decidir: qué vio exactamente el humano. Permite mostrar base vieja vs nueva cuando una aprobación se suspende.';

create index idx_case_approvals_case_kind
  on public.case_approvals (case_id, approval_kind, decided_at desc);

create index idx_case_approvals_user
  on public.case_approvals (user_id, decided_at desc);

alter table public.case_approvals enable row level security;

create policy "Users view own case approvals"
  on public.case_approvals for select
  using (auth.uid() = user_id);

create policy "Service role manages case approvals"
  on public.case_approvals for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- ============================================================
-- account_assets versioning (finding 16 / Technical Plan §11)
-- ============================================================
-- Reemplazar un asset crea una versión nueva con su content_hash; nada
-- reescribe la versión desde la que se calculó el input_hash de un artefacto
-- existente. Así un cambio de plantilla stalea selectivamente SOLO los
-- artefactos que declararon ese asset como entrada.

alter table public.account_assets
  add column content_hash text;

comment on column public.account_assets.content_hash is
  'SHA-256 hex del contenido vigente. Se recalcula en cada reemplazo; la historia inmutable vive en account_asset_versions. Nullable: filas previas al backfill (script backfill-account-asset-content-hashes) y upserts sin bytes disponibles.';

create table public.account_asset_versions (
  id uuid primary key default gen_random_uuid(),
  account_asset_id uuid not null references public.account_assets(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  version_number integer not null,
  asset_key text not null,
  content_hash text,                         -- null solo hasta el backfill v1
  storage_bucket text not null,
  storage_path text not null,
  content_type text,
  file_size_bytes bigint,
  created_at timestamptz not null default now(),
  unique (account_asset_id, version_number),
  constraint account_asset_versions_version_positive check (version_number >= 1)
);

comment on table public.account_asset_versions is
  'Registro inmutable por-reemplazo de account_assets (Technical Plan §11, finding 16). artifact_inputs con input_kind=account_asset referencia estas filas: la versión consumida queda pineada aunque el asset se reemplace después. Sin trigger de DELETE: el cascade del padre debe seguir funcionando (borrar el asset borra su historia); la inmutabilidad que importa es no reescribir contenido, y eso lo bloquea el trigger de UPDATE.';
comment on column public.account_asset_versions.content_hash is
  'SHA-256 hex del contenido de ESTA versión. Única mutación permitida: null → valor (backfill v1 hashea los objetos ya almacenados); ver trigger.';

create index idx_account_asset_versions_asset
  on public.account_asset_versions (account_asset_id, version_number desc);

create index idx_account_asset_versions_user
  on public.account_asset_versions (user_id, asset_key);

alter table public.account_asset_versions enable row level security;

create policy "Users view own account asset versions"
  on public.account_asset_versions for select
  using (auth.uid() = user_id);

create policy "Service role manages account asset versions"
  on public.account_asset_versions for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- Inmutable salvo content_hash null → valor (backfill de objetos existentes).
create or replace function public.account_asset_versions_enforce_immutable()
returns trigger
language plpgsql
as $fn$
begin
  if old.content_hash is null
     and new.content_hash is not null
     and to_jsonb(old) - 'content_hash' = to_jsonb(new) - 'content_hash' then
    return new;
  end if;
  raise exception 'account_asset_versions rows are immutable except content_hash null→value (asset_key=%, version=%)', old.asset_key, old.version_number;
end;
$fn$;

create trigger account_asset_versions_no_update
  before update on public.account_asset_versions
  for each row execute function public.account_asset_versions_enforce_immutable();

-- Backfill: cada asset existente queda registrado como versión 1. El hash del
-- objeto almacenado lo calcula el script backfill-account-asset-content-hashes
-- (SQL no puede leer Storage); hasta entonces content_hash queda null.
insert into public.account_asset_versions
  (account_asset_id, user_id, version_number, asset_key, content_hash,
   storage_bucket, storage_path, content_type, file_size_bytes)
select
  a.id, a.user_id, 1, a.asset_key, null,
  a.storage_bucket, a.storage_path, a.content_type, a.file_size_bytes
from public.account_assets a;
