# ADR-108 — Versioned organization policy

**Status:** Accepted direction  
**Date:** 2026-08-27  
**Related:** [`../product/initiatives/relationship-operations/architecture-analysis.md`](../product/initiatives/relationship-operations/architecture-analysis.md), [`../product/initiatives/relationship-operations/specs/lead-opportunity-lifecycle.md`](../product/initiatives/relationship-operations/specs/lead-opportunity-lifecycle.md), [ADR-106 — Organization-native multi-seat tenancy and legacy identity bridge](ADR-106-organization-native-multiseat-tenancy.md)

## Context

R1 Relationship Operations requires organization-configurable policy for decisions such as whether Gu may or should assume durable responsibility for a commercial situation. The approved behavioral sequence is:

```text
platform hard bounds
        ↓
organization policy
        ↓
Gu contextual judgment
```

Existing Gu OS engagement-preference seams demonstrate that policy resolution belongs in shared infrastructure, but the current user-level notification/engagement overrides are not a sufficient authoritative contract for organization-owned admission and future cross-domain policy.

Storing policy solely as prompt prose, Brain/knowledge content, workflow-definition data or Case context would blur authorization, knowledge, process and model judgment. Conversely, attempting to encode all business semantics in a deterministic policy DSL would move contextual judgment out of the model/Skill layer.

Gu OS therefore needs a reusable organization-policy contract whose governance is generic while policy semantics remain typed and domain-specific.

## Decision

1. Gu OS adopts a **generic, organization-owned, typed and versioned policy contract**. Individual policy purposes/domains retain their own semantics; there is no single unbounded organization-policy blob.
2. Keep these concepts separate: **platform hard bounds**, **organization policy**, **workflow**, **Skill/model judgment**, **knowledge/Brain**, and **prompt/context**.
3. **Natural language is an authoring interface, not runtime authority.** Model-assisted authoring may translate human intent into a structured proposal plus readable explanation, examples and edge cases.
4. Policy follows an explicit governed lifecycle such as draft → validate → authorized review → publish. **Published versions are immutable**; drafts do not affect production.
5. Model/Skill judgment may produce structured semantic interpretations with evidence references. Governed/deterministic policy resolution applies the published policy to those interpretations and enforces the resulting authority constraints.
6. Policy publication requires an authorized Organization Membership/role/grant. A model, advisor suggestion or generated draft cannot silently publish production policy.
7. Consequential policy-governed decisions/effects must record or be able to reconstruct the effective organization, policy purpose/type, published version and relevant decision/rule/evidence path.
8. Cases do **not** automatically pin every Organization Policy for their entire lifetime. Historical decisions remain attributable to the version that governed them; newly published policy normally governs future decisions from its effective point.
9. A new policy version does not silently rewrite historical Case truth or invalidate earlier decisions. Any retroactive reassessment/migration behavior must be explicit and governed for that policy type.
10. Missing, invalid or unresolved policy must never broaden authority. Exact safe fallback/default behavior is defined per policy/product increment, but additional autonomy fails closed.
11. User-level or narrower preferences may coexist and may further restrict or override a higher-level policy only where the higher-level contract explicitly allows that override. There is no universal `user > organization` precedence rule.
12. Policy examples/simulations may be retained as verification evidence. They support authoring/validation but are not necessarily the runtime policy representation.
13. Organization Policy remains organization-owned configuration/authority, not Case truth. Cases store/reference the policy version used by consequential decisions where required; policy rules are not cloned into every Case as source of truth.

## Consequences

- Relationship Admission can use a governed reusable policy lifecycle without creating Relationship-only policy infrastructure.
- Future domains can reuse the same publication/versioning/audit contract while defining their own typed semantics.
- Runtime behavior is stable against prompt drift because production authority comes from published structured policy.
- Contextual business meaning can remain model-mediated while authorization guarantees remain governed/deterministic.
- Product/UI can support conversational policy authoring without allowing conversation text to mutate production authority directly.
- Policy changes are auditable and forward-effective by default rather than silently retroactive.
- Technical Plan must define exact storage/schema, policy-type registry, resolver API/result contract, authorization/RLS, validation, version activation, decision correlation and safe defaults.
- Existing engagement preference infrastructure may remain; it should be integrated through explicit precedence/override contracts rather than repurposed as the universal organization-policy store.

## Reevaluate when

- Policy purposes become sufficiently heterogeneous that one generic lifecycle no longer provides meaningful shared guarantees.
- A required policy type needs long-running procedural state and should instead be represented partly as a Workflow/Case contract.
- Runtime evaluation requires a richer rule language; any DSL must preserve the model-judgment/deterministic-enforcement boundary rather than attempting to encode all business semantics.
- Organization policy must be shared/delegated across tenants, which would require a separate explicit product/security model rather than weakening tenant isolation.
