-- ============================================================
-- platform-shim.sql — TEST ONLY. Never applied to a real environment.
--
-- Recreates the parts of the Supabase platform that the migration chain assumes
-- already exist, so the chain can be applied to a bare PostgreSQL instance and
-- its RLS policies can be exercised for real.
--
-- Covers exactly what the chain touches:
--   * roles anon / authenticated / service_role  (88 auth.role() + 92 auth.uid()
--     references across the chain);
--   * schema auth with users, uid(), role();
--   * schema storage with buckets, objects, foldername() (00012/00030/00037/
--     00075/00079).
--
-- Deliberately NOT granted BYPASSRLS to service_role: in production the service
-- role bypasses RLS, so exercising the service-role POLICIES here is strictly
-- stricter than production rather than weaker.
-- ============================================================

create extension if not exists "uuid-ossp";
create extension if not exists pgcrypto;
create extension if not exists vector;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit;
  end if;
end
$$;

-- ============================================================
-- auth
-- ============================================================
create schema if not exists auth;

create table if not exists auth.users (
  id          uuid primary key default gen_random_uuid(),
  email       text,
  created_at  timestamptz not null default now()
);

-- Mirrors Supabase: both read the request-scoped JWT claims GUC. Written
-- defensively so a missing or empty setting yields NULL rather than erroring.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'),
    ''
  )::uuid;
$$;

create or replace function auth.role()
returns text
language sql
stable
as $$
  select coalesce(
    nullif(
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'),
      ''
    ),
    'anon'
  );
$$;

-- ============================================================
-- storage
-- ============================================================
create schema if not exists storage;

create table if not exists storage.buckets (
  id                  text primary key,
  name                text not null,
  public              boolean not null default false,
  file_size_limit     bigint,
  allowed_mime_types  text[],
  created_at          timestamptz not null default now()
);

create table if not exists storage.objects (
  id          uuid primary key default gen_random_uuid(),
  bucket_id   text references storage.buckets(id),
  name        text,
  owner       uuid,
  metadata    jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table storage.objects enable row level security;

-- Supabase semantics: the path segments EXCLUDING the final filename.
create or replace function storage.foldername(name text)
returns text[]
language plpgsql
immutable
as $$
declare
  parts text[];
begin
  parts := string_to_array(name, '/');
  return parts[1:array_length(parts, 1) - 1];
end;
$$;

grant usage on schema public  to anon, authenticated, service_role;
grant usage on schema auth    to anon, authenticated, service_role;
grant usage on schema storage to anon, authenticated, service_role;
