# ADR-103 — Hybrid retrieval and generated indexes

**Status:** Accepted direction  
**Date:** 2026-08-02  
**Related:** [`../brain/gbrain-evaluation-and-plan.md`](../brain/gbrain-evaluation-and-plan.md) Bloque 3 / 3b, [`ADR-100-hybrid-knowledge-storage.md`](ADR-100-hybrid-knowledge-storage.md)

## Context

Personal LLM-wiki patterns sometimes reject vector RAG and rely on reading an `INDEX.md` plus a few Markdown articles. That can work for tens of articles. Gu OS must serve many organizations, large corpora, ACL filtering, entity graphs, and operational queries.

## Decision

1. Use **hybrid retrieval**: keyword/full-text + embeddings + fusion (e.g. RRF), with graph/backlink boosts where available.
2. Prefer retrieving **compiled truth and evidence-linked chunks**, not only raw fragments.
3. Generate **hierarchical indexes** (organization, industry, entity kind, team, period) as agent-readable complements — not a single global `INDEX.md` as the only entry point.
4. Reject index-only / “read the whole wiki” as the product retrieval architecture for multi-tenant Gu OS.
5. Keep synthesis tools (`think_brain` when implemented) grounded: cite retrieved pages/chunks and report gaps.

## Consequences

- Brain Block 3 hybrid search remains required before broad Brain injection.
- Personal `match_memories` stays for user memory; Brain search is a separate authorized path.
- Graph visualization is optional UX, not a quality metric or primary navigation model.
- Cost controls (chunk caps, reembed-on-hash-change, daily limits) are part of the design.

## Reevaluate when

- Eval evidence shows index-first navigation outperforms hybrid for a bounded corpus class.
- Embedding/index cost dominates without measurable outcome gains.
- A dedicated graph database becomes necessary for traversal scale.
