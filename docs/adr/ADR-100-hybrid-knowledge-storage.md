# ADR-100 — Hybrid knowledge storage

**Status:** Accepted direction  
**Date:** 2026-08-02  
**Related:** [`../README.md`](../README.md), [`../brain/gbrain-evaluation-and-plan.md`](../brain/gbrain-evaluation-and-plan.md) §1.5.8, [`../manuals/architecture-manual.md`](../manuals/architecture-manual.md) §14

## Context

Gu OS must store enterprise knowledge for many tenants: original documents, parsed text, search indexes, compiled entity knowledge, and procedures. Personal second-brain patterns often use Markdown files or Obsidian vaults as the system of record. That works for one person; it does not solve multi-tenant ACL, RLS, concurrency, operational queries, provenance, or retention.

## Decision

Use a hybrid storage model:

| Plane | Source of truth |
| --- | --- |
| Original evidence bytes | Private object storage or the authoritative external system |
| Parsed text / Markdown | Regenerable derived representation linked by hash/`source_id` |
| Chunks, full-text, embeddings | Postgres |
| Compiled Brain knowledge | Postgres (`brain_*` when implemented) |
| Procedures | Skills / workflow definitions |
| Transactional business rows | Declared external warehouse/CRM (e.g. BigQuery) |

Markdown remains valuable for authoring, agent readability, diffs, Git review of platform/industry knowledge, and import/export. It is not the universal SOR.

## Consequences

- “Postgres is SOR for Brain” means compiled knowledge, not every PDF/audio/email blob.
- Ingestion must preserve immutable originals and treat Markdown/text as derived.
- Export to Markdown/Obsidian-compatible vaults is a portability surface, not authorization.
- Hybrid retrieval (keyword + vector + graph signals) operates over indexed/compiled knowledge, not by reading whole vaults into context.

## Reevaluate when

- A tenant requires offline local vault sync as a primary product surface.
- Object storage or Postgres cost/scale forces a different partition.
- Platform/industry authoring proves that Git-only Markdown is insufficient without a sync catalog.
