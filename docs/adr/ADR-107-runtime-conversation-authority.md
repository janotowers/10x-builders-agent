# ADR-107 — Runtime, conversation and approval authority during brownfield migration

**Status:** Accepted direction  
**Date:** 2026-08-26  
**Related:** [`../product/initiatives/relationship-operations/architecture-analysis.md`](../product/initiatives/relationship-operations/architecture-analysis.md), [`../product/initiatives/relationship-operations/specs/lead-opportunity-lifecycle.md`](../product/initiatives/relationship-operations/specs/lead-opportunity-lifecycle.md), [ADR-106 — Organization-native multi-seat tenancy and legacy identity bridge](ADR-106-organization-native-multiseat-tenancy.md)

## Context

R1 Relationship Operations evolves a live Traditional Gu production system rather than replacing it in one step. During migration, Gu OS may hold a durable Lead Opportunity Case while Traditional Gu still performs existing follow-up behavior or transport functions. Human advisors may also take over a WhatsApp conversation while Gu OS continues to own and monitor the broader Opportunity.

Without explicit authority boundaries, Legacy and Gu OS could independently decide prospect-facing work, Gu could speak over a human advisor, or the use of a Traditional Gu transport endpoint could be confused with Traditional Gu retaining decision authority.

The existing outbound WhatsApp service demonstrates a brownfield transport seam, but its exact authentication, idempotency, provider-evidence and writeback behavior still requires source audit.

## Decision

1. R1 keeps four authority concepts separate:
   - **durable responsibility** — whether Gu OS owns the Lead Opportunity responsibility;
   - **runtime decision authority** — which system may autonomously decide the governed relationship work;
   - **conversation authority** — who currently has the conversational lead in a specific thread/channel;
   - **business approval authority** — who may approve a protected/consequential decision.
2. During brownfield migration, runtime decision authority is conceptually `LEGACY | GU_OS`. This identifies **decision authority**, not the physical transport/service that executes an effect.
3. **Case existence does not transfer authority.** A Gu OS shadow Case may exist while runtime authority remains Legacy.
4. For the same governed scope of autonomous relationship work, Legacy and Gu OS must not independently decide prospect-facing actions concurrently. If conflicting authority is detected, fail safe by suppressing the new external effect and surfacing/reconciling the conflict.
5. Observable human same-thread intervention may set conversation authority to `human_active`. Gu stops speaking in that governed conversation but may continue observing, updating facts, reasoning, monitoring and preparing non-conflicting work. Human takeover does not automatically pause the Case or transfer durable responsibility.
6. Conversation resumption is governed and observable. The current legacy inactivity timeout is not a Gu OS architecture invariant.
7. Immediately before a consequential prospect-facing effect, deterministic execution must revalidate current runtime authority, conversation authority, applicable delivery/engagement policy and materially relevant fresh state.
8. External conversation binding is a generic Gu OS concept. It supports organization, Case, channel/provider, opaque external conversation reference, participant/contact identity, Gu channel identity and provenance. Legacy `lead_id` may be an external reference; it is not the Gu OS conversation identity.
9. The existing Traditional Gu outbound WhatsApp service is the preferred initial **transport seam** when its source-audited contract satisfies or can be wrapped to satisfy authorization, tenant/channel consistency, idempotency, provider evidence, timeout/unknown-outcome, logging/writeback and stage/production requirements.
10. The model receives bounded business capabilities (for example, a `send_prospect_message`-style capability), not unrestricted raw HTTP or direct authority to construct low-level legacy endpoint tuples.

## Consequences

- Traditional Gu may remain a transport/operational adapter after Gu OS receives runtime decision authority.
- A human advisor can own the current conversation while Gu OS remains responsible for the Opportunity.
- Prospect-facing Work Items may become blocked/reconsidered after proposal if authority changes before execution.
- Off-thread/personal advisor activity can remain an evidence gap; absence of an observed human message is not proof that no human interaction occurred.
- Exact authority-state schema, takeover/resume signals, inactivity defaults, webhook behavior and endpoint mechanics belong to source audit / Technical Plan.
- Operational telemetry must make it possible to reconstruct which Opportunity, Organization, authority state, Work Item/Attempt, policy/approval and external/provider message reference produced a prospect-facing effect.

## Reevaluate when

- Traditional Gu no longer participates in R1 execution and the `LEGACY | GU_OS` migration dimension can be retired.
- A channel requires a richer authority model than `gu | human_active`.
- Multi-agent or multi-channel execution creates overlapping autonomous scopes that require more explicit authority leases.
- Provider/legacy behavior cannot support safe pre-effect revalidation or idempotent/reconcilable delivery through the current transport seam.
