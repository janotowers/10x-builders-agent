# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Long-term memory (v1): `memory_injection_node`, `match_memories` RPC, `flushSessionMemory`, chat/Telegram triggers; `memory.log` and `turn_summary.log` (see [docs/memory/long_term_memory_plan.md](docs/memory/long_term_memory_plan.md))
- Initial project setup with Turborepo monorepo structure
- Workspace configuration for `apps/*` and `packages/*`
- Build, dev, lint, and type-check scripts
- Project documentation (`README.md`, `docs/plan.md`)
- MIT License

### Changed

- Default `MEMORY_MATCH_THRESHOLD` for long-term retrieval: **0.50** (was 0.35). Migration [00008_match_memories_default_threshold_050.sql](packages/db/supabase/migrations/00008_match_memories_default_threshold_050.sql) sets the same default on `public.match_memories` in the database; the app still passes the threshold explicitly from code/env.
- [docs/plan.md](docs/plan.md): Fase 8 now documents long-term memory as implemented (v1), not only planned
