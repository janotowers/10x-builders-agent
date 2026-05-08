---
name: inventory-matchmaking-watch
description: Detect actionable property-to-lead matchmaking opportunities in real estate operations. Use in Heartbeat/proactive checks when the checklist mentions matching inventory, property options, buyer criteria, substitute properties, or high-value opportunities.
scope: business
allowed_tools:
  - get_user_preferences
  - read_skill_reference
  - bigquery_run_query
includes:
  - business-data-core
requires_tenant_context: true
memory_extraction: ephemeral
heartbeat: native
guardrails: |
  Read-only. Do not promise availability, price, discount, financing, or exclusivity.
  Surface only clear opportunities backed by tenant-scoped data.
  Recommend a human-reviewed next step; do not send messages automatically.
  If no opportunity crosses the threshold, return only a compact OK/no-action response.
---

# Inventory Matchmaking Watch

Use this playbook to detect when available inventory may match active buyer intent.

## Workflow

1. Confirm the checklist asks for matchmaking or high-value opportunity detection.
2. Load property/lead references before writing SQL:
   - `read_skill_reference("fewshots-properties")`
   - `read_skill_reference("fewshots-leads")` when lead criteria are involved.
3. Query only tenant-scoped, published/relevant inventory and recent lead interest.
4. Treat a match as actionable only when:
   - buyer criteria and property attributes overlap clearly;
   - there is recent lead activity;
   - the next step can be reviewed by a human.
5. Avoid broad inventory dumps.

## Output

- **Oportunidad**
- **Evidencia de match**
- **Riesgo o dato faltante**
- **Siguiente paso recomendado**

If no strong match exists, output only:

```md
### Pulso OK
Todo en orden. Sin acción requerida.
```
