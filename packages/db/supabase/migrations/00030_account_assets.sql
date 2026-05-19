-- ============================================================
-- 00030_account_assets.sql
--
-- Assets por cuenta requeridos por flujos operativos: plantillas,
-- watermarks y otros recursos configurables por el usuario.
-- ============================================================

create table if not exists public.account_assets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  asset_key text not null,
  display_name text not null,
  description text,
  storage_bucket text not null default 'account-assets',
  storage_path text not null,
  content_type text,
  file_size_bytes bigint,
  source_tool_id text,
  case_type_id uuid references public.operational_case_types(id) on delete set null,
  metadata_jsonb jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint account_assets_asset_key_not_empty check (btrim(asset_key) <> ''),
  constraint account_assets_display_name_not_empty check (btrim(display_name) <> ''),
  constraint account_assets_storage_path_not_empty check (btrim(storage_path) <> ''),
  constraint account_assets_user_asset_key_unique unique (user_id, asset_key)
);

comment on table public.account_assets is
  'Archivos/configuraciones por cuenta requeridos por tools en operational_flow_jsonb.required_assets.';
comment on column public.account_assets.asset_key is
  'Clave estable declarada por required_assets[].asset_key, por ejemplo commission_contract_template.';
comment on column public.account_assets.storage_path is
  'Ruta privada en Supabase Storage. Debe vivir bajo {user_id}/... en el bucket account-assets.';

alter table public.account_assets enable row level security;

create policy "Users can read own account assets"
  on public.account_assets for select
  using (auth.uid() = user_id);

create policy "Users can insert own account assets"
  on public.account_assets for insert
  with check (auth.uid() = user_id);

create policy "Users can update own account assets"
  on public.account_assets for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can delete own account assets"
  on public.account_assets for delete
  using (auth.uid() = user_id);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'account-assets',
  'account-assets',
  false,
  15728640,
  array[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/msword',
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/svg+xml'
  ]
)
on conflict (id) do update set
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy "Users can read own account asset files"
  on storage.objects for select
  using (
    bucket_id = 'account-assets'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy "Users can insert own account asset files"
  on storage.objects for insert
  with check (
    bucket_id = 'account-assets'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy "Users can update own account asset files"
  on storage.objects for update
  using (
    bucket_id = 'account-assets'
    and auth.uid()::text = (storage.foldername(name))[1]
  )
  with check (
    bucket_id = 'account-assets'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy "Users can delete own account asset files"
  on storage.objects for delete
  using (
    bucket_id = 'account-assets'
    and auth.uid()::text = (storage.foldername(name))[1]
  );
