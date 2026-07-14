# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Chat-first conversational copy (pre-E2E)**: intake, document checklist,
  interno/externo, «listo», characteristics minimums, contract commercial
  prompts, photos request, and related acks no longer mention the panel; copy
  is channel-neutral (“aquí” / chat). Boleta registral is listed first as
  `(indispensable)` in checklist metadata/skill (gates unchanged). Contract
  commercial questions reorder to email → duration → exclusivity → owner % →
  share; examples stay percentage-only.
- **Ungga commission persistence**: CLI confirms Operación with the purple
  check (palomita), read-only re-verifies commission (no rewrite on re-open),
  and attempts save-as-draft + reread before `publish_draft`.

### Fixed

- **Commercial exclusivity polarity**: phrases like `No es en exclusiva` and
  `sin exclusiva` no longer flip to `exclusive: true`. Hybrid merge only lets
  the deterministic parser override the LLM when polarity is explicit; the
  capture ack echoes Con/Sin exclusiva before generating the contract draft.
- **E2E publication remote wait resume**: controlled/lab cases no longer stall after
  EasyBroker `images_submitted` with `remote_count=0`. The lab observer wakes the
  serialized publication runner from `nextPublicationAction` (including
  `wait_remote_media` / `validate` / `publish`), respecting resume leases. Cron
  suppression for E2E stays intact. `process_media` success no longer resets an
  already-verified remote poll; waiting-remote ticks surface
  `e2e_waiting_remote_media` instead of looking finished.
- **Ungga deterministic publish + safe closure**: `nextPublicationAction` no longer
  discards Ungga `draft_in_flight` / `publish_in_flight` idles into
  `all_destinations_resolved`. Nested runner ticks use structural
  `publicationRunnerOwned` (preserve lease; no recursive follow-up). Completion
  requires published evidence (`published_url` for Ungga; not GU-ID alone; not
  EasyBroker-imported Ungga IDs). Ungga CLI edits/verifies **Comisión (%)** via
  the Operación pencil modal; prepare/publish fail if the expected % does not
  persist. Premature closures can be reopened with
  `reopenPrematurelyClosedPublicationCase` and a single corrective summary.
  Corrective `listing_published_summary` reuses the active unread notification
  (upsert) so the unique `(user, case, kind)` index does not block Telegram
  redelivery with the Ungga URL.
- **Deterministic EasyBroker watermark before upload**: `easybroker_upload_images`
  now prepares media itself. If a brand watermark asset exists and
  `photo_manifest.watermarked_path` is missing, it applies/persists watermark
  before any EasyBroker HTTP call; if no asset exists, it uploads originals and
  never blocks. Agent-invented `upload_path` values are ignored in favor of the
  manifest. Pre-remote watermark failures return `side_effect_started:false` and
  are safe to force-retry in the publication ledger.
- **Destination owner commission mapping**: EasyBroker create now projects
  `commission_terms.commission_pct` into `operations[].commission`
  (`{ type: "percentage", value }`) so the UI shows e.g. “50% de 5%” instead of
  a bare shared percent. Ungga CLI fills **Comisión (%)** via the Operación
  pencil modal (tarjeta → lápiz → COMISIÓN) from the same canonical field and
  verifies persistence before treating prepare/publish as success;
  collaborator share % remains EasyBroker-only
  (`shared_commission_percentage` 50|null) and is not sent to Ungga.
- **Watermark + Ungga sequencing**: watermark is required only when the account has a brand asset (`watermark_configured`); missing logo no longer blocks preflight/upload. `image_watermark` persists `photo_manifest.watermarked_path` via OCC retries and fails loudly on persist/`partial_failure`. Package-ready prompts follow a single runner action (no same-tick “ask Ungga”). `ungga_publish_approval` waits for EasyBroker publicly published (or skipped/rejected), not merely a draft `listing_id`. Publication write tools now audit as `approved` (not `pending_confirmation`) when the graph already auto-executes them, so a slow Ungga CLI run no longer looks like a second human decision. The publication runner treats genuine technical HITL as `waiting_hitl` instead of marking the destination `failed`. Ungga CLI/agent now map internal enums (`good`→`Bueno`, `existing`→`Habitable`, `MX`→`México`, etc.), enrich `land_m2` from `property_data.area_total_m2`, and abort early on GENERAL validation so a failed draft does not look like a stuck HITL while MEDIA never mounts.
- **Ungga direct publish (CLI-only)**: with publication workflow v1, suppress per-destination Ungga draft/publish Telegram pings (final `listing_published_summary` owns closure). Validate/publish no longer open `review_required` solely for `ungga_api_credentials_missing` when GU-ID + CLI-verified media exist; post-publish confirmation trusts CLI `published_url`/`ok`. Media counts accept `remote >= expected` (extra Ungga thumbs). Reconcile skips API-missing without marking the destination unknown. When the runner reaches `all_destinations_resolved`, it closes `package_ready` → `published`/`completed` and sends `listing_published_summary` once.
- **Publication `process_media` race**: nested agent ticks no longer fire a second `requestPublicationProgress` while the outer runner is still looping; nested ticks preserve the processing lease (`next_action_at`); the runner aborts if it cannot persist `publication_runner_pending_action` before tools; `markCaseProcessing` refuses to steal an active future lease; lab GET observers skip wake while a lease is held. Prevents false `publication_execution_result_missing` failures when EasyBroker draft creation succeeds but image upload never runs.

### Added

- **Lab E2E: closed cases in observation selector**: completed/failed conversational cases appear under «Cerrados (solo lectura)» so you can audit events/history after the run finishes. Auto-pin still prefers active cases; Revisar avance / Abandonar stay disabled for closed cases, with a link to `/operational-cases?case=…`.
- **Publication workflow hardening**: serialized `publication-runner` with `publication_operations` ledger (migration `00063`), conditional preflight, API-backed reconcile, remote EasyBroker/Ungga snapshots, rollout modes `off|shadow|active` (default **off**), and business decisions for destination approval and conditional publication review
- **Neutral commercial terms** (`commission_terms` / `collaboration.enabled` tri-state): deterministic evaluator, dynamic `contract_data_review` HITL (web + Telegram, partial capture), preventive preflight before contract generation, and destination mappers (EasyBroker/Ungga) that warn on incompatible detail without mutating canonical data
- **Photo manifest by identity**: shared path/sha256 helpers, per-file classification with bounded concurrency, identity-safe EasyBroker upload pairs, watermark/URL merge 1:1 with `raw_photos`
- **Residential minimums**: `parking_spaces` for casa/residencia in property data review (missing-only; zero valid)
- Regression scripts: `npm run test:publication-workflow` (web), `npm run test:contract-commercial-terms` and `npm run test:photo-manifest` (agent), `npm run test:contract-commercial-extraction` (web hybrid HITL extractor)

### Changed

- **HITL Telegram (cron)**: one message per pending tool approval (approve/reject + optional «Ver detalle» URL button); removed both the duplicate plain-text follow-up and the raw URL repeated in the message body. Advisor notice is sent in the same tick that creates `pending_confirmation`, not only on the next cron skip.
- **Operational-case cron HITL policy**: case bookkeeping (`update_intake`, `update_state`, `add_event`, document reads) auto-executes behind adapter ownership/version/transition guards; external side effects and commercial decisions retain HITL. Internal document collection is event-driven (`next_action_at=null`) until upload/«listo», preventing repeated requests and fresh technical approvals. The cron defensive `+5min` re-arm no longer overrides that wait.
- **Contract draft generation failures**: orphan `pending_confirmation` audit rows left by auto-execute + storage errors no longer surface as «HITL pendiente». Cloudflare/storage 502s are classified as infrastructure errors with a clear retry message.
- **Package-ready E2E publication gate**: controlled `property_optioning` cases normalize `publication_mode=active`. Before description approval, the tick stays on photo/copy preparation; afterward the serialized runner owns `off|shadow|active`. Publication writes default to `deny` and auto-execute only when destination approval, machine phase and pending runner action match, eliminating premature technical HITL.
- **Publication-review activity**: package-ready now records the prepared listing draft under its authoritative step and always emits an explicit «Esperando aprobación o cambios de la descripción» event, including when the agent already created the Telegram/Pendientes notification.
- **Listing-review copy**: commercial descriptions no longer expose internal caveats such as features not being visible in photos. Missing data and visual coverage are consolidated into one clearly optional future-improvements note that is not a requirement and does not request another photo upload during text review.
- **Contract draft Telegram delivery**: `contract_review` keeps the download link/buttons and also attaches the DOCX via `sendDocument` (best-effort).
- **Contract download filenames**: generic titles like «Casa» compose `property_type` + operación + colonia (e.g. `contrato-comision-casa-venta-las-fuentes-…`) instead of a bare type token.
- **Tool readiness**: `operational_case_update_intake` is classified `internal_platform` (like `update_state`) and `easybroker_publish_listing` is registered with its existing real adapter/account provider. This removes the spurious «1 pendientes técnicos» that blocked E2E «Revisar avance». A consistency selftest now checks every readiness-visible `property-optioning-coach` tool against catalog + adapter registration, and the UI summary names any future blocker directly.
- **Commission contract placeholders**: added `commission_pct_words`, `duration_months_words`, `operation_type` / `operation_contract_type`, and `contract_day` / `contract_month` / `contract_year` (generation date as signing date, using profile timezone). Exclusivity clause remains template-fixed for now.
- **`generate_document_from_template` empty optionals**: preprocess strips `""`/`null` optional args (e.g. `asset_key: ""`) before Zod so model retries after contract-data capture do not fail with schema validation_error
- **Contract data review hybrid capture**: free-text Telegram/Pendientes replies use LLM + Zod + deterministic fallback (`contract-commercial-extraction`); typed buttons/forms still bypass the LLM; partial captures keep HITL open without rescheduling the agent; emails strip trailing punctuation; owner commission vs shared collaborator percent are disambiguated with human-readable labels (no raw enums); E2E tick emits the same structured `missing_fields`/`known_fields` summary as generate-owned remediation
- **Contract data review UX**: initial/partial copy asks for missing commercial fields without empty “Datos conocidos”; Telegram omits ambiguous Sí/No when multiple fields are pending (contextual buttons only for a single required boolean); E2E lab shows contractual preflight as “Bloqueada — requiere datos contractuales” instead of a hard failure
- **Comparable search hardening**: property-data review shows parking spaces (incl. `0`); EasyBroker MLS canonicalizes types (`house`→`Casa`); `easybroker_search_closed_deals` applies/verifies `Estatus=Solo cerradas` with fail-safe empty results; fallback ladder reports honest `filters_used`/`search_attempts` (exhausted → last attempt); docs/skills align with asymmetric area band 146→124–270, automatic comparable sample (HITL remains `price_approval`), and defendible-sample gate (`unique_comparable_count >= 3`, not merely `usable_count > 0`)
- **EasyBroker MLS status trace**: `result.filters[]` status token is derived from the final verified `status_filter` (post URL-sync), so `status:Solo cerradas` no longer lags as stale `status:unverified`
- Publication side effects require explicit `publication_mode` (or account equivalent); implicit default-on removed
- `contract_data_review` generalized beyond owner email only; dedupe by ordered missing-field set
- Ungga timeout/kill propagates to `unknown_outcome` without auto-retry of `prepare_draft`
- **Ungga direct publish reliability**: `prepare_draft` only succeeds with GU-ID + `draft_url` and verified photo count; CLI uploads `image_urls` in MEDIA, splits total/nav/action/upload timeouts, replaces mandatory post-save `networkidle`, and surfaces last-step diagnostics in publication review HITL. Adapter/runner/preflight reject incomplete media and avoid the Ungga `process_media` dead-end.

- **Alma efectiva (`soul_effective`)**: reviewer LLM compila voz/tono/estilo/brevedad en un resumen coherente con defaults; el compiler lo inyecta en cada prompt; preview en Settings → Perfil del agente → Alma
- **Telegram webhook idempotency**: tabla `telegram_webhook_updates` (migration `00052`) evita procesar dos veces el mismo `update_id` / respuestas duplicadas
- **Cron hardening**: `SCHEDULED_TASKS_CONCURRENCY` (default 5) en `POST /api/cron/scheduled-tasks`; runbook con stagger recomendado para `scheduled-tasks`, `operational-cases` y `heartbeat`
- Business decision **comparables search expansion**: `POST /api/business-decisions/comparables-expansion-decision`, handler compartido, acciones inline en Pendientes y callbacks Telegram
- Informative **Contraste Avaclick** line in canonical price approval message (`formatPricingProposalForApproval`); **Advertencia** reserved for `source_conflict` ≥30%
- Deterministic document-flow reminder events (`recordDocumentFlowReminder`) for post-intake checklist and interno/externo routing
- External contact linking for Real operational cases: `external_contact_link_tokens` table (migration `00049`), Telegram deep link `/start ec_<token>`, advisor setup message when choosing «externo» without verified contact; reuses existing external responder pipeline after verification
- Shared document collection protocol (`case-document-collection.ts`): canonical checklist, per-type ack hints, media-group consolidated acks with optional kind detail, upload side-text detection
- Telegram media-group ack batching (`telegram-media-group-ack-store.ts`) for internal document uploads
- E2E/Real routing isolation helpers (`e2e-lab-routing-isolation.ts`) and routable binding resolution (`resolveRoutableConversationBindings`) with ignored-binding reasons for observability
- Consolidated skill validation script (`scripts/validate-skills.mjs`) and slimmed skill-authoring reference docs
- Configurable engagement policy overrides per account: `engagement_policy_overrides_jsonb` on `user_notification_preferences` (migration `00036_notification_engagement_policy_overrides.sql`), UI in Plantillas de flujos, API `GET/POST /api/notification-preferences`; delivery windows by weekday/time/timezone with cron deferral outside allowed hours
- Telegram HITL reminders keep actionable Approve/Cancel buttons via `pending_tool_call_id`; stale `tool_confirmation_pending` notifications auto-resolve when the underlying tool call is no longer pending
- Telegram multi-case clarification with numbered list selection; explicit new-case intent (`forceNew`) when user asks to open another property case
- Comparables integration issue detection (`integration_issues`, `needs_user_reauth` in `data_quality`); bounded EasyBroker MLS session retry (`EASYBROKER_MLS_MAX_ATTEMPTS`) before `needs_manual_login`
- Dedicated **Pendientes** inbox at `/chat/pending`: grouped reminders, due/escalation badges, inline business decisions, HITL tool cards, auto-sync, and bandeja cleanup (`DELETE` scopes `resolved-history`, `settings-test`, `stuck-case`)
- `tool_confirmation_pending` internal notification kind with engagement policy (4h cooldown, 3 reminders, 24h escalation) when operational-case cron skips `runAgent` while tool HITL is blocking
- Business decision **property data review**: `POST /api/business-decisions/property-data-review`, shared handler, web inline actions and Telegram confirm/correct callbacks
- `pending-action-registry` mapping resolvable notification kinds to inline inbox actions
- Persistent internal notifications (`internal_user_notifications`) and external contact tracking (`external_contact_notifications`); migrations `00035_persistent_notifications.sql`, `00036_waiting_internal_status.sql`
- Web inbox **Pendientes** in chat (`/api/notifications`, `chat-interface.tsx`) for unread internal action items
- Business HITL for price approval: `POST /api/business-decisions/price-approval`, shared handler in `apps/web/src/lib/business-decisions/price-approval.ts`, Telegram inline buttons (`Aprobar precio`, `Ajustar y aprobar`) and text parser for structured adjustments
- Operational case status `waiting_internal` (distinct from `waiting_external`) for cases blocked on internal user input
- Skill test framework enhancements: semantic artifact validation, expected tool calls/events, deterministic repair for `prepare-listing-price`, clearer settings UI feedback (source tools vs internal actions, artifact preview)
- `bigquery_lookup_local_comparables` tool and skill-test auto-approve for low-risk internal writes during settings test runs
- EasyBroker MLS search tools (`easybroker_search_listings`, `easybroker_search_closed_deals`) via Playwright POC `pocs/easybroker-mls-cli` and per-account provider `easybroker_web`
- EasyBroker MLS search filters for "minimum" room counts (`min_bedrooms`, `min_bathrooms`, `min_parking_spaces`) and `shared_commission_only`
- Real `image_watermark` adapter using account watermark assets and Sharp-generated watermarked outputs
- Tool test UX: declarative test assets for `image_watermark`, signed URL previews of watermarked outputs, and `Probar tool` alongside resource management when a tool is ready
- Declarative tool asset profiles for readiness tests, including multi-file temporary asset collections (e.g. up to 30 EasyBroker upload photos)
- EasyBroker write adapters for `easybroker_create_listing` and `easybroker_upload_images`, including not-published creation, signed URL image payloads, and isolated upload test assets
- Controlled real EasyBroker create-listing test from tool readiness settings, guarded by explicit confirmation and forced `[PRUEBA - BORRAR]` / `not_published` safeguards
- Operational case tool testing: sample context (`test-context-samples.ts`), `run-tool` with `case_id`, readable result preview in settings UI
- `npm run setup:pocs` to install Playwright dependencies for EasyBroker MLS and Ungga POCs
- Long-term memory (v1): `memory_injection_node`, `match_memories` RPC, `flushSessionMemory`, chat/Telegram triggers; `memory.log` and `turn_summary.log` (see [docs/memory/long_term_memory_plan.md](docs/memory/long_term_memory_plan.md))
- Initial project setup with Turborepo monorepo structure
- Workspace configuration for `apps/*` and `packages/*`
- Build, dev, lint, and type-check scripts
- Project documentation (`README.md`, `docs/plan.md`)
- MIT License

### Changed

- **Company-data / BigQuery**: autofill de `@params` (`start_date`/`end_date`), reintentos OAuth en el adapter, guard en el grafo que bloquea respuestas numéricas sin `bigquery_run_query` exitoso, saneo de historial con fallos BQ previos; skill `company-data` reforzada (sin SQL en chat, KPI escalar sin tablas)
- **Chat web — panel de herramientas**: `/api/chat` y `/api/chat/confirm` devuelven `tool_calls` completos; tarjetas compactas con «Ver detalle técnico» expandible; sin duplicados por stubs optimistas; `read_skill_reference` y `bigquery_run_query` sin resumen redundante en éxito
- **Type-check web**: script `next typegen && tsc --noEmit` regenera tipos de rutas antes de chequear (evita artefactos `.next/dev/types` truncados tras crash de dev)
- E2E activity projection (`flowProgressForE2ESummary`) keys document reminders off `payload.purpose` (projected as `event_purpose`), not `payload.kind`; pre-transition `document_request_target_inferred` events are preserved too, so Paso 1 shows checklist/internal-routing activity that already existed in the audit trail
- Idempotent address consolidation (`mergeDocumentAddressIntoContextPropertyData`): existing `address_conflicts` no longer re-trigger `changed`; re-running with identical inputs yields no writes/events. Consolidation event emits only when a visible address field is adopted; new conflicts emit a dedicated `document_address_conflict_detected` event (visible in panel) instead of a generic «Dirección consolidada»
- Telegram document target choice (interno/externo) in the external-responder path now routes through the shared `applyDocumentRequestTargetChoice` handler, closing the audit-trail gap (records `recordDocumentFlowReminder`) and using the canonical ack — full parity with web and the conversational path
- E2E activity log preserves pre-transition document reminder events; idempotent legal-identity consolidation avoids duplicate «Titularidad consolidada» entries
- `detectSourceConflict` compares implied subject total (market p50 × m²) vs Avaclick average instead of median total of larger comparables
- Telegram outbound reliability: IPv4-first DNS (`instrumentation.ts`) and retries on connect timeout in `send-message.ts`
- Conversational property optioning (Telegram + web): intake data on a single active incomplete intake case continues that case instead of spurious multi-case clarification; explicit «otra propiedad» or post-intake start phrases still clarify or force new case
- Post-intake message combines property confirmation, document checklist, privacy line, and interno/externo choice via `buildPostIntakeDocumentRequestMessage`
- Document uploads from the advisor before choosing `document_request_target` infer `internal_user` (`decided_by=inferred`) and use unified batch acks instead of repeating interno/externo per file
- Deterministic `documents_received` tick bypasses duplicate LLM `property_data_review` notifications; `notify_user` guardrail skips duplicate review when step or recent events indicate one was already sent
- Owner characteristics extraction merges deterministic parser backfill with LLM patches for priority fields (`floors`, `bedrooms`, etc.)
- Settings lab: separate E2E lab configuration from observed-case panel; case selector tags `[Real]` / `[E2E activo|pausado|abandonado]`; guide for starting a clean E2E run
- Operational-cases cron: when a case has pending tool confirmations, skip `runAgent`, set `next_action_at = null`, upsert `tool_confirmation_pending`; resume case after approve/reject via `finalizeCaseAfterToolDecision`
- Resolving internal notifications cascades closure of linked reminder rows; engagement policies extended with `maxReminderAttempts`, `escalateAfterHours`, and escalation priority
- `notify_user`: always persists web notifications in `internal_user_notifications`; Telegram delivery for `price_approval` includes actionable inline keyboard; default `due_at = now + 4h` for `price_approval` when caller omits it
- Price approval semantics: **Ajustar y aprobar** applies user-provided amounts, marks `pricing_proposal` approved, actioned notification, and advances case to `contract_pending` (no second approval step)
- Internal notification reminders in operational-cases cron: `price_approval` cooldown **4h** (other internal kinds remain **24h**); external contact reminders stay **24h**
- Documentation: operational-cases architecture (pending inbox, HITL cron anti-spam, cleanup scopes, property_data_review), HITL doc § casos operativos con tool pendiente, business-brain roadmap V1.7 progress
- Documentation for operational cases, architecture manual, and POC index aligned with EasyBroker MLS and dual providers (`easybroker` vs `easybroker_web`)
- EasyBroker MLS session handling now falls back from expired `storage-state.json` to email/password login before requiring assisted login
- Default `MEMORY_MATCH_THRESHOLD` for long-term retrieval: **0.50** (was 0.35). Migration [00008_match_memories_default_threshold_050.sql](packages/db/supabase/migrations/00008_match_memories_default_threshold_050.sql) sets the same default on `public.match_memories` in the database; the app still passes the threshold explicitly from code/env.
- [docs/plan.md](docs/plan.md): Fase 8 now documents long-term memory as implemented (v1), not only planned
