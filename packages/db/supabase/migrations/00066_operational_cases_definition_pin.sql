-- Slice 1.1 (flexible-workflows plan): pin every case to a definition version
-- and backfill global v1 definitions generated from the live global flows via
-- the production transformer (packages/workflows transformFlowToGraph; graphs
-- and hashes produced by scripts/generate-workflow-definition-seeds.ts).
-- Pinning is inert until the transition evaluator reads it (Slice 1.4).

alter table public.operational_cases
  add column workflow_definition_id uuid references public.workflow_definitions(id),
  add column workflow_definition_version integer;

create index operational_cases_workflow_definition_idx
  on public.operational_cases (workflow_definition_id)
  where workflow_definition_id is not null;

-- Global v1: property_optioning. Divergence decisions D1-D6 (§X.1) are
-- encoded explicitly: property_data_review + published promoted to first-class
-- states; awaiting_documents guard ported as-is (D4 fix deferred to v2);
-- comparables advance requires defensible_comparables_sample (>= 3 unique).
insert into public.workflow_definitions (
  owner_scope, user_id, case_type, workflow_key, version, status,
  industry, domain_tags, graph_jsonb, definition_hash,
  visibility, published_at, provenance_jsonb
)
values (
  'global', null, 'property_optioning', 'property_optioning', 1, 'published',
  'real_estate', array['real_estate', 'property_optioning'],
  '{"states":[{"key":"intake","label":"Completar registro del caso","kind":"operational"},{"key":"awaiting_documents","label":"Reunir documentos","kind":"operational"},{"key":"documents_received","label":"Extraer características","kind":"operational"},{"key":"property_data_review","label":"Revisión de datos de la propiedad","kind":"operational"},{"key":"comparables_in_progress","label":"Análisis de comparables","kind":"operational"},{"key":"price_proposal_pending","label":"Preparar precio","kind":"operational"},{"key":"contract_pending","label":"Preparar contrato","kind":"operational"},{"key":"photos_requested","label":"Solicitar fotos","kind":"operational"},{"key":"package_ready","label":"Gestionar publicación","kind":"operational"},{"key":"published","label":"Publicado","kind":"terminal"}],"transitions":[{"from":"intake","to":"awaiting_documents","guards":[],"authorized_proposers":["model","decision_handler","runtime"],"approval_required":null},{"from":"awaiting_documents","to":"documents_received","guards":["external_response_exists"],"authorized_proposers":["model","decision_handler","runtime"],"approval_required":null},{"from":"documents_received","to":"property_data_review","guards":[],"authorized_proposers":["model","decision_handler","runtime"],"approval_required":null},{"from":"property_data_review","to":"comparables_in_progress","guards":[],"authorized_proposers":["model","decision_handler","runtime"],"approval_required":null},{"from":"comparables_in_progress","to":"price_proposal_pending","guards":["defensible_comparables_sample"],"authorized_proposers":["model","decision_handler","runtime"],"approval_required":null},{"from":"price_proposal_pending","to":"contract_pending","guards":[],"authorized_proposers":["model","decision_handler","runtime"],"approval_required":null},{"from":"contract_pending","to":"photos_requested","guards":[],"authorized_proposers":["model","decision_handler","runtime"],"approval_required":null},{"from":"photos_requested","to":"package_ready","guards":[],"authorized_proposers":["model","decision_handler","runtime"],"approval_required":null},{"from":"package_ready","to":"published","guards":["completion_pairing"],"authorized_proposers":["model","decision_handler","runtime"],"approval_required":null},{"from":"documents_received","to":"comparables_in_progress","guards":[],"authorized_proposers":["model","decision_handler","runtime"],"approval_required":null}],"step_bindings":[{"state":"intake","skill":null},{"state":"awaiting_documents","skill":"request-property-documents"},{"state":"documents_received","skill":"extract-property-characteristics"},{"state":"comparables_in_progress","skill":"perform-comparable-analysis","bigquery_context":true},{"state":"price_proposal_pending","skill":"prepare-listing-price"},{"state":"contract_pending","skill":"prepare-commission-contract"},{"state":"photos_requested","skill":"request-property-photos"},{"state":"package_ready","skill":"publish-listing-package"}],"work_templates":[],"postconditions":[{"state":"package_ready","checks":["publication_preflight"]}],"approvals":[{"kind":"price","evidence_inputs":["comparables_analysis","pricing_proposal"]}],"impact_dependencies":{"valuation":["property.search_zone","property.operation","property.property_type","property.area_construida_m2","property.area_total_m2","comparable_set","methodology"],"listing_description":["property.bedrooms","property.bathrooms","property.parking_spots","property.neighborhood"]},"completion":{"terminal_states":["published"],"required_evidence":[]}}'::jsonb,
  'sha256:5aa637bc263fea0d24de372b9a396fb74fc236e743148391f6c40df88536c4b2',
  'shared_template', now(),
  '{"source": "transform-flow v1", "generated_by": "scripts/generate-workflow-definition-seeds.ts", "migration": "00066"}'::jsonb
)
on conflict (case_type, version)
  where user_id is null and owner_scope = 'global'
  do nothing;

-- Global v1: lead_follow_up (single-state flow; terminal at intake).
insert into public.workflow_definitions (
  owner_scope, user_id, case_type, workflow_key, version, status,
  industry, domain_tags, graph_jsonb, definition_hash,
  visibility, published_at, provenance_jsonb
)
values (
  'global', null, 'lead_follow_up', 'lead_follow_up', 1, 'published',
  'real_estate', array['real_estate', 'lead_follow_up'],
  '{"states":[{"key":"intake","label":"Captura del lead","kind":"terminal"}],"transitions":[],"step_bindings":[{"state":"intake","skill":"lead-follow-up-draft"}],"work_templates":[],"postconditions":[],"approvals":[],"impact_dependencies":{},"completion":{"terminal_states":["intake"],"required_evidence":[]}}'::jsonb,
  'sha256:6e565b2484f901fa23c5ec9496410c83a05edc7f14dde586060f6b7860c17e56',
  'shared_template', now(),
  '{"source": "transform-flow v1", "generated_by": "scripts/generate-workflow-definition-seeds.ts", "migration": "00066"}'::jsonb
)
on conflict (case_type, version)
  where user_id is null and owner_scope = 'global'
  do nothing;

-- Backfill: pin every unpinned case to the global v1 for its case type.
-- Cases whose case_type has no global definition (private user-authored
-- types) stay unpinned; the advisory evaluator skips unpinned cases.
update public.operational_cases oc
set
  workflow_definition_id = wd.id,
  workflow_definition_version = wd.version
from public.workflow_definitions wd
where oc.workflow_definition_id is null
  and wd.owner_scope = 'global'
  and wd.user_id is null
  and wd.status = 'published'
  and wd.version = 1
  and wd.case_type = oc.case_type;
