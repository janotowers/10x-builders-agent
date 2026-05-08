---
name: lead-momentum-watch
description: Detect real estate leads that are losing momentum or need timely follow-up. Use in Heartbeat/proactive checks when the checklist mentions inactive leads, hot leads, response SLAs, reactivation, or follow-up opportunities. Draft or recommend next steps only; do not send messages automatically.
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
  Read-only. Query only tenant-scoped warehouse data.
  Do not send outreach. If follow-up is warranted, recommend approval or draft via lead-follow-up-draft.
  Do not classify stale data as urgent without recent conversation evidence.
  If no lead crosses the threshold, return only a compact OK/no-action response.
---

# Lead Momentum Watch

Use this playbook to detect leads that may lose momentum.

## Workflow

1. Read the checklist threshold before querying. Typical threshold: high-intent lead with no response beyond SLA, recent property interest, or pending next step.
2. Load `read_skill_reference("fewshots-leads")` or `read_skill_reference("fewshots-messages")` before non-trivial SQL.
3. Query only the smallest tenant-scoped set needed:
   - recent leads with last interaction timestamp;
   - last inbound/outbound message when available;
   - property or visit context if needed.
4. Prefer a short candidate list over broad metrics.
5. Classify each candidate:
   - `requires_attention`: clear next step or SLA breach;
   - `watch`: not urgent yet;
   - `ignore`: no actionable signal.

## Output

If action is needed:

- **Lead / señal**
- **Por qué importa**
- **Siguiente paso recomendado**
- **Requiere aprobación:** yes/no

If no candidates cross the threshold, output only:

```md
### Pulso OK
Todo en orden. Sin acción requerida.
```
