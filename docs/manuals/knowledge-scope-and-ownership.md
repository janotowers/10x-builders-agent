# Knowledge scope and ownership in Gu OS

**Status:** canonical target semantics. Current runtime remains mostly `user_id`-scoped. R1 Relationship Operations includes the minimum organization/multi-seat slice required for its multi-advisor operating model; broader organization/team maturity remains evidence-gated beyond that slice.

This document is canonical for **who owns and may access knowledge**. It does not replace the DDL in the Brain or flexible-workflows plans.

## 1. Three dimensions that must not be collapsed

### Work scope

Skill frontmatter `scope: business | personal | shared` describes the type of work a skill supports. It is catalog/routing metadata, not an authorization grant.

### Knowledge ownership scope

`platform | industry | organization | team | user` describes ownership and visibility of knowledge.

### Workflow ownership

`workflow_definitions.owner_scope` describes ownership of a versioned workflow definition. `industry` and `domain_tags` remain catalog filters, not permissions.

## 2. Scope model

| Scope | Owner | Typical content | Read | Write |
| --- | --- | --- | --- | --- |
| `platform` | Gu OS | Product rules, general glossary, system playbooks | Applicable authenticated tenants | Curated platform role/service only |
| `industry` | Gu OS/curator | Real-estate concepts, regulation, stable domain references | Tenants enabled for that industry | Curated platform/industry role |
| `organization` | Inmobiliaria | Policies, zone dossiers, inventory guidance, organizational playbooks | Authorized organization members | Authorized org roles |
| `team` | Team inside an organization | Branch, legal, marketing, sales-pod or project knowledge | Team members plus explicit org grants | Team owners/authorized roles |
| `user` | Individual user | Private notes, personal facts and preferences | Owner, plus explicit safe service paths | Owner/authorized agent path |

`platform` and `industry` are shared read surfaces, not mutable cross-tenant memory. Tenant-owned rows never become visible to another tenant through a grant.

## 3. Tenant, membership, role, team, assignment, DRI

These concepts answer different questions:

- **Tenant/organization:** isolation boundary and business owner of data.
- **Membership:** user belongs to an organization.
- **Role:** capabilities within that organization.
- **Team:** grouping for collaboration and scoped knowledge.
- **Assignment:** responsibility for a lead/case/work item.
- **DRI:** human accountable for a defined outcome.

Target conceptual entities:

```text
organizations
organization_memberships
teams
team_memberships
roles / permission grants
```

Initial roles may include `owner`, `org_admin`, `sales_agent`, `legal_reviewer`, `marketing_member`, and `viewer`. Do not encode departments as roles or teams as a fixed enum.

Teams may represent:

- Functional areas: sales, marketing, legal, operations.
- Branches or regions.
- Sales pods or specializations.
- Temporary project/development teams.

Start with flat, many-to-many memberships. Add nested teams only after a real authorization or discovery need.

## 4. External identity bridge

The current Traditional Gu operating model exposes legacy organization/account semantics rather than a separate first-class Organization entity:

- `users.document_id` is the canonical legacy user identifier used by lead, appointment, property, deal and Gu-number references.
- `organization_id` is effectively a reference/key anchored to the principal `super-admin` user. Treat it as a **legacy organization key**, not as the permanent/canonical Gu OS organization identity.
- `org_name` is a mutable brokerage display name, not identity.
- `role_user='super-admin'` identifies the principal user representing the brokerage in the legacy model.
- `role_user='admin'` identifies a user granted account-administration authority by the principal user.
- `role_user='vendedor'` identifies an advisor/sales user to whom responsibility for selected leads can be delegated.
- There is no separate first-class Organization table in the current legacy model.

The target Gu OS model must bridge those legacy semantics into first-class organization, membership and role concepts without permanently equating an organization with one user. Conceptually:

```text
legacy organization key (`organization_id`) -> Gu OS organization identity bridge
legacy `super-admin`                       -> principal owner/admin membership
legacy `admin`                             -> organization-admin membership
legacy `vendedor`                          -> sales-agent membership
```

`profiles.is_ungga_admin` is platform staff authority and must never be inferred from those external roles.

Leads remain organization-owned even when the legacy system currently relates them through the receiving/principal `super-admin`. Gu OS should preserve the external lead identifier, legacy organization key, current assignee and source provenance while the external intake/assignment system remains authoritative, until an explicit migration changes that ownership contract.

R1 Relationship Operations requires the **minimum viable organization/multi-seat slice** needed to model multi-advisor responsibility, assignment, authority and access correctly. This does not imply that all broader organization/team administration must be completed in R1.

## 5. Retrieval and precedence

For a user turn, candidate knowledge is the authorized union:

```text
user + teams + organization + industry + platform
```

Retrieval must:

1. Filter authorization before ranking.
2. Preserve source scope and provenance in results.
3. Prefer more specific applicable policy where overrides are allowed.
4. Never let a local override silently contradict law, safety policy, or immutable platform constraints.
5. Surface conflicts instead of merging incompatible assertions into a single certainty.

Suggested precedence for configurable guidance:

```text
user > team > organization > industry > platform
```

This is not universal truth precedence. A verified fact or binding policy wins according to provenance/authority, not merely because it has a narrower scope.

## 6. Storage direction

- Platform/industry semantic knowledge may be authored as reviewed Markdown in Git and synchronized into a read-optimized Postgres knowledge catalog.
- Organization/team/user Brain knowledge uses Postgres as canonical compiled state with RLS/grants.
- Original source bytes stay in private object storage or the authoritative external system.
- Markdown export/import is supported as a portability surface, not an authorization mechanism.
- Skills remain separate from semantic knowledge: skills encode **how to act**; knowledge pages encode **what is known**.

Whether platform/industry pages use dedicated tables or a constrained `brain_pages` extension is an implementation decision for the Brain phase. The retrieval API should present one authorized interface either way.

## 7. Sharing artifacts and views

Sharing never changes tenant ownership.

### Internal

Authenticated deep links use session identity, organization membership, role, and optional team scope. Views may be interactive under role, while HITL decisions remain in the canonical approval path.

### External

Owner, buyer, notary, or collaborator links are signed, expiring, revocable, tenant+case scoped, and read-only by default. A response returns through an explicit external-response/HITL path.

Prefer sharing an authorized view over copying the artifact. Revocation must remove access without mutating the underlying artifact.

## 8. Migration sequence

1. Keep current `user_id`-scoped RLS and the legacy organization-key binding while the brownfield bridge is introduced.
2. In R1, add the minimum first-class organization/membership/role bridge required for Relationship Operations multi-advisor semantics, preserving legacy identifiers and provenance.
3. Put the R1 organization-owned Case/assignment/approval surfaces that require multi-seat access behind organization-aware authorization, with explicit cross-tenant denial tests.
4. Expand broader organization-owned assets, workflow definitions, skills and Brain rows behind organization-aware authorization as product increments require them.
5. Add teams only with concrete collaboration/authorization requirements; do not make full team administration a prerequisite for the minimum R1 slice.
6. Add platform/industry semantic catalogs and unified retrieval when the relevant Brain/knowledge increment is pulled by product need.
7. Backfill ownership and verify cross-tenant denial before broadening multi-seat access beyond the controlled R1 scope.

## 9. Non-goals

- A public knowledge marketplace.
- Grants that cross tenant boundaries for tenant-owned knowledge.
- Treating `scope: shared` in a skill as public access.
- Treating `org_name` as identity.
- Making a graph visualization the primary authorization or navigation model.

## Related documents

- [`architecture-manual.md`](architecture-manual.md)
- [`../business-brain-evolution-roadmap.md`](../business-brain-evolution-roadmap.md)
- [`../brain/gbrain-evaluation-and-plan.md`](../brain/gbrain-evaluation-and-plan.md)
- [`../brain/business-and-platform-brain-boundary.md`](../brain/business-and-platform-brain-boundary.md)
- [`gu-os-flexible-workflows-technical-plan.md`](gu-os-flexible-workflows-technical-plan.md)
- [`../adr/ADR-101-organization-tenancy.md`](../adr/ADR-101-organization-tenancy.md)
- [`../adr/ADR-102-knowledge-ownership-scopes.md`](../adr/ADR-102-knowledge-ownership-scopes.md)
- [`../adr/ADR-105-shareable-regenerable-views.md`](../adr/ADR-105-shareable-regenerable-views.md)
