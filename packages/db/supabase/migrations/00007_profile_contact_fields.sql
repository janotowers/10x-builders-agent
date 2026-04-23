-- ============================================================
-- Añade email y phone al perfil canónico del usuario.
--
-- Estos campos son "configuración/identidad estable" (no un hecho
-- aprendido), así que viven en `profiles` — no en `memories`.
-- El prompt de extracción de memoria larga sigue prohibiendo extraer
-- email/teléfono PROPIOS del usuario (para que no se dupliquen),
-- pero permite emails/teléfonos de TERCEROS (contactos de negocio).
--
-- Nullable a propósito: usuarios existentes no rompen; el agente
-- simplemente no los inyecta al prompt si están vacíos.
-- ============================================================

alter table public.profiles
  add column if not exists email text,
  add column if not exists phone text;

-- Índices opcionales (comentados): si en el futuro buscas por email/phone
-- exacto (p. ej. deduplicación), descomenta.
-- create index if not exists profiles_email_idx on public.profiles (email);
-- create index if not exists profiles_phone_idx on public.profiles (phone);
