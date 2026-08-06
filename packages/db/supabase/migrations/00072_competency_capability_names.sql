-- ============================================================
-- 00072_competency_capability_names.sql
--
-- Ajuste de nomenclatura (2026-08-05, decisión de diseño): las
-- `required_capability` nombran la COMPETENCIA (qué se necesita), nunca el
-- mecanismo. El mecanismo (`execution_mode`) se lee del worker profile en
-- la selección del ejecutor; los prefijos `service:` / `agent:` dejan de
-- tener semántica de enrutado. La única convención que sobrevive sin perfil
-- es `human` / `human:*` (capabilities humanas abiertas; el match
-- perfil↔capability es por string exacto).
--
-- Sin usuarios reales en producción (solo el tenant de laboratorio):
-- rename limpio + data-fix de filas ya estampadas, sin ventana de alias.
-- Las definiciones publicadas con strings viejos se re-publican vía
-- apps/web/scripts/publish-property-optioning-v2.ts (el hash cambia; el
-- script re-apunta los casos activos a la versión nueva).
-- ============================================================

-- 1. Perfiles seed de 00071 → nombres de competencia.
update public.worker_profiles
  set capabilities = array['extraction_consolidation']
  where user_id is null and slug = 'extraction_consolidation';

update public.worker_profiles
  set capabilities = array['publication_reconciliation']
  where user_id is null and slug = 'publication_reconciliation';

update public.worker_profiles
  set capabilities = array['valuation_verification']
  where user_id is null and slug = 'valuation_verifier';

-- 2. Perfil para el soak sintético (scripts/work-plane-soak.ts): capability
-- propia en lugar del genérico "service" (que ya no enruta nada).
insert into public.worker_profiles
  (user_id, slug, capabilities, execution_mode, allowed_tools,
   allowed_data_scopes, model_policy_jsonb, verification_contract_jsonb,
   timeout_seconds, max_concurrency)
values
  (null, 'work_plane_synthetic', array['synthetic_work'],
   'deterministic_service', array[]::text[], array[]::text[],
   '{}'::jsonb, '{}'::jsonb, 60, 4)
on conflict (slug) where user_id is null do nothing;

-- 3. Data-fix de work items ya estampados con los strings viejos
-- (laboratorio; incluye items terminados para que el historial lea igual
-- que la convención nueva).
update public.work_items set required_capability = 'extraction_consolidation'
  where required_capability = 'service:extraction_consolidation';

update public.work_items set required_capability = 'publication_reconciliation'
  where required_capability = 'service:publication_reconciliation';

update public.work_items set required_capability = 'valuation_verification'
  where required_capability = 'agent:valuation_verifier';

update public.work_items set required_capability = 'synthetic_work'
  where required_capability = 'service';
