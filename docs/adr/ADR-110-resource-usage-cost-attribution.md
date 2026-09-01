# ADR-110 — Resource Usage & Cost Attribution

**Status:** Accepted direction  
**Date:** 2026-08-27  
**Related:** [`../product/initiatives/relationship-operations/architecture-analysis.md`](../product/initiatives/relationship-operations/architecture-analysis.md), [`../product/initiatives/relationship-operations/technical-plan.md`](../product/initiatives/relationship-operations/technical-plan.md), [`../product/initiatives/relationship-operations/r1-concept-shared-kernel-mapping.md`](../product/initiatives/relationship-operations/r1-concept-shared-kernel-mapping.md), [ADR-108 — Versioned organization policy](ADR-108-versioned-organization-policy.md), [ADR-109 — Generic Case relationships and lineage](ADR-109-generic-case-relationships-lineage.md)


## Context

Gu OS already records AI-model usage through `ai_usage_events`. That existing seam establishes several valuable design properties: append-oriented usage evidence, provider/model identification, token quantities, reported versus estimated cost, versioned pricing, retry cost, and correlation to durable operating objects such as Cases, Work Items and Attempts. It is explicitly internal economic observability rather than customer billing.

Relationship Operations broadens the economic problem. A Case may consume not only model tokens, but also messaging-provider usage, voice minutes, document processing, geocoding/search, specialist-provider calls and other variable resources. The same need will recur across Property, Demand, Transaction, Network and future operating domains.

A Relationship-specific cost table would duplicate infrastructure and make cross-domain unit economics inconsistent. At the same time, simply broadening `ai_usage_events` without a clear contract risks collapsing four distinct concerns: what resource was consumed, what that usage cost Ungga, which business work caused or benefited from the cost, and what Ungga chooses to charge the customer.

The architecture therefore needs one cross-domain economic-observability contract that preserves causal traceability and reconciliability without pretending that every shared cost has precise per-Case ownership.

## Decision

1. Gu OS adopts a **generic cross-domain resource-usage and cost-attribution contract**. Relationship Operations specializes business semantics and correlations but does not create Relationship-only economic ledgers.

2. Keep four concerns distinct:

   ```text
   resource usage
       ≠ cost valuation
       ≠ causal attribution / shared allocation
       ≠ customer pricing / credits / billing
   ```

   Usage records consumption. Cost valuation records Ungga's economic input under a pricing basis. Attribution/allocation explains causal economic ownership. Billing monetizes customer value under a separate pricing contract.

3. **Durable resource usage evidence is append-oriented and auditable.** A later provider-reported or reconciled valuation must not erase the fact that the usage occurred or the historical valuation basis used when the event was first observed.

4. Cost valuation may mature over time. The architecture must support the conceptual distinction between estimated, provider-reported and later reconciled values, together with the pricing version/basis used. Exact table and correction mechanics belong in Technical Design.

5. Prefer **direct causal attribution** when the consuming activity is known. A resource event may correlate to Organization, Case, Work Item, Attempt, Work Run or other governed durable roots as appropriate.

6. **Correlation/lineage is not repeated economic allocation.** If one event is correlated to an Organization, Case, Work Item and Attempt, those are roll-up dimensions over one underlying cost, not four separately chargeable costs.

7. Shared cost allocation is permitted only when direct causal attribution is not defensible and an explicit, documented and versioned allocation driver exists. Candidate drivers may include attributable tokens/context, messages, pages, minutes, API calls, properties, Opportunities processed or another causally defensible unit.

8. If no defensible driver exists, retain the amount as **shared/platform/unallocated cost**. Do not fabricate per-Case precision merely to complete a dashboard or unit-economics view.

9. Economic roll-ups must remain reconcilable to the underlying resource evidence:

   ```text
   total recorded resource cost
   = directly attributed cost
   + allocated shared cost
   + explicit shared/unallocated cost
   ```

   Different analytical groupings may roll up the same underlying event, but must not double count it.

10. **Retries, failures and reconciliation are cost-bearing usage.** Economic observability must not hide consumed resources simply because the associated Work Item ultimately failed, retried or required repair.

11. Cost-to-Serve may be analyzed against business activities and outcomes, but the economic ledger does **not** become the source of truth for those activities or outcomes. Activity taxonomy and outcome semantics come from governed Case / Work / capability / domain contracts and are referenced by economic telemetry.

12. Economic telemetry should use **minimal, allowlisted, non-content metadata**. It should capture resource identity, quantity, causal correlation, provider/pricing basis and cost-relevant status without copying prompts, prospect messages, documents, transcripts or other business content merely for accounting.

13. `ai_usage_events` is a proven narrow implementation of this direction and should be **evolved/extended rather than conceptually discarded**. It may remain a specialized source, become a compatibility view, or migrate into the generic contract. Exact migration and dual-write strategy belong in Technical Design.

14. Customer subscriptions, credits, wallet balance, outcome pricing and billing remain a **separate contract**. They may consume Cost-to-Serve and outcome telemetry, but customer price is not derived 1:1 from provider/resource cost. Provider-pricing versions and future customer-pricing/credit-policy versions remain independently attributable.

## Consequences

- Gu OS can compute comparable Cost-to-Serve across operating domains without creating domain-specific cost databases.
- Resource consumption can be analyzed at Organization, Case, Work, Attempt, Work Run, capability/activity and outcome levels while preserving one underlying economic event.
- Provider cost changes, retries and later reconciliation remain visible rather than being silently overwritten.
- Unit economics can distinguish productive execution cost from retry/failure/reconciliation cost.
- Shared or batch work can be allocated when a defensible driver exists while preserving honest unallocated cost when it does not.
- Analytics and internal economic dashboards must operate as projections over the ledger rather than introducing a second cost source of truth.
- Customer monetization may evolve independently from internal cost accounting, supporting credits, subscriptions, outcome pricing or other models without corrupting Cost-to-Serve.
- Technical Design must define the resource taxonomy, quantity/unit contracts, valuation representation, correlation model, allocation records/policy, uniqueness/idempotency, organization authorization, reconciliation process and migration path from `ai_usage_events`.

## Invariants

- Recorded usage is not silently deleted or rewritten to manufacture a cleaner economic history.
- A single resource event is counted once in any reconciled economic total.
- Correlation does not imply multiple allocations.
- Shared allocation requires an explicit defensible driver and versioned basis.
- Unknown/unallocatable cost remains visible as shared/unallocated.
- Economic metadata does not become an uncontrolled content mirror.
- The economic ledger does not own Case/Work business outcome truth.
- Internal Cost-to-Serve does not determine customer price by identity.

## Reevaluate when

- Provider invoices or credits require a materially different accounting model that cannot be reconciled to resource usage events.
- Resource consumption becomes predominantly fixed/contractual rather than usage-based and needs an explicit overhead/capacity-allocation model.
- Cross-organization/network work introduces economic ownership or revenue-sharing semantics that are not representable as ordinary resource-cost allocation.
- Customer billing requires accounting-grade financial ledger guarantees beyond the scope of operational economic telemetry; that should create or extend the separate Billing/Pricing contract rather than weakening this boundary.
