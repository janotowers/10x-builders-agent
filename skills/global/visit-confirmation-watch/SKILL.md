---
name: visit-confirmation-watch
description: Detect property visits or appointment requests that need confirmation, missing details, reminders, or human coordination. Use in Heartbeat/proactive checks when the checklist mentions visits, appointments, tours, calendar conflicts, or confirmation windows.
scope: business
allowed_tools:
  - get_user_preferences
  - calendar_list_events
  - read_skill_reference
  - bigquery_run_query
includes:
  - business-data-core
requires_tenant_context: true
memory_extraction: ephemeral
heartbeat: native
guardrails: |
  Read-only. Do not create/update calendar events or send reminders automatically.
  Never invent availability, attendee names, property availability, or commitments.
  Escalate to human approval when confirmation or rescheduling is needed.
  If no visit crosses the threshold, return only a compact OK/no-action response.
---

# Visit Confirmation Watch

Use this playbook to detect visits/citas that may need coordination.

## Workflow

1. Check the requested time window from the checklist, usually the next 24-48 hours.
2. Use `calendar_list_events` for known calendar commitments when available.
3. If warehouse context is needed, load relevant references and query tenant-scoped appointments or visit requests.
4. Look for:
   - visit requested but not confirmed;
   - missing time, location, attendee, or responsible agent;
   - calendar conflict;
   - reminder window approaching.
5. Recommend only the next coordination step. Do not perform it automatically.

## Output

- **Visita/cita**
- **Problema detectado**
- **Dato faltante o conflicto**
- **Acción recomendada**
- **Aprobación requerida:** yes/no

If nothing needs confirmation, output only:

```md
### Pulso OK
Todo en orden. Sin acción requerida.
```
