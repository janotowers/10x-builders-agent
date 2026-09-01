# ADR-106 — Organization-native multi-seat tenancy and legacy identity bridge

**Status:** Accepted direction  
**Date:** 2026-08-26  
**Supersedes:** [ADR-101 — Organization tenancy](ADR-101-organization-tenancy.md)  
**Related:** [`../manuals/knowledge-scope-and-ownership.md`](../manuals/knowledge-scope-and-ownership.md), [`../product/initiatives/relationship-operations/architecture-analysis.md`](../product/initiatives/relationship-operations/architecture-analysis.md), [`../product/initiatives/relationship-operations/technical-plan.md`](../product/initiatives/relationship-operations/technical-plan.md), [`../product/initiatives/relationship-operations/specs/lead-opportunity-lifecycle.md`](../product/initiatives/relationship-operations/specs/lead-opportunity-lifecycle.md)

## Context

ADR-101 established the correct target direction: organization as the future isolation boundary, user as runtime identity, and membership/role/team/assignment/DRI as separate concepts. It intentionally retained `user_id` as the current effective tenant boundary until multi-seat brokerage collaboration became a near-term requirement.

That reevaluation trigger has occurred in R1 Relationship Operations. R1 requires multiple authenticated advisors to operate organization-owned Lead Opportunities with safe assignment, visibility, routing and approval semantics.

The Traditional Gu legacy model does not expose a separate canonical Organization entity. Its `organization_id` is a legacy organization/account key anchored to the principal `super-admin`; `org_name` is display data; and `super-admin`, `admin` and `vendedor` are legacy role/membership semantics. The principal/Gu-owner context is not necessarily the current assigned advisor or DRI.

Gu OS must therefore become organization-native without turning these legacy identifiers into permanent Gu OS identities or rewriting all current user-scoped runtime storage in one big-bang migration.

## Decision

1. **Organization is the canonical target tenant and business owner** for new R1 organization-owned durable work. User is the authenticated human actor.
2. **Membership is first-class.** Membership, role/permission grant, assignment, DRI, approver and contact/routing endpoint remain separate concepts.
3. **Legacy identifiers are bridged, not promoted.** Legacy `organization_id`, user `document_id`, Legacy Lead `lead_id`, Gu phone/channel identifiers and provider IDs remain source-scoped external identities mapped to Gu OS canonical entities.
4. The legacy role bridge is transitional:
   - `super-admin` → principal owner/admin membership;
   - `admin` → organization-admin membership;
   - `vendedor` → advisor/sales membership.
   These mappings do not define the permanent Gu OS authorization vocabulary.
5. `profiles.is_ungga_admin` remains platform-staff authority and is never inferred from brokerage roles.
6. **Organization ownership is independent of assignment.** Reassigning an Opportunity does not move its tenant/business ownership. The principal/owner represented in legacy context must not be assumed to be the assigned advisor/DRI.
7. **Migration is staged.** R1 makes the Case/Work/Fact/Approval/Work Portfolio surfaces that require multi-seat collaboration organization-aware first. Existing `user_id` fields may remain for current tenancy compatibility, actor/provenance or backward compatibility, but an existing tenancy `user_id` must not be silently reinterpreted as actor identity.
8. The conceptual Membership model permits a user to belong to multiple organizations with an explicit organization context, even if the first R1 UI/pilot exposes only one.

## Consequences

- R1 needs a minimum canonical Organization + Membership + legacy identity bridge before the full multi-advisor pilot.
- Organization-aware authorization and explicit cross-tenant denial tests are required for the R1 organization-owned surfaces.
- Broader organization ownership for Brain, skills, workflow definitions and other assets may migrate incrementally; it is not a prerequisite for the minimum R1 slice.
- Legacy `organization_id` remains useful for brownfield mapping and current warehouse scoping but is not the Gu OS Organization primary key.
- A Prospect/Contact, Legacy Lead and Lead Opportunity remain distinct identities; `lead_id` is an opaque external Legacy Lead/context identifier.
- Exact tables, columns, RLS policies, claims, role enums, backfill mechanics and identity-mapping schema belong to the Technical Plan.

## Reevaluate when

- A required existing Gu OS primitive cannot be made organization-aware without a broader tenancy migration.
- Multi-organization switching requires product semantics beyond an active organization context.
- Traditional Gu replaces its legacy account model with a stable first-class organization/membership API that changes the bridge assumptions.
- Cross-tenant collaboration is proposed; tenant-owned data must not be shared merely by extending membership grants across organizations.
