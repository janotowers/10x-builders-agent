# Knowledge scope and ownership in Gu OS

**Status:** target semantics. Current runtime remains mostly `user_id`-scoped; organization/team support requires the V3 organization model.

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

The existing operating system exposes:

- `org_id` / `organization_id`: stable external organization identity.
- `org_name`: mutable display name.
- `role_user='super-admin'`: principal organization account.
- `role_user='vendedor'`: affiliated sales user.

Target mapping:

```text
organizations.external_org_id <- external org_id
organizations.name            <- external org_name
membership.role=owner/admin   <- super-admin
membership.role=sales_agent   <- vendedor
```

`profiles.is_ungga_admin` is platform staff authority and must never be inferred from those external roles.

Leads remain organization-owned even when the external system currently relates them through the receiving `super-admin`. Gu OS should preserve `external_lead_id`, `external_org_id`, and current assignee, while the external intake system remains authoritative until a separate migration is approved.

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

1. Keep current user-scoped RLS and external `organization_id` binding.
2. Add `organizations` and memberships with external ID mapping.
3. Move organization-owned assets, workflow definitions, skills, and Brain rows behind org-aware authorization.
4. Add teams only with concrete collaboration requirements.
5. Add platform/industry semantic catalogs and unified retrieval.
6. Backfill ownership and verify cross-tenant denial before enabling multi-seat access.

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
- [`gu-os-flexible-workflows-technical-plan.md`](gu-os-flexible-workflows-technical-plan.md)
- [`../adr/ADR-101-organization-tenancy.md`](../adr/ADR-101-organization-tenancy.md)
- [`../adr/ADR-102-knowledge-ownership-scopes.md`](../adr/ADR-102-knowledge-ownership-scopes.md)
- [`../adr/ADR-105-shareable-regenerable-views.md`](../adr/ADR-105-shareable-regenerable-views.md)
