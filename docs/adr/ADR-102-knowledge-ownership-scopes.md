# ADR-102 — Knowledge ownership scopes

**Status:** Accepted direction  
**Date:** 2026-08-02  
**Related:** [`../manuals/knowledge-scope-and-ownership.md`](../manuals/knowledge-scope-and-ownership.md), [`../brain/gbrain-evaluation-and-plan.md`](../brain/gbrain-evaluation-and-plan.md) §1.5.9

## Context

Gu OS already uses several “scope” words: Skill `scope: business|personal|shared`, workflow `owner_scope`, and catalog `industry`. Collapsing them causes incorrect assumptions about public access, org sharing, and retrieval.

## Decision

Introduce an explicit knowledge ownership dimension:

```text
platform | industry | organization | team | user
```

Rules:

- Skill `scope` remains work-type metadata, not an ACL.
- Workflow `owner_scope` remains definition ownership.
- `industry` / `domain_tags` remain catalog filters unless also used as knowledge ownership.
- Tenant-owned knowledge never becomes readable across tenants through grants.
- Authorization filters before ranking; retrieval preserves provenance and scope.
- Configurable guidance may prefer narrower scopes; factual/legal authority follows provenance, not mere specificity.

`team` is a generic collaboration grouping (functional area, branch, region, pod, project), not a fixed department enum.

## Consequences

- Platform/industry semantic knowledge can be curated centrally and read by applicable tenants.
- Organization/team knowledge waits on V3 memberships and grants.
- Docs and UI must stop saying “shared” when they mean “organization-owned” or “platform-curated”.

## Reevaluate when

- A real multi-team brokerage needs nested teams or grant inheritance.
- Platform/industry catalogs need distinct tables rather than constrained Brain rows.
- Cross-organization collaboration (e.g. co-brokerage) requires a controlled shared surface without collapsing tenants.
