-- ============================================================
-- 00024_account_tool_secrets.sql
--
-- Credenciales y configuración por cuenta para herramientas que el producto
-- expone globalmente pero cuya conexión real es per-tenant (ej. EasyBroker,
-- Ungga, Tokko, Wiggot, HubSpot).
--
-- Modelo deliberadamente genérico: una sola tabla con clave única
-- (user_id, provider). Los campos sensibles se guardan ya cifrados en
-- `encrypted_secret_jsonb` usando AES-256-GCM con `ENCRYPTION_KEY`
-- (mismo helper que `user_integrations.encrypted_tokens`, ver
-- packages/db/src/crypto.ts). Lo no-sensible (mappings, defaults, IDs)
-- vive en `config_jsonb` sin cifrar para consultarse desde la UI.
--
-- Estados (`status`):
--   - pending_test: credencial guardada pero no se ha validado contra la API
--     externa todavía.
--   - active: la última validación fue exitosa.
--   - invalid: la última validación devolvió error (revisar `last_error`).
--   - disconnected: el usuario desconectó explícitamente.
--
-- No incluye soporte multi-account-por-provider en V1; se asume una
-- conexión por par (user_id, provider). Versionado, rotación automática y
-- multi-tenant compartido quedan para versiones posteriores.
-- ============================================================

create table public.account_tool_secrets (
  id                      uuid primary key default uuid_generate_v4(),
  user_id                 uuid not null references public.profiles(id) on delete cascade,
  provider                text not null,
  config_jsonb            jsonb not null default '{}'::jsonb,
  encrypted_secret_jsonb  text not null default '',
  status                  text not null default 'pending_test'
                            check (status in (
                              'pending_test',
                              'active',
                              'invalid',
                              'disconnected'
                            )),
  last_checked_at         timestamptz,
  last_used_at            timestamptz,
  last_error              text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (user_id, provider)
);

comment on table public.account_tool_secrets is
  'Credenciales y configuración por cuenta para tools cuya conexión depende del tenant (EasyBroker, Ungga, etc.). Sustituye env vars globales cuando hay registro per-user. config_jsonb no es sensible; encrypted_secret_jsonb se cifra con AES-256-GCM (ENCRYPTION_KEY).';

comment on column public.account_tool_secrets.encrypted_secret_jsonb is
  'JSON cifrado con AES-256-GCM (helper encryptToken). El JSON plano puede tener forma distinta por provider, ej. {"api_key":"..."} o {"api_base":"...","api_token":"..."}.';

comment on column public.account_tool_secrets.config_jsonb is
  'Config no sensible accesible desde la UI (mappings, defaults, IDs de catálogo, account_label).';

create index idx_account_tool_secrets_user
  on public.account_tool_secrets (user_id, status, updated_at desc);

create index idx_account_tool_secrets_provider
  on public.account_tool_secrets (provider, status);

alter table public.account_tool_secrets enable row level security;

-- Lectura/escritura por dueño de la cuenta (sin exponer secretos: la app
-- filtra qué columnas devolver al cliente; nunca se devuelve
-- encrypted_secret_jsonb desde el GET público).
create policy "Users manage own account tool secrets"
  on public.account_tool_secrets for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Service role full access to account_tool_secrets"
  on public.account_tool_secrets for all
  using (auth.role() = 'service_role');

-- Trigger para mantener updated_at consistente.
create or replace function public.account_tool_secrets_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger account_tool_secrets_set_updated_at
  before update on public.account_tool_secrets
  for each row execute function public.account_tool_secrets_set_updated_at();
