-- ============================================================
-- 00012_profile_assets.sql
--
-- Assets de perfil por usuario: avatar del usuario y del colaborador IA.
-- Los archivos viven en Supabase Storage bajo:
--   profile-assets/{auth.uid()}/...
-- ============================================================

alter table public.profiles
  add column if not exists avatar_path text,
  add column if not exists avatar_url text;

comment on column public.profiles.avatar_path is
  'Ruta en Supabase Storage para el avatar/foto del usuario.';
comment on column public.profiles.avatar_url is
  'URL opcional/cacheada para el avatar del usuario; puede ser pública o firmada según la configuración del bucket.';

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'profile-assets',
  'profile-assets',
  false,
  5242880,
  array['image/png', 'image/jpeg', 'image/webp', 'image/gif']
)
on conflict (id) do update set
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy "Users can read own profile assets"
  on storage.objects for select
  using (
    bucket_id = 'profile-assets'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy "Users can insert own profile assets"
  on storage.objects for insert
  with check (
    bucket_id = 'profile-assets'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy "Users can update own profile assets"
  on storage.objects for update
  using (
    bucket_id = 'profile-assets'
    and auth.uid()::text = (storage.foldername(name))[1]
  )
  with check (
    bucket_id = 'profile-assets'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy "Users can delete own profile assets"
  on storage.objects for delete
  using (
    bucket_id = 'profile-assets'
    and auth.uid()::text = (storage.foldername(name))[1]
  );
