-- ============================================================
-- 00049_external_contact_link_tokens.sql
--
-- Tokens de vinculación de contacto externo (dueño/propietario) a un caso
-- operativo vía deep link de Telegram (/start ec_<token>). Permiten que, en un
-- caso Real, el asesor elija "externo" sin tener aún un contacto verificado: se
-- genera un enlace que reenvía al contacto; al abrirlo, el bot captura su
-- chat_id y queda verificado en el caso.
-- ============================================================

create table if not exists public.external_contact_link_tokens (
  id uuid primary key default uuid_generate_v4(),
  case_id uuid not null references public.operational_cases(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  token text not null unique,
  expires_at timestamptz not null,
  used boolean not null default false,
  verified_chat_id bigint,
  created_at timestamptz not null default now(),
  verified_at timestamptz
);

comment on table public.external_contact_link_tokens is
  'Tokens de vinculación de contacto externo a un caso operativo vía deep link de Telegram (/start ec_<token>).';

create index if not exists external_contact_link_tokens_token_idx
  on public.external_contact_link_tokens (token)
  where used = false;

create index if not exists external_contact_link_tokens_case_idx
  on public.external_contact_link_tokens (case_id, created_at desc);

alter table public.external_contact_link_tokens enable row level security;

create policy "Users view own external contact link tokens"
  on public.external_contact_link_tokens for select
  using (auth.uid() = user_id);

create policy "Service role full access to external contact link tokens"
  on public.external_contact_link_tokens for all
  using (auth.role() = 'service_role');
