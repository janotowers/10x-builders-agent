# ADR-109 — Generic Case relationships and lineage

**Status:** Accepted direction  
**Date:** 2026-08-27  
**Related:** [`../product/initiatives/relationship-operations/architecture-analysis.md`](../product/initiatives/relationship-operations/architecture-analysis.md), [`../product/initiatives/relationship-operations/technical-plan.md`](../product/initiatives/relationship-operations/technical-plan.md), [`../product/initiatives/relationship-operations/specs/lead-opportunity-lifecycle.md`](../product/initiatives/relationship-operations/specs/lead-opportunity-lifecycle.md), [`../operational-cases/architecture.md`](../operational-cases/architecture.md), [ADR-106 — Organization-native multi-seat tenancy and legacy identity bridge](ADR-106-organization-native-multiseat-tenancy.md), [ADR-107 — Runtime, conversation and approval authority during brownfield migration](ADR-107-runtime-conversation-authority.md)

## Context

R1 Relationship Operations requires durable relationships between Operational Cases. A Lead Opportunity may be associated with a later Transaction Case without ceasing to exist; duplicate Opportunities may need canonicalization; and future domains may require merge, split, supersession or other lineage semantics between durable responsibilities.

A full-repository audit of `janotowers/10x-builders-agent` on `main` found no adequate first-class generic Case-to-Case relationship or lineage primitive. `operational_cases` has no reference to another Case, and the shared TypeScript/query contract exposes no Case relationship API. Existing structures demonstrate that Gu OS already models important relationships explicitly when their semantics matter: conversation-to-Case bindings are first-class, workflow-definition forks retain explicit lineage, Work Items have explicit dependency edges, and Facts/Approvals retain explicit supersession lineage.

Encoding Case relationships only in `operational_cases.context_jsonb`, event payloads, Relationship Operations-specific tables, Work dependencies or Fact lineage would therefore create a second, weaker relationship convention without shared referential integrity, governed semantics, reverse traversal, authorization rules or durable provenance.

Gu OS needs a shared cross-domain contract for relationships among durable Case responsibilities. That contract must distinguish ordinary business association from identity/history lineage and must not couple relationship creation to Case lifecycle or authority.

## Decision

1. **Gu OS adopts a generic, cross-domain Case Relationship / Lineage contract** for durable structural relationships between `operational_cases`. Relationship Operations must use this shared contract rather than introduce a domain-specific relationship store.

2. **Business association and lineage are distinct semantics.**
   - A **business association** means two independently durable responsibilities are meaningfully related, for example a Lead Opportunity associated with a Transaction Case.
   - **Lineage** means the identity/history of one Case structurally derives from, replaces, consolidates, splits from or otherwise continues another Case.
   The persistence design may share one primitive, but callers and policies must not treat these semantic classes as interchangeable.

3. Relationship semantics are **typed and governed**, not arbitrary free-text authority. Gu OS should support a deliberately small vocabulary or registry whose directionality, cardinality/invariants and lifecycle meaning are defined explicitly. Exact initial relationship types and representation belong to Technical Design / Specs.

4. **Relationships do not implicitly mutate either Case.** Creating, removing or changing a relationship does not by itself:
   - close, complete, fail, pause or reactivate a Case;
   - change progression or commercial viability;
   - transfer Organization ownership, assignment or DRI;
   - transfer runtime decision authority, conversation authority or business approval authority;
   - advance workflow state or create/cancel Work.
   Any such effect requires its own authorized canonical operation and evidence.

5. **Opportunity-to-Transaction association is non-destructive.** Associating a Lead Opportunity with a Transaction Case does not mean the Opportunity is closed, converted away or superseded. Relationship Operations may remain responsible for the broader relationship while Transaction Operations owns execution of the concrete deal.

6. **Reactivation normally preserves Case identity.** When the same durable business responsibility becomes active again, Gu OS should normally reactivate/reconsider the existing Case rather than create a new Case plus artificial lineage. New Cases are warranted when a genuinely distinct durable responsibility/lifecycle exists.

7. **Merge, duplicate, split and supersession semantics preserve history and provenance.**
   - Canonicalization/merge must not erase source Case history.
   - Split must preserve provenance from the originating Case while each resulting Case owns its own durable lifecycle.
   - Supersession/duplicate semantics must remain auditable rather than being represented by destructive reassignment or deletion.
   Exact survivor/canonicalization and reconciliation algorithms remain downstream design.

8. **Lineage mutations require governed authority and evidence.** The system must be able to reconstruct who/what established or changed a material lineage relationship, under which Organization/authority context, when, why, and from what evidence or authorized operation. Model inference alone cannot silently create identity-changing lineage.

9. **Relationships are Organization-contained by default.** Both endpoints must belong to an authorized compatible Organization scope under the organization-native tenancy model. Cross-organization Case relationships are not enabled by weakening tenant isolation; if future product requirements need them, they require an explicit separate collaboration/sharing model.

10. **A relationship does not grant visibility.** Authorization is evaluated independently for the Cases and relationship projection. Access to one Case must not automatically reveal protected metadata or existence of another Case outside the actor's authorized scope.

11. **The relationship primitive is the current structural source for Case-to-Case links; events provide audit history.** Relationship mutations may emit append-only events/evidence, but event payloads or `context_jsonb` are not the sole authoritative representation of the current relationship graph.

12. **Child/parent semantics are not a generic substitute for Work decomposition.** A subproblem becomes a child/related Case only when it acquires its own durable business responsibility and lifecycle. Ordinary branching, retries, evidence repair and execution dependencies remain in the Work Plane.

13. The shared contract must support reliable traversal and reconciliation of relevant relationships without conflating them with Work dependencies, workflow-definition lineage, Fact/Approval supersession or conversation bindings.

14. **Exact persistence and API mechanics are Technical Design.** Table shape, endpoint columns, relationship registry/enums, direction/symmetry representation, active/history mechanics, indexes, constraints, RLS, query APIs, idempotency keys, mutation events, migration/backfill and reconciliation procedures are intentionally not fixed by this ADR.

## Consequences

- Relationship Operations can associate Lead Opportunities with Transaction Cases without turning a CRM-style “conversion” into the lifecycle source of truth.
- Duplicate, merge, split and supersession behavior can evolve as Gu OS capabilities rather than Relationship-specific conventions.
- Future domains can reuse the same Case relationship contract while retaining domain-specific semantics and policies.
- Case graph traversal becomes explicitly governable and auditable instead of depending on JSON conventions or event reconstruction.
- Relationship existence cannot be used as an authorization shortcut or as an implicit authority/lifecycle transition.
- Merge/split implementations will require explicit reconciliation rules for Facts, Work, approvals, conversation bindings, assignments and other Case-owned state; those rules remain with their canonical subsystems rather than being hidden inside relationship creation.
- Technical Plan / implementation Specs must define the minimum R1 relationship vocabulary and persistence/query contract, including organization authorization and negative cross-tenant tests.
- The current absence of a generic primitive means R1 implementation must introduce or stage this shared capability before any feature depends on durable Case-to-Case semantics.

## Reevaluate when

- Case relationships become rich enough to require a graph/domain service with guarantees materially beyond the shared relational contract.
- Cross-organization collaboration becomes a product requirement and needs an explicit shared-Case or federated authorization model.
- A future Operational Case redesign changes the identity/lifecycle model such that merge, split or supersession semantics no longer fit this contract.
- One relationship class develops independent durable state, workflow and responsibility and should instead become its own first-class business entity or Case rather than an edge.
