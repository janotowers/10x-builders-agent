-- ============================================================
-- 00079_generic_attachments.sql
--
-- Tenant-scoped metadata and message/turn associations for private files.
-- Bytes remain in Supabase Storage; this migration does not implement or
-- claim malware scanning.
-- ============================================================

create table public.user_files (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  bucket text not null default 'user-files',
  path text not null,
  original_name text not null,
  mime_type text not null,
  size_bytes bigint not null check (size_bytes >= 0),
  sha256 text not null,
  source text not null default 'upload'
    check (source in ('upload', 'generated', 'external_copy', 'migrated')),
  status text not null default 'pending_upload'
    check (status in (
      'pending_upload', 'uploaded', 'processing', 'ready', 'failed', 'deleted'
    )),
  validation_status text not null default 'pending'
    check (validation_status in ('pending', 'accepted', 'rejected', 'failed')),
  validation_metadata_jsonb jsonb not null default '{}'::jsonb,
  scan_status text not null default 'not_scanned'
    check (scan_status in ('not_scanned', 'pending', 'clean', 'flagged', 'failed')),
  scan_metadata_jsonb jsonb not null default '{}'::jsonb,
  processing_error_jsonb jsonb,
  metadata_jsonb jsonb not null default '{}'::jsonb,
  retention text not null default 'standard'
    check (retention in ('temporary', 'session', 'standard', 'retained')),
  expires_at timestamptz,
  processing_started_at timestamptz,
  ready_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint user_files_original_name_not_empty
    check (btrim(original_name) <> ''),
  constraint user_files_mime_type_not_empty
    check (btrim(mime_type) <> ''),
  constraint user_files_sha256_hex
    check (sha256 ~ '^[0-9a-f]{64}$'),
  constraint user_files_path_owned
    check (path like ('users/' || user_id::text || '/%')),
  constraint user_files_deleted_shape
    check (
      (status = 'deleted' and deleted_at is not null)
      or (status <> 'deleted' and deleted_at is null)
    ),
  constraint user_files_ready_shape
    check (
      (status = 'ready' and ready_at is not null and validation_status = 'accepted')
      or status <> 'ready'
    ),
  unique (user_id, id),
  unique (bucket, path)
);

comment on table public.user_files is
  'Tenant-owned metadata for private uploaded, copied, or generated files. Object bytes live in Supabase Storage.';
comment on column public.user_files.scan_status is
  'Reserved integration state. not_scanned makes no malware-safety assertion; this migration adds no scanner.';
comment on column public.user_files.validation_metadata_jsonb is
  'Deterministic file-format and size validation details; not a malware scan.';

create index idx_user_files_user_created
  on public.user_files (user_id, created_at desc);
create index idx_user_files_user_status
  on public.user_files (user_id, status, updated_at);
create index idx_user_files_user_sha256
  on public.user_files (user_id, sha256);
create index idx_user_files_expiry
  on public.user_files (expires_at)
  where expires_at is not null and status <> 'deleted';

alter table public.agent_sessions
  add constraint agent_sessions_user_id_id_unique unique (user_id, id);
alter table public.agent_messages
  add constraint agent_messages_id_session_id_unique unique (id, session_id);

create table public.message_attachments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  file_id uuid not null,
  session_id uuid not null,
  message_id uuid,
  turn_id uuid,
  channel text not null
    check (channel in ('web', 'telegram', 'email', 'api', 'system')),
  role text not null check (role in ('input', 'output')),
  ordinal integer not null default 0 check (ordinal >= 0),
  metadata_jsonb jsonb not null default '{}'::jsonb,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint message_attachments_file_owner_fk
    foreign key (user_id, file_id)
    references public.user_files(user_id, id) on delete cascade,
  constraint message_attachments_session_owner_fk
    foreign key (user_id, session_id)
    references public.agent_sessions(user_id, id) on delete cascade,
  constraint message_attachments_message_session_fk
    foreign key (message_id, session_id)
    references public.agent_messages(id, session_id) on delete cascade,
  constraint message_attachments_message_or_turn
    check (message_id is not null or turn_id is not null)
);

comment on table public.message_attachments is
  'Channel-neutral associations between tenant files and an agent message and/or turn.';

create index idx_message_attachments_user_session
  on public.message_attachments (user_id, session_id, created_at);
create index idx_message_attachments_message
  on public.message_attachments (message_id, ordinal)
  where message_id is not null;
create index idx_message_attachments_turn
  on public.message_attachments (session_id, turn_id, ordinal)
  where turn_id is not null;
create index idx_message_attachments_file
  on public.message_attachments (user_id, file_id);

alter table public.user_files enable row level security;
alter table public.message_attachments enable row level security;

create policy "Users read own file metadata"
  on public.user_files for select
  using (auth.uid() = user_id);

create policy "Service role manages file metadata"
  on public.user_files for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create policy "Users read own message attachments"
  on public.message_attachments for select
  using (auth.uid() = user_id);

create policy "Service role manages message attachments"
  on public.message_attachments for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create or replace function public.generic_attachments_set_updated_at()
returns trigger
language plpgsql
as $fn$
begin
  new.updated_at = now();
  return new;
end;
$fn$;

create trigger trg_user_files_updated_at
  before update on public.user_files
  for each row execute function public.generic_attachments_set_updated_at();

create trigger trg_message_attachments_updated_at
  before update on public.message_attachments
  for each row execute function public.generic_attachments_set_updated_at();

insert into storage.buckets (id, name, public, file_size_limit)
values ('user-files', 'user-files', false, 26214400)
on conflict (id) do update
set public = false, file_size_limit = excluded.file_size_limit;

create policy "Users read own user files"
  on storage.objects for select
  using (
    bucket_id = 'user-files'
    and (storage.foldername(name))[1] = 'users'
    and auth.uid()::text = (storage.foldername(name))[2]
  );

create policy "Users upload own user files"
  on storage.objects for insert
  with check (
    bucket_id = 'user-files'
    and (storage.foldername(name))[1] = 'users'
    and auth.uid()::text = (storage.foldername(name))[2]
  );

create policy "Users update own user files"
  on storage.objects for update
  using (
    bucket_id = 'user-files'
    and (storage.foldername(name))[1] = 'users'
    and auth.uid()::text = (storage.foldername(name))[2]
  )
  with check (
    bucket_id = 'user-files'
    and (storage.foldername(name))[1] = 'users'
    and auth.uid()::text = (storage.foldername(name))[2]
  );

create policy "Users delete own user files"
  on storage.objects for delete
  using (
    bucket_id = 'user-files'
    and (storage.foldername(name))[1] = 'users'
    and auth.uid()::text = (storage.foldername(name))[2]
  );

create policy "Service role manages user file objects"
  on storage.objects for all
  using (bucket_id = 'user-files' and auth.role() = 'service_role')
  with check (bucket_id = 'user-files' and auth.role() = 'service_role');
