---
name: business-data-core
description: Shared Ungga warehouse reference layer for business-data skills. Include this from skills that need to query BigQuery operational data; it provides schema, joins, conventions, glossary, and few-shot SQL references. Do not select directly for end-user requests.
scope: business
allowed_tools:
  - read_skill_reference
  - bigquery_run_query
includes: []
requires_tenant_context: true
guardrails: |
  Shared read-only warehouse guidance. Do not answer users directly from this skill alone.
  Always apply tenant context unless the system prompt explicitly says MODO ADMIN UNGGA.
  Always use parameterized values for tenant ids, dates, names, phones, emails, and any user-provided value.
---

# Business Data Core

Shared reference layer for skills that query Ungga's BigQuery warehouse.

This skill is intended to be included by domain skills such as `company-data`,
`lead-follow-up-draft`, and future meeting/prep/reporting skills. It keeps
schema, joins, conventions, and canonical SQL patterns in one place so those
skills do not duplicate warehouse knowledge.

## How To Use

1. Read the active skill's task-specific instructions first.
2. Load only the references needed for the current query with
   `read_skill_reference("<name>")`.
3. Prefer `schema`, `joins`, and `conventions` before writing any non-trivial
   multi-table SQL.
4. Use the few-shot reference matching the dominant domain when you need a
   query pattern.

## Reference Index

| Reference | Use when |
|---|---|
| `schema` | Exact table/column names and data caveats for the `_light` views. |
| `joins` | Multi-table joins, especially messages to leads and tenant scoping. |
| `conventions` | Timezone, date bucketing, canonical filters, status normalization, org-name lookup. |
| `glossary` | Canonical business definitions and vocabulary. |
| `fewshots-users` | User/account/Gu activation patterns. |
| `fewshots-properties` | Inventory and property performance patterns. |
| `fewshots-leads` | Lead counts, attended/interacted definitions, funnel patterns. |
| `fewshots-messages` | Conversation/message patterns, including lead phone lookup. |
| `fewshots-appointments` | Appointment/cita patterns and status normalization. |
| `fewshots-deals` | Deal/opportunity patterns and lead/property joins. |

## Non-Negotiables

- Query only `_light` views; never query `_raw_light`.
- Fully qualify tables as `` `ungga-full.<dataset>.<table>` ``.
- Use named params such as `@organization_id`, `@lead_phone`, `@start_date`.
- For tenant mode, anchor queries through `users_light.organization_id`.
- For messages to leads, use the country-agnostic pattern from `joins`; never
  hard-code phone length.
