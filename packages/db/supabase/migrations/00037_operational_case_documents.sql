-- ============================================================
-- 00037_operational_case_documents.sql
--
-- Evidencia documental asociada a casos operacionales. A diferencia de
-- account_assets, estos archivos son artefactos de un caso concreto
-- (predial, escritura, INE, etc.) y pueden venir del contacto externo o
-- del asesor.
-- ============================================================

create table if not exists public.operational_case_documents (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.operational_cases(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null,
  display_name text,
  storage_bucket text not null default 'case-documents',
  storage_path text not null,
  original_name text,
  content_type text,
  file_size_bytes bigint,
  sha256 text,
  source text not null default 'unknown'
    check (source in ('external_telegram','advisor_web','advisor_telegram','settings_test','unknown')),
  source_metadata_jsonb jsonb not null default '{}'::jsonb,
  blocking boolean not null default false,
  status text not null default 'received'
    check (status in ('received','superseded','rejected')),
  extraction_status text not null default 'pending'
    check (extraction_status in ('pending','ok','low_confidence','failed','not_applicable')),
  extraction_model text,
  extraction_jsonb jsonb not null default '{}'::jsonb,
  extracted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint operational_case_documents_kind_not_empty check (btrim(kind) <> ''),
  constraint operational_case_documents_storage_path_not_empty check (btrim(storage_path) <> '')
);

comment on table public.operational_case_documents is
  'Documentos/evidencia privada asociada a un operational_case concreto. Los bytes viven en Supabase Storage y esta tabla guarda metadata, extracción y auditoría.';
comment on column public.operational_case_documents.kind is
  'Tipo canónico: escritura_descripcion, predial, ine, comprobante_domicilio, boleta_registral, escritura_primera_hoja, escritura_ultima_hoja, etc.';
comment on column public.operational_case_documents.sha256 is
  'Hash del contenido para evitar re-extraer con visión si el archivo no cambió.';

create index if not exists idx_operational_case_documents_case
  on public.operational_case_documents (case_id, created_at desc);

create index if not exists idx_operational_case_documents_user_kind
  on public.operational_case_documents (user_id, kind, created_at desc);

create index if not exists idx_operational_case_documents_active_sha
  on public.operational_case_documents (case_id, kind, sha256)
  where sha256 is not null and status <> 'superseded';

alter table public.operational_case_documents enable row level security;

drop policy if exists "Users view own case documents"
  on public.operational_case_documents;

create policy "Users view own case documents"
  on public.operational_case_documents for select
  using (auth.uid() = user_id);

drop policy if exists "Service role manages case documents"
  on public.operational_case_documents;

create policy "Service role manages case documents"
  on public.operational_case_documents for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create or replace function public.operational_case_documents_set_updated_at()
returns trigger
language plpgsql
as $fn$
begin
  new.updated_at = now();
  return new;
end;
$fn$;

drop trigger if exists trg_operational_case_documents_updated_at
  on public.operational_case_documents;

create trigger trg_operational_case_documents_updated_at
before update on public.operational_case_documents
for each row execute function public.operational_case_documents_set_updated_at();

insert into storage.buckets (id, name, public)
values ('case-documents', 'case-documents', false)
on conflict (id) do nothing;

drop policy if exists "Users can read own case document objects"
  on storage.objects;

create policy "Users can read own case document objects"
  on storage.objects for select
  using (
    bucket_id = 'case-documents'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists "Service role manages case document objects"
  on storage.objects;

create policy "Service role manages case document objects"
  on storage.objects for all
  using (bucket_id = 'case-documents' and auth.role() = 'service_role')
  with check (bucket_id = 'case-documents' and auth.role() = 'service_role');
