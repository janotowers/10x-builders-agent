---
name: daily-operating-brief
description: Produce a concise operating brief for the user's day from calendar and stable preferences. Use for explicit user requests or scheduled tasks such as daily/morning briefs. Do not use for frequent Heartbeat monitoring; use meeting-readiness-watch for exception-first meeting alerts.
scope: personal
allowed_tools:
  - get_user_preferences
  - calendar_list_events
  - list_user_memories
includes: []
requires_tenant_context: false
memory_extraction: ephemeral
heartbeat: blocked
guardrails: |
  Read-only. Never create calendar events, tasks, or messages.
  Treat memories as background preferences, not as blockers by themselves.
  If no item crosses its threshold, say "Sin acción requerida" succinctly.
---

# Daily Operating Brief

Use this playbook for explicit daily brief requests or scheduled brief tasks. Do not use it for frequent Heartbeat monitoring.

## Workflow

1. Inspect the checklist item threshold and expected sources.
2. Use `calendar_list_events` only for the relevant window, usually today and the next 24 hours.
3. Identify only actionable items:
   - agenda conflicts;
   - preparation gaps before a meeting;
   - commitments that need a decision before the next event;
   - concrete blockers that prevent progress.
4. Ignore generic profile facts, communication style preferences, or business context unless they change an action.
5. If nothing crosses the threshold, produce a compact "Sin acción requerida" note.

## Output

Use the user's language:

- **Agenda relevante:** only events that matter.
- **Preparación / huecos:** missing prep, travel, or decisions.
- **Bloqueos reales:** only concrete blockers.
- **Acción sugerida:** one practical next step when needed.
