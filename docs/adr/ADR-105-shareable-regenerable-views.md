# ADR-105 — Shareable regenerable views

**Status:** Accepted direction  
**Date:** 2026-08-02  
**Related:** [`../manuals/gu-os-flexible-workflows-technical-plan.md`](../manuals/gu-os-flexible-workflows-technical-plan.md) §11 / §16.1, [`../manuals/knowledge-scope-and-ownership.md`](../manuals/knowledge-scope-and-ownership.md) §7

## Context

Artifacts such as valuations, reports, manuals, dashboards, maps, and calculators may need to be shared with internal users or external participants. Treating each share as a copied document creates stale duplicates. Treating generated UIs as a second source of truth creates approval and audit drift.

## Decision

1. Share an **authorized view** over case/artifact/Brain truth; do not duplicate ownership by default.
2. Internal users: authenticated deep links + session RBAC/membership.
3. External participants: signed, expiring, revocable, tenant+case-scoped URLs; read-only by default.
4. HITL/business decisions remain on the canonical approval/inbox path; a view complements chat and does not become a second approval surface.
5. Taxonomize outputs:

| Class | Rule |
| --- | --- |
| Case/knowledge artifact | Durable, versioned, input-hashed, provenance-bearing |
| Generated view | Projection; never a second SOR |
| Executable artifact | Generated code/spec with tests, promotion, rollback |
| Situational software | Narrow UI/tool may be regenerated; data/rules/permissions remain durable |
| Turn artifact | TTL + provenance; not durable Brain |

A calculator over a registered formula is a view. Generated code that embeds the business formula is an executable artifact.

## Consequences

- Channel-linked views stay deferred until activation criteria in the workflows plan are met.
- Revocation removes access without mutating the underlying artifact.
- Cheap code generation does not make auth, finance, legal, audit, or workflow-engine logic disposable.

## Reevaluate when

- External participants need constrained write/actions inside a shared view.
- A brokerage requires organization-owned artifact libraries with team grants.
- Situational software needs a managed lifecycle beyond disposable regeneration.
