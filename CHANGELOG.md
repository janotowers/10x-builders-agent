# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- EasyBroker MLS search tools (`easybroker_search_listings`, `easybroker_search_closed_deals`) via Playwright POC `pocs/easybroker-mls-cli` and per-account provider `easybroker_web`
- EasyBroker MLS search filters for "minimum" room counts (`min_bedrooms`, `min_bathrooms`, `min_parking_spaces`) and `shared_commission_only`
- Real `image_watermark` adapter using account watermark assets and Sharp-generated watermarked outputs
- Tool test UX: declarative test assets for `image_watermark`, signed URL previews of watermarked outputs, and `Probar tool` alongside resource management when a tool is ready
- Operational case tool testing: sample context (`test-context-samples.ts`), `run-tool` with `case_id`, readable result preview in settings UI
- `npm run setup:pocs` to install Playwright dependencies for EasyBroker MLS and Ungga POCs
- Long-term memory (v1): `memory_injection_node`, `match_memories` RPC, `flushSessionMemory`, chat/Telegram triggers; `memory.log` and `turn_summary.log` (see [docs/memory/long_term_memory_plan.md](docs/memory/long_term_memory_plan.md))
- Initial project setup with Turborepo monorepo structure
- Workspace configuration for `apps/*` and `packages/*`
- Build, dev, lint, and type-check scripts
- Project documentation (`README.md`, `docs/plan.md`)
- MIT License

### Changed

- Documentation for operational cases, architecture manual, and POC index aligned with EasyBroker MLS and dual providers (`easybroker` vs `easybroker_web`)
- EasyBroker MLS session handling now falls back from expired `storage-state.json` to email/password login before requiring assisted login
- Default `MEMORY_MATCH_THRESHOLD` for long-term retrieval: **0.50** (was 0.35). Migration [00008_match_memories_default_threshold_050.sql](packages/db/supabase/migrations/00008_match_memories_default_threshold_050.sql) sets the same default on `public.match_memories` in the database; the app still passes the threshold explicitly from code/env.
- [docs/plan.md](docs/plan.md): Fase 8 now documents long-term memory as implemented (v1), not only planned
