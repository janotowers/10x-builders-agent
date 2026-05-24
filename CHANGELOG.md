# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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

- `notify_user`: always persists web notifications in `internal_user_notifications`; Telegram delivery for `price_approval` includes actionable inline keyboard; default `due_at = now + 4h` for `price_approval` when caller omits it
- Price approval semantics: **Ajustar y aprobar** applies user-provided amounts, marks `pricing_proposal` approved, actioned notification, and advances case to `contract_pending` (no second approval step)
- Internal notification reminders in operational-cases cron: `price_approval` cooldown **4h** (other internal kinds remain **24h**); external contact reminders stay **24h**
- Documentation: operational-cases architecture (persistent notifications + business HITL), business-brain roadmap V1.7 progress, HITL doc clarifies tool vs business HITL
- Documentation for operational cases, architecture manual, and POC index aligned with EasyBroker MLS and dual providers (`easybroker` vs `easybroker_web`)
- EasyBroker MLS session handling now falls back from expired `storage-state.json` to email/password login before requiring assisted login
- Default `MEMORY_MATCH_THRESHOLD` for long-term retrieval: **0.50** (was 0.35). Migration [00008_match_memories_default_threshold_050.sql](packages/db/supabase/migrations/00008_match_memories_default_threshold_050.sql) sets the same default on `public.match_memories` in the database; the app still passes the threshold explicitly from code/env.
- [docs/plan.md](docs/plan.md): Fase 8 now documents long-term memory as implemented (v1), not only planned
