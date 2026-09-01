-- ============================================================
-- grants.sql — TEST ONLY, applied AFTER the migration chain.
--
-- Supabase grants table privileges to anon/authenticated/service_role out of
-- the box. Without them every query in this suite would be refused for lack of
-- a GRANT rather than by row-level security, and every negative assertion would
-- pass for the wrong reason. These grants exist so that a denial in the suite
-- means RLS actually denied it.
--
-- Deliberately NO blanket `grant execute on all functions`: that would silently
-- undo the explicit EXECUTE revokes on bootstrap_organization (00082) and
-- is_active_org_member (00080), which this suite asserts.
-- ============================================================

grant select, insert, update, delete on all tables in schema public to anon, authenticated;
grant all on all tables in schema public to service_role;

grant usage, select on all sequences in schema public to anon, authenticated, service_role;

grant select, insert, update, delete on storage.objects to anon, authenticated, service_role;
grant select on storage.buckets to anon, authenticated, service_role;
