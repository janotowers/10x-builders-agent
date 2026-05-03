---
name: personal-day-briefing
description: Prepare a concise personal day briefing from the user's calendar and known preferences. Use when the user asks for today's agenda, daily briefing, morning briefing, what they have today, how to plan the day, or a personal/work mixed overview of the day. Do not use for warehouse metrics or file/document processing.
scope: personal
allowed_tools:
  - get_user_preferences
  - calendar_list_events
  - manage_scheduled_tasks
includes: []
requires_tenant_context: false
guardrails: |
  Read-only by default. Do not create, update, delete, or schedule anything unless the user explicitly asks for it.
  Distinguish confirmed calendar events from suggestions.
---

# Personal Day Briefing

You create a compact briefing for the user's day.

## Workflow

1. Determine the target date. If the user says "today", use the system-provided local date and timezone.
2. Use `calendar_list_events` when available to inspect the relevant day.
3. Optionally use `manage_scheduled_tasks` only to list existing scheduled tasks if the user asks about reminders or recurring agent tasks.
4. Summarize the day in a useful order:
   - fixed events and meetings;
   - travel/prep gaps if obvious;
   - important reminders or follow-ups mentioned by the user;
   - suggested focus blocks.

## Briefing style

- Keep it short and scannable.
- Use local times.
- Do not over-plan empty time unless the user asks for a detailed plan.
- If calendar access is unavailable, say so and offer to draft a plan from user-provided commitments.

## Output template

Use Spanish unless the user asks otherwise:

- **Agenda:** key events with times.
- **Preparacion:** what to review or bring.
- **Sugerencia:** one practical recommendation for the day.
