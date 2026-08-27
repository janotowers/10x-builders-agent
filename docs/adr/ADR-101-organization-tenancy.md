# ADR-101 — Organization tenancy

**Status:** Superseded  
**Date:** 2026-08-02  
**Superseded by:** [ADR-106 — Organization-native multi-seat tenancy and legacy identity bridge](ADR-106-organization-native-multiseat-tenancy.md)  
**Related:** [`../manuals/knowledge-scope-and-ownership.md`](../manuals/knowledge-scope-and-ownership.md), [`../business-brain-evolution-roadmap.md`](../business-brain-evolution-roadmap.md) V3, [`../manuals/architecture-manual.md`](../manuals/architecture-manual.md) §3

## Context

Today Gu OS isolates agent data by `user_id` + RLS. Business organization identity comes from the external operating system (`org_id` / `organization_id`, `org_name`, `role_user`), bound manually into `business_brain`. That is enough for one principal account per brokerage, but it does not model multi-seat membership, teams, or organization-owned knowledge.

## Decision

1. **Current runtime:** keep `user_id` as the effective tenant boundary.
2. **Target:** make the organization the isolation boundary, with the user as runtime identity.
3. Preserve the external brokerage key:

```text
organizations.external_org_id <- external org_id
organizations.name            <- external org_name
membership.role=owner/admin   <- role_user=super-admin
membership.role=sales_agent   <- role_user=vendedor
```

4. Separate membership, role, team, assignment, and DRI. Do not treat `super-admin` as the organization itself.
5. Keep `profiles.is_ungga_admin` as platform-staff authority, never inferred from external brokerage roles.
6. Leads remain organization-owned; assignee is a separate relationship. External intake/assignment may remain SOR until an explicit migration.

## Consequences

- Brain MVP may stay user-scoped until organizations/memberships exist.
- Organization-owned skills, assets, workflows, and Brain pages require org-aware RLS and backfill tests.
- Sharing artifacts uses org membership/RBAC internally and signed scoped links externally; sharing never crosses tenants.

## Reevaluate when

- Multi-seat brokerage collaboration becomes a near-term product requirement.
- A user must operate multiple organizations from one Gu account.
- The external system exposes `organization_id` directly on leads and memberships in a stable API.
